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
import { readPdf } from './pdf.ts';
import { assemble } from './mapping.ts';
import { analyseTagging } from './tagging.ts';
import { validPassword, validUsername } from './auth.ts';
import type { UserAccount } from './store.ts';

const persistentCookie = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure,
  path: '/',
  // Browsers cap persistent cookies (Chrome currently caps them at 400 days).
  // Refreshing it on every authenticated request makes active sessions indefinite.
  maxAge: 400 * 24 * 3600,
});

type AuthenticatedRequest = {
  authUser?: UserAccount;
  authToken?: string;
};
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
  store.ensureBootstrapUser(options.username, options.password);
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
    let token = req.cookies.toyota_session ?? '';
    let user = store.userForSession(token);
    if (!user) {
      // One-time migration for a still-valid cookie issued by versions before persistent sessions.
      const [expiry, nonce, signature] = token.split('.');
      if (
        signature &&
        Number(expiry) >= Date.now() &&
        equal(signature, sign(`${expiry}.${nonce}`)) &&
        store.getUser(options.username)
      ) {
        token = store.createSession(options.username);
        user = store.getUser(options.username);
      }
    }
    if (!user) return reply.code(401).send({ error: 'Please sign in.' });
    (req as typeof req & AuthenticatedRequest).authUser = user;
    (req as typeof req & AuthenticatedRequest).authToken = token;
    reply.setCookie('toyota_session', token, persistentCookie(options.secureCookie));
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number };
    req.log.error({ err: e }, 'Request failed');
    reply.code(e.statusCode ?? 500).send({
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
      const user = store.authenticate(String(body?.username ?? '').trim(), String(body?.password ?? ''));
      if (!user) return reply.code(401).send({ error: 'Incorrect username or password.' });
      const token = store.createSession(user.username);
      reply.setCookie('toyota_session', token, persistentCookie(options.secureCookie));
      return { ok: true };
    },
  );
  const current = (req: AuthenticatedRequest) => {
    if (!req.authUser || !req.authToken)
      throw Object.assign(new Error('Please sign in.'), { statusCode: 401 });
    return { user: req.authUser, token: req.authToken };
  };
  const admin = (req: AuthenticatedRequest) => {
    const auth = current(req);
    if (!auth.user.isAdmin)
      throw Object.assign(new Error('Administrator access required.'), { statusCode: 403 });
    return auth;
  };
  app.get('/api/session', (req) => {
    const { user } = current(req as typeof req & AuthenticatedRequest);
    return {
      username: user.username,
      isAdmin: user.isAdmin,
      limits: {
        files: options.maxFiles,
        fileMb: options.maxFileBytes / 1024 ** 2,
        batchMb: options.maxBatchBytes / 1024 ** 2,
      },
    };
  });
  app.post('/api/logout', async (req, reply) => {
    store.deleteSession(current(req as typeof req & AuthenticatedRequest).token);
    reply.clearCookie('toyota_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/accounts', (req) => {
    admin(req as typeof req & AuthenticatedRequest);
    return { accounts: store.listUsers() };
  });
  app.post('/api/accounts', (req, reply) => {
    admin(req as typeof req & AuthenticatedRequest);
    const body = req.body as { username?: string; password?: string };
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    if (!validUsername(username))
      return reply
        .code(400)
        .send({ error: 'Username must be 3–32 letters, numbers, dots, dashes, or underscores.' });
    if (!validPassword(password))
      return reply.code(400).send({ error: 'Password must be 12–200 characters.' });
    if (store.getUser(username)) return reply.code(409).send({ error: 'That username already exists.' });
    reply.code(201);
    return store.createUser(username, password);
  });
  app.delete<{ Params: { username: string } }>('/api/accounts/:username', (req, reply) => {
    const { user } = admin(req as typeof req & AuthenticatedRequest);
    if (user.username.toLowerCase() === req.params.username.toLowerCase())
      return reply.code(400).send({ error: 'You cannot remove the account you are using.' });
    if (!store.deleteUser(req.params.username)) return reply.code(404).send({ error: 'Account not found.' });
    return { ok: true };
  });
  app.post('/api/account/password', (req, reply) => {
    const { user, token } = current(req as typeof req & AuthenticatedRequest);
    const body = req.body as { currentPassword?: string; newPassword?: string };
    if (!store.authenticate(user.username, String(body?.currentPassword ?? '')))
      return reply.code(401).send({ error: 'Current password is incorrect.' });
    const password = String(body?.newPassword ?? '');
    if (!validPassword(password))
      return reply.code(400).send({ error: 'New password must be 12–200 characters.' });
    store.updatePassword(user.username, password);
    store.deleteOtherSessions(user.username, token);
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
  app.post<{ Querystring: { job?: string } }>('/api/tagging/review', async (req, reply) => {
    const part = await req.file({ limits: { files: 1, fileSize: options.maxFileBytes } });
    if (!part || !/\.pdf$/i.test(part.filename))
      return reply.code(400).send({ error: 'Choose a tagging PDF.' });
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.subarray(0, 5).toString() !== '%PDF-')
      return reply.code(400).send({ error: 'Choose a valid PDF within the upload limit.' });
    try {
      const texts = await readPdf(bytes, 100);
      const orders = req.query.job ? assemble(getJob(req.query.job).pages).orders : [];
      return { pages: analyseTagging(texts, orders) };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Cannot read tagging PDF.' });
    }
  });
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
