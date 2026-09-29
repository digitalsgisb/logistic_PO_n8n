import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
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

test('accounts and persistent sessions survive an application restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-accounts-'));
  const options = {
    ...config,
    dataDir: dir,
    username: 'pilot',
    password: 'admin-password-123',
    sessionSecret: 's'.repeat(40),
    serviceSecret: 'k'.repeat(40),
  };
  const first = await buildApp(options);
  let adminCookie = '';
  try {
    const payload = `${Date.now() + 3600000}.legacy-session`;
    const signature = createHmac('sha256', options.sessionSecret).update(payload).digest('hex');
    const migrated = await first.app.inject({
      url: '/api/session',
      headers: { cookie: `toyota_session=${payload}.${signature}` },
    });
    assert.equal(migrated.statusCode, 200, migrated.body);
    assert.match(String(migrated.headers['set-cookie']), /Max-Age=34560000/);

    const login = await first.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'x-requested-with': 'ToyotaPO' },
      payload: { username: options.username, password: options.password },
    });
    adminCookie = String(login.headers['set-cookie']).split(';')[0];
    assert.match(String(login.headers['set-cookie']), /Max-Age=34560000/);
    const create = await first.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { cookie: adminCookie, 'x-requested-with': 'ToyotaPO' },
      payload: { username: 'operator.two', password: 'operator-password-123' },
    });
    assert.equal(create.statusCode, 201, create.body);
    assert.deepEqual(
      (await first.app.inject({ url: '/api/accounts', headers: { cookie: adminCookie } }))
        .json()
        .accounts.map((account: { username: string }) => account.username),
      ['operator.two', 'pilot'],
    );
  } finally {
    await first.app.close();
  }

  const second = await buildApp(options);
  try {
    const resumed = await second.app.inject({ url: '/api/session', headers: { cookie: adminCookie } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().username, 'pilot');
    assert.equal(resumed.json().isAdmin, true);

    const operatorLogin = await second.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'x-requested-with': 'ToyotaPO' },
      payload: { username: 'operator.two', password: 'operator-password-123' },
    });
    const operatorCookie = String(operatorLogin.headers['set-cookie']).split(';')[0];
    assert.equal(
      (await second.app.inject({ url: '/api/accounts', headers: { cookie: operatorCookie } })).statusCode,
      403,
    );
    const changed = await second.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: operatorCookie, 'x-requested-with': 'ToyotaPO' },
      payload: { currentPassword: 'operator-password-123', newPassword: 'replacement-password-123' },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(
      (
        await second.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { 'x-requested-with': 'ToyotaPO' },
          payload: { username: 'operator.two', password: 'operator-password-123' },
        })
      ).statusCode,
      401,
    );
    const removed = await second.app.inject({
      method: 'DELETE',
      url: '/api/accounts/operator.two',
      headers: { cookie: adminCookie, 'x-requested-with': 'ToyotaPO' },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(
      (await second.app.inject({ url: '/api/session', headers: { cookie: operatorCookie } })).statusCode,
      401,
    );
  } finally {
    await second.app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('upload needs no shift; dates remain hidden until completion and survive job expiry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-dates-api-'));
  const options = { ...config, dataDir: dir, username: 'pilot', password: 'test-password-123',
    sessionSecret: 's'.repeat(40), serviceSecret: 'k'.repeat(40) };
  const { app, engine, store } = await buildApp(options);
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { 'x-requested-with': 'ToyotaPO' },
      payload: { username: 'pilot', password: options.password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const headers = { cookie, 'x-requested-with': 'ToyotaPO' };
    const form = multipart([{ name: 'orders.pdf', bytes: pdfFor([textFor(orders[0])]) }]);
    const uploaded = await app.inject({ method: 'POST', url: '/api/jobs',
      headers: { ...headers, 'content-type': form.type }, payload: form.payload });
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    const id = uploaded.json().id;
    const job = store.get(id)!;
    job.pages = [ (await import('./helpers.ts')).pageFor(orders[0]) ];
    job.state = 'processing';
    store.save(job);
    await engine.finish(job);
    const dates = (await app.inject({ url: '/api/dispatch-dates', headers })).json().dates;
    assert.equal(dates.length, 1);
    assert.equal(dates[0].date, '2026-09-03');
    assert.equal(dates[0].status, 'open');
    assert.equal((await app.inject({ url: '/api/dispatch-dates/2026-09-03/workbook', headers })).statusCode, 404);
    const done = await app.inject({ method: 'POST', url: '/api/dispatch-dates/2026-09-03/complete', headers });
    assert.equal(done.statusCode, 200, done.body);
    const download = await app.inject({ url: '/api/dispatch-dates/2026-09-03/workbook', headers });
    assert.equal(download.statusCode, 200);
    assert.equal(download.rawPayload.subarray(0,2).toString(), 'PK');
    const old = store.get(id)!;
    old.created_at = '2020-01-01T00:00:00Z';
    store.save(old);
    await engine.tick();
    assert.equal(store.get(id), undefined);
    assert.equal((await app.inject({ url: '/api/dispatch-dates/2026-09-03/workbook', headers })).statusCode, 200);
    const reopened = await app.inject({ method: 'POST', url: '/api/dispatch-dates/2026-09-03/reopen', headers });
    assert.equal(reopened.json().status, 'open');
    assert.equal((await app.inject({ url: '/api/dispatch-dates/2026-09-03/workbook', headers })).statusCode, 404);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('retry adds recovered PO to its existing date without double counting', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-retry-'));
  const options = { ...config, dataDir: dir };
  let instance = await buildApp(options);
  try {
    const { pageFor } = await import('./helpers.ts');
    instance.store.save({ id: 'test-job', state: 'processing', stage: 'test', attempt: 'first',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), files: [],
      pages: [pageFor(orders[0], 'a'), { ...pageFor(orders[3], 'b'), file_id: 'other',
        state: 'error', extraction: undefined, error: 'AI unavailable' }], results: [] });
    await instance.engine.finish(instance.store.get('test-job')!);
    assert.equal(instance.store.get('test-job')!.state, 'partial');
    assert.equal(instance.store.getDate('2026-09-03')!.orders.length, 1);
    await instance.app.close();
    instance = await buildApp(options);
    const job = instance.engine.retry('test-job');
    assert.equal(job.pages[1].state, 'pending');
    job.state = 'processing';
    instance.store.save(job);
    job.pages[1] = pageFor(orders[3], 'b');
    instance.store.save(job);
    await instance.engine.finish(job);
    assert.equal(instance.store.getDate('2026-09-03')!.orders.length, 2);
    await instance.engine.finish(job);
    assert.equal(instance.store.getDate('2026-09-03')!.orders.length, 2);
  } finally {
    await instance.app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
