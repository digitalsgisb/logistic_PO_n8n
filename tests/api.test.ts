import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import ExcelJS from 'exceljs';
import { buildApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { orders, pdfFor, textFor } from './helpers.ts';

function multipart(files: { name: string; bytes: Buffer }[]) {
  const boundary = 'toyota-test-boundary';
  const parts = files.flatMap((f) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    f.bytes,
    Buffer.from('\r\n'),
  ]);
  return {
    payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}
test('authenticated upload → n8n callbacks → one combined download; duplicates, ZIP, persistence, stale callback protection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-api-'));
  const receiver = http.createServer((_req, res) => {
    res.end('ok');
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const addr = receiver.address() as { port: number };
  const options = {
    ...config,
    dataDir: dir,
    username: 'pilot',
    password: 'test-password-123',
    sessionSecret: 's'.repeat(40),
    serviceSecret: 'k'.repeat(40),
    n8nWebhook: `http://127.0.0.1:${addr.port}`,
    maxFileBytes: 1000000,
    maxBatchBytes: 2000000,
  };
  const { app, engine, store } = await buildApp(options);
  try {
    assert.equal((await app.inject({ url: '/api/session' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username: 'pilot', password: options.password },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'x-requested-with': 'ToyotaPO' },
      payload: { username: 'pilot', password: options.password },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const headers = { cookie, 'x-requested-with': 'ToyotaPO' };
    const bytes = pdfFor(orders.map(textFor)),
      form = multipart([
        { name: 'orders.pdf', bytes },
        { name: 'duplicate.pdf', bytes },
      ]);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { ...headers, 'content-type': form.type },
      payload: form.payload,
    });
    assert.equal(upload.statusCode, 202, upload.body);
    const id = upload.json().id;
    assert.equal(upload.json().files[1].duplicate, true);
    assert.ok(!upload.body.includes(dir));
    await engine.tick();
    const attempt = store.get(id)!.attempt;
    const internal = { 'x-service-secret': options.serviceSecret };
    assert.equal(
      (await app.inject({ method: 'POST', url: `/internal/jobs/${id}/next`, payload: { attempt } }))
        .statusCode,
      401,
    );
    for (let i = 0; i < 4; i++) {
      const next = await app.inject({
        method: 'POST',
        url: `/internal/jobs/${id}/next`,
        headers: internal,
        payload: { attempt },
      });
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(next.json().done, false);
      const body = { attempt, page_id: next.json().page_id, extraction: orders[i] };
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/internal/jobs/${id}/result`,
            headers: internal,
            payload: body,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/internal/jobs/${id}/result`,
            headers: internal,
            payload: body,
          })
        ).statusCode,
        200,
      );
    }
    const done = await app.inject({
      method: 'POST',
      url: `/internal/jobs/${id}/next`,
      headers: internal,
      payload: { attempt },
    });
    assert.equal(done.json().done, true, done.body);
    const status = await app.inject({ url: `/api/jobs/${id}`, headers });
    assert.equal(status.json().state, 'completed', status.body);
    assert.equal(status.json().results.length, 1);
    assert.equal(status.json().results[0].order_count, 4);
    assert.deepEqual(status.json().results[0].order_numbers, [
      'SGIS12AA0747-SA',
      'SGIS12DA3251-SA',
      'SGIS12DA3252-SA',
      'SGIS13FA5002-BR',
    ]);
    const file = await app.inject({ url: `/api/jobs/${id}/outputs/${status.json().results[0].id}`, headers });
    assert.equal(file.statusCode, 200);
    assert.equal(file.rawPayload.subarray(0, 2).toString(), 'PK');
    const downloaded = new ExcelJS.Workbook();
    await downloaded.xlsx.load(file.rawPayload as unknown as ExcelJS.Buffer);
    assert.equal(downloaded.worksheets.length, 1);
    assert.equal(downloaded.worksheets[0].getCell('V13').value, 1200);
    assert.equal(downloaded.worksheets[0].getCell('AE17').value, 'SGIS13FA5002-BR');
    assert.equal(downloaded.worksheets[0].getCell('H16').value, 30);
    assert.equal(downloaded.worksheets[0].getCell('H19').value, null);
    const zip = await app.inject({ url: `/api/jobs/${id}/download-all`, headers });
    assert.equal(zip.statusCode, 200);
    assert.ok(zip.rawPayload.includes(Buffer.from('Toyota_2026-09-03_Combined.xlsx')));
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/internal/jobs/${id}/next`,
          headers: internal,
          payload: { attempt },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: `/api/jobs/${id}/retry`, headers })).statusCode,
      409,
    );
    const bad = multipart([{ name: 'bad.pdf', bytes: Buffer.from('not pdf') }]);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: { ...headers, 'content-type': bad.type },
          payload: bad.payload,
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
    await new Promise<void>((r) => receiver.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('partial results survive restart and retry rebuilds one workbook without duplicating successful quantities', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-retry-'));
  const options = { ...config, dataDir: dir };
  let instance = await buildApp(options);
  try {
    const id = 'test-job';
    await fs.mkdir(path.join(dir, id));
    const { pageFor } = await import('./helpers.ts');
    instance.store.save({
      id,
      state: 'processing',
      stage: 'test',
      attempt: 'first',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      files: [],
      pages: [
        pageFor(orders[0], 'a'),
        {
          ...pageFor(orders[3], 'b'),
          file_id: 'different-file-with-same-name',
          number: 1,
          state: 'error',
          extraction: undefined,
          error: 'AI unavailable',
        },
      ],
      results: [],
    });
    await instance.engine.finish(instance.store.get(id)!);
    assert.equal(instance.store.get(id)!.state, 'partial');
    const readyPath = instance.store.get(id)!.results.find((r) => r.status === 'ready')!.path!;
    await instance.app.close();
    instance = await buildApp(options);
    assert.equal(instance.store.get(id)!.results.filter((r) => r.status === 'ready').length, 1);
    const job = instance.engine.retry(id);
    assert.equal(job.pages[0].state, 'extracted');
    assert.equal(job.pages[1].state, 'pending');
    assert.notEqual(job.attempt, 'first');
    job.state = 'processing';
    instance.store.save(job);
    const claimed = await instance.engine.claim(id, job.attempt);
    assert.equal('page_id' in claimed ? claimed.page_id : undefined, 'b');
    instance.engine.result(id, job.attempt, 'b', orders[3]);
    await instance.engine.claim(id, job.attempt);
    assert.equal(instance.store.get(id)!.state, 'completed');
    assert.equal(instance.store.get(id)!.results.length, 1);
    assert.equal(instance.store.get(id)!.results[0].order_count, 2);
    assert.equal(instance.store.get(id)!.results[0].path, readyPath);
    const combined = new ExcelJS.Workbook();
    await combined.xlsx.readFile(readyPath);
    assert.equal(combined.worksheets[0].getCell('V13').value, 1200);
    assert.equal(combined.worksheets[0].getCell('H16').value, 30);
    assert.equal(combined.worksheets[0].getCell('AE16').value, 'SGIS13FA5002-BR');
    assert.equal(combined.worksheets[0].getCell('H19').value, null);
    const interrupted = instance.store.get(id)!;
    interrupted.state = 'processing';
    instance.store.save(interrupted);
    instance.engine.recover();
    assert.equal(instance.store.get(id)!.state, 'interrupted');
  } finally {
    await instance.app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
