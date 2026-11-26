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
import { Engine, jobResults, publicJob } from './engine.ts';
import { peroduaReview, savedPeroduaExport, resolvePeroduaDate } from './perodua-history.ts';
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
  // Bring retained uploads from the previous shift-based release into the new
  // date board once. Their old job downloads remain available while retained.
  if (store.getMeta('date-ledger-import-v1') !== 'done') {
    if (!store.allDates().length) {
      for (const job of store.all().filter((entry) => ['completed', 'partial'].includes(entry.state))) {
        const orders = assemble(job.pages.filter(page => !page.history_deleted)).orders;
        if (orders.length) {
          try {
            await engine.ledger.ingest(orders);
          } catch (error) {
            app.log.error({ err: error, job: job.id }, 'Could not migrate retained PO upload');
          }
        }
      }
    }
    store.setMeta('date-ledger-import-v1', 'done');
  }
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
  const settingsFile = options.peroduaSettingsPath;
  app.get('/api/perodua', () => peroduaReview(options.dataDir, settingsFile));
  app.post('/api/perodua/generate', (req, reply) => {
    const body = req.body as { job_id?: unknown; document_keys?: unknown; serials?: unknown; save_date?: unknown; save_id?: unknown } | undefined;
    const saveId = typeof body?.save_id === 'string' ? body.save_id : undefined;
    if (saveId && !/^[A-Za-z0-9_-]{1,120}$/.test(saveId)) return reply.code(400).send({ error: 'Invalid saved batch.' });
    const saveDate = typeof body?.save_date === 'string' ? body.save_date : undefined;
    if (saveDate && !/^\d{4}-\d{2}-\d{2}$/.test(saveDate)) return reply.code(400).send({ error: 'Invalid saved date.' });
    const values = body?.serials ?? ['', '', ''];
    if (!Array.isArray(values) || values.length !== 3 ||
        values.some((value, index) => typeof value !== 'string' ||
          (value.trim() !== '' && (!(index === 2 ? /^(?:PG)?[0-9]+$/i : /^[0-9]+$/).test(value.trim()) ||
          Number(value.trim().replace(/^PG/i, '')) < 1))))
      return reply.code(400).send({ error: 'SUGI No, GC No and Serial No. may be blank. Filled values must be positive numbers; Serial No. may start with PG.' });
    const serials = values.map(value => String(value).trim().toUpperCase());
    if (typeof body?.job_id === 'string') return engine.generateSavedPerodua({ jobId: body.job_id, serials, saveDate, saveId });
    if (Array.isArray(body?.document_keys) && body.document_keys.length &&
        body.document_keys.every(key => typeof key === 'string'))
      return engine.generateSavedPerodua({ keys: body.document_keys, serials, saveDate, saveId });
    return reply.code(400).send({ error: 'Choose the current Perodua batch or selected documents to export.' });
  });
  app.get('/api/perodua/status', async () => {
    const latest = await savedPeroduaExport(options.dataDir);
    const file = path.join(options.dataDir, 'perodua', 'Combined_Delivery.xlsx');
    return { excel: !!latest || await fs.access(file).then(() => true, () => false) };
  });
  app.post<{ Params: { date: string } }>('/api/perodua/dates/:date/complete', req => engine.setPeroduaDate(req.params.date, true));
  app.post<{ Params: { date: string } }>('/api/perodua/dates/:date/reopen', req => engine.setPeroduaDate(req.params.date, false));
  app.delete<{ Params: { date: string } }>('/api/perodua/dates/:date', req => { admin(req as typeof req & AuthenticatedRequest); return engine.deleteSavedDate('PERODUA', req.params.date); });
  app.get<{ Params: { date: string } }>('/api/perodua/dates/:date/workbook', async (req, reply) => {
    const review = await peroduaReview(options.dataDir, settingsFile);
    const date = resolvePeroduaDate(review.dates, req.params.date);
    if (!date || date.status !== 'complete' || !date.export_id)
      return reply.code(409).send({ error: 'Mark this Perodua date complete before downloading its Excel.' });
    const output = await savedPeroduaExport(options.dataDir, date.export_id);
    if (!output) return reply.code(404).send({ error: 'Saved workbook not found.' });
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${output.filename}"`).send(await fs.readFile(output.path));
  });
  app.get<{ Params: { exportId: string } }>('/api/perodua/exports/:exportId', async (req, reply) => {
    const entry = await savedPeroduaExport(options.dataDir, req.params.exportId);
    if (!entry) return reply.code(404).send({ error: 'Saved Perodua export not found.' });
    if (entry.save_date && !entry.completed_at) return reply.code(409).send({ error: 'Mark the saved date complete first.' });
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${entry.filename}"`).send(await fs.readFile(entry.path));
  });
  app.get('/api/perodua/workbook', async (_req, reply) => {
    const latest = await savedPeroduaExport(options.dataDir);
    if (latest?.save_date && !latest.completed_at) return reply.code(409).send({ error: 'Mark the saved date complete first.' });
    const file = path.join(options.dataDir, 'perodua', 'Combined_Delivery.xlsx');
    try {
      const bytes = await fs.readFile(latest?.path ?? file);
      return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${latest?.filename ?? 'Combined_Delivery.xlsx'}"`).send(bytes);
    } catch { return reply.code(404).send({ error: 'No Perodua Excel has been generated yet.' }); }
  });
  app.post<{ Querystring: { perodua_date?: string; perodua_entry_id?: string } }>('/api/jobs', async (req, reply) => {
    const targetKey = req.query.perodua_entry_id ?? req.query.perodua_date;
    let targetDate: string | undefined, targetId: string | undefined;
    if (targetKey) {
      const dates = (await peroduaReview(options.dataDir, settingsFile)).dates;
      const selected = resolvePeroduaDate(dates, targetKey);
      if (!selected || selected.status !== 'open')
        return reply.code(409).send({ error: 'Reopen the Perodua date before adding POs to it.' });
      targetDate = selected.date; targetId = selected.id;
    }

    if (engine.clearing) return reply.code(503).send({ error: 'History is being cleared. Try again shortly.' });
    const id = randomUUID(),
      dir = path.join(options.dataDir, id);
    await fs.mkdir(dir, { recursive: true });
    const job: Job = {
      perodua_date: targetDate, perodua_entry_id: targetId,
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
      return publicJob(job, options.dataDir);
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
  app.get('/api/dispatch-dates', () => ({
    dates: store.allDates().map((entry) => engine.ledger.publicEntry(entry)),
  }));
  app.post<{ Params: { date: string } }>('/api/dispatch-dates/:date/complete', async (req) =>
    engine.ledger.publicEntry(await engine.ledger.setComplete(req.params.date, true)),
  );
  app.post<{ Params: { date: string } }>('/api/dispatch-dates/:date/reopen', async (req) =>
    engine.ledger.publicEntry(await engine.ledger.setComplete(req.params.date, false)),
  );
  app.delete<{ Params: { date: string } }>('/api/dispatch-dates/:date', req => { admin(req as typeof req & AuthenticatedRequest); return engine.deleteSavedDate('TOYOTA', req.params.date); });
  app.delete('/api/history', async (req) => {
    admin(req as typeof req & AuthenticatedRequest);
    return { ok: true, ...(await engine.clearHistory()) };
  });
  app.get<{ Params: { date: string } }>('/api/dispatch-dates/:date/workbook', async (req, reply) => {
    const output = await engine.ledger.download(req.params.date);
    reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${output.filename}"`)
      .header('Cache-Control', 'no-store');
    return reply.send(output.buffer);
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id/saved-dates', async (req) => {
    const job = getJob(req.params.id);
    const pageIds = new Set(job.pages.filter(page => !page.history_deleted).map(page => page.id));
    const toyota = store.allDates().filter(entry => entry.job_id === job.id ||
      entry.orders.some(order => order.source_page_ids.some(id => pageIds.has(id))))
      .map(entry => ({ ...engine.ledger.publicEntry(entry), company: 'TOYOTA' as const }));
    const files = job.files.filter(file => !file.history_deleted && file.perodua?.status === 'ready');
    const review = await peroduaReview(options.dataDir, settingsFile);
    const perodua = review.dates.filter(entry => files.some(file => {
      const metadata = file.perodua!;
      if (metadata.entry_id) return metadata.entry_id === entry.id;
      if (metadata.export_id) return metadata.export_id === entry.export_id || entry.versions.some(version => version.id === metadata.export_id);
      return entry.id === entry.date && (metadata.save_date ?? metadata.generated_date) === entry.date;
    }));
    return { dates: [...toyota, ...perodua] };
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', (req) => publicJob(getJob(req.params.id), options.dataDir));
  app.post<{ Querystring: { job?: string } }>('/api/tagging/review', async (req, reply) => {
    const part = await req.file({ limits: { files: 1, fileSize: options.maxFileBytes } });
    if (!part || !/\.pdf$/i.test(part.filename))
      return reply.code(400).send({ error: 'Choose a tagging PDF.' });
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.subarray(0, 5).toString() !== '%PDF-')
      return reply.code(400).send({ error: 'Choose a valid PDF within the upload limit.' });
    try {
      const texts = await readPdf(bytes, 100);
      const orders = req.query.job ? assemble(getJob(req.query.job).pages.filter(page => !page.history_deleted)).orders : [];
      return { pages: analyseTagging(texts, orders) };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Cannot read tagging PDF.' });
    }
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', (req) =>
    publicJob(engine.retry(req.params.id), options.dataDir),
  );
  app.get<{ Params: { id: string; outputId: string } }>(
    '/api/jobs/:id/outputs/:outputId',
    async (req, reply) => {
      const r = jobResults(getJob(req.params.id), options.dataDir).find(
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
      results = jobResults(job, options.dataDir).filter((r) => r.status === 'ready');
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
