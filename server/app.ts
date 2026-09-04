import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { config } from './config.ts';
import { Store } from './store.ts';
import { Engine, publicJob } from './engine.ts';
import type { Job } from './types.ts';
const equal = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export async function buildApp(options = config) {
  const app = Fastify({
    logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-service-secret'] },
    bodyLimit: 1024 * 1024,
  });
  const store = new Store(options.dataDir),
    engine = new Engine(store, options);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { files: options.maxFiles, fileSize: options.maxFileBytes, fields: 0, parts: options.maxFiles },
  });
  const sign = (value: string) => createHmac('sha256', options.sessionSecret).update(value).digest('hex');
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    if (req.url === '/health') return;
    if (req.url.startsWith('/internal/')) {
      if (
        !equal(String(req.headers['x-service-secret'] ?? ''), options.serviceSecret) ||
        !options.serviceSecret
      )
        return reply.code(401).send({ error: 'Internal authentication required.' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'ToyotaPO')
      return reply.code(403).send({ error: 'Request origin check failed.' });
    if (req.url === '/api/login') return;
    const token = req.cookies.toyota_session ?? '',
      [expiry, nonce, signature] = token.split('.');
    if (!signature || Number(expiry) < Date.now() || !equal(signature, sign(`${expiry}.${nonce}`)))
      return reply.code(401).send({ error: 'Please sign in.' });
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number };
    req.log.error({ err: e }, 'Request failed');
    reply
      .code(e.statusCode ?? 500)
      .send({
        error:
          e.statusCode && e.statusCode < 500
            ? e.message
            : 'Processing failed. Please retry or check the server logs.',
      });
  });
  app.get('/health', () => ({ ok: true }));
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body as { username?: string; password?: string };
      if (
        !equal(String(body?.username ?? ''), options.username) ||
        !equal(String(body?.password ?? ''), options.password)
      )
        return reply.code(401).send({ error: 'Incorrect username or password.' });
      const payload = `${Date.now() + 12 * 3600000}.${randomUUID()}`;
      reply.setCookie('toyota_session', `${payload}.${sign(payload)}`, {
        httpOnly: true,
        sameSite: 'strict',
        secure: options.secureCookie,
        path: '/',
        maxAge: 12 * 3600,
      });
      return { ok: true };
    },
  );
  app.get('/api/session', () => ({
    username: options.username,
    limits: {
      files: options.maxFiles,
      fileMb: options.maxFileBytes / 1024 ** 2,
      batchMb: options.maxBatchBytes / 1024 ** 2,
    },
  }));
  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie('toyota_session', { path: '/' });
    return { ok: true };
  });
  app.post('/api/jobs', async (req, reply) => {
    const id = randomUUID(),
      dir = path.join(options.dataDir, id);
    await fs.mkdir(dir, { recursive: true });
    const job: Job = {
      id,
      state: 'queued',
      stage: 'Queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      attempt: randomUUID(),
      files: [],
      pages: [],
      results: [],
    };
    let total = 0;
    const hashes = new Set<string>();
    try {
      for await (const part of req.files()) {
        if (!/\.pdf$/i.test(part.filename))
          throw Object.assign(new Error('Only PDF files are supported.'), { statusCode: 400 });
        const fileId = randomUUID(),
          dest = path.join(dir, fileId + '.pdf'),
          digest = createHash('sha256');
        let size = 0,
          head = Buffer.alloc(0);
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            total += chunk.length;
            digest.update(chunk);
            if (head.length < 5) head = Buffer.concat([head, chunk]).subarray(0, 5);
            if (total > options.maxBatchBytes)
              callback(Object.assign(new Error('Batch exceeds the upload size limit.'), { statusCode: 413 }));
            else callback(null, chunk);
          },
        });
        await pipeline(part.file, counter, createWriteStream(dest, { flags: 'wx' }));
        if (part.file.truncated)
          throw Object.assign(new Error('A file exceeds the upload size limit.'), { statusCode: 413 });
        if (head.toString() !== '%PDF-')
          throw Object.assign(new Error('A selected file is not a valid PDF.'), { statusCode: 400 });
        const hash = digest.digest('hex'),
          duplicate = hashes.has(hash);
        hashes.add(hash);
        job.files.push({
          id: fileId,
          filename: path
            .basename(part.filename.replaceAll('\\', '/'))
            .replace(/[\x00-\x1f]/g, '')
            .slice(0, 200),
          size,
          hash,
          path: dest,
          duplicate,
        });
      }
      if (!job.files.length) throw Object.assign(new Error('Select at least one PDF.'), { statusCode: 400 });
      store.save(job);
      reply.code(202);
      return publicJob(job);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
  });
  const getJob = (id: string) => {
    const job = store.get(id);
    if (!job) throw Object.assign(new Error('Job not found or expired.'), { statusCode: 404 });
    return job;
  };
  app.get<{ Params: { id: string } }>('/api/jobs/:id', (req) => publicJob(getJob(req.params.id)));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', (req) =>
    publicJob(engine.retry(req.params.id)),
  );
  app.get<{ Params: { id: string; outputId: string } }>(
    '/api/jobs/:id/outputs/:outputId',
    async (req, reply) => {
      const r = getJob(req.params.id).results.find(
        (r) => r.id === req.params.outputId && r.status === 'ready',
      );
      if (!r?.path) return reply.code(404).send({ error: 'Output not found.' });
      reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${r.filename}"`);
      return reply.send(createReadStream(r.path));
    },
  );
  app.get<{ Params: { id: string } }>('/api/jobs/:id/download-all', async (req, reply) => {
    const job = getJob(req.params.id),
      results = job.results.filter((r) => r.status === 'ready');
    if (!results.length) return reply.code(404).send({ error: 'No completed templates yet.' });
    const zip = new ZipArchive({ zlib: { level: 6 } });
    reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="Toyota_${job.id}.zip"`);
    zip.on('error', (error) => {
      req.log.error(error);
      reply.raw.destroy(error);
    });
    for (const r of results) zip.file(r.path!, { name: r.filename! });
    void zip.finalize();
    return reply.send(zip);
  });
  app.post<{ Params: { id: string }; Body: { attempt: string } }>('/internal/jobs/:id/next', (req) =>
    engine.claim(req.params.id, req.body.attempt),
  );
  app.post<{
    Params: { id: string };
    Body: { attempt: string; page_id: string; extraction: unknown; error?: string };
  }>('/internal/jobs/:id/result', (req) =>
    engine.result(req.params.id, req.body.attempt, req.body.page_id, req.body.extraction, req.body.error),
  );
  app.addHook('onClose', async () => store.close());
  return { app, engine, store };
}
