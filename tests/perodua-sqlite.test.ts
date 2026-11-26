import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { buildApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { assemble } from '../server/mapping.ts';
import { readPeroduaLedger, writePeroduaLedger } from '../server/perodua-storage.ts';
import { orders, pageFor, pdfFor, textFor } from './helpers.ts';

const origin = { 'x-requested-with': 'ToyotaPO' };
const optionsFor = (dataDir: string) => ({ ...config, dataDir, username: 'pilot', password: 'test-password-123',
  sessionSecret: 's'.repeat(40), serviceSecret: 'k'.repeat(40), n8nWebhook: 'http://n8n.test/webhook/toyota-po' });
const sample = (pido: string, trip = 1) => ['PERODUA', 'PDIO Number', pido, 'Delivery Trip', String(trip),
  'Delivery Date/Time', '25/11/2026 08:50 AM', 'P2', '1', pido.startsWith('PG') ? 'GCI010' : 'GC 501',
  pido.startsWith('PG') ? '58510-BZN90-C0' : '64770-BZU90-C0', 'CARPET', 'CX05', '30', '2', '60', '1.0000', 'Total By Page'].join('\n');
function multipart(texts: string[]) {
  const boundary = 'production-perodua';
  return { type: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat([...texts.flatMap((text, index) => [Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="po${index}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfFor([text]), Buffer.from('\r\n')]), Buffer.from(`--${boundary}--\r\n`)]) };
}

test('Perodua saves to the same SQLite database, merges PM/PK, and preserves existing Toyota/accounts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-perodua-sqlite-'));
  const options = optionsFor(dir);
  const { app, engine, store } = await buildApp(options);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Perodua must not call n8n.'); };
  let headers: Record<string, string>;
  async function upload(texts: string[], target?: string) {
    const form = multipart(texts);
    const response = await app.inject({ method: 'POST', url: '/api/jobs' + (target ? '?perodua_entry_id=' + target : ''),
      headers: { ...headers, 'content-type': form.type }, payload: form.payload });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().id; await engine.start(store.get(id)!);
    assert.equal(store.get(id)!.state, 'completed', JSON.stringify(store.get(id)));
    return id as string;
  }
  async function complete(id: string) {
    const response = await app.inject({ method: 'POST', url: `/api/perodua/dates/${id}/complete`, headers });
    assert.equal(response.statusCode, 200, response.body);
    const download = await app.inject({ url: `/api/perodua/dates/${id}/workbook`, headers });
    assert.equal(download.statusCode, 200, download.body);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(download.rawPayload as never);
    return book;
  }
  try {
    assert.equal((await app.inject({ url: '/api/perodua' })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: origin,
      payload: { username: 'pilot', password: options.password } });
    headers = { ...origin, cookie: String(login.headers['set-cookie']).split(';')[0] };
    await engine.ledger.ingest(assemble([pageFor(orders[0])]).orders);
    const snapshot = () => Object.fromEntries(['dispatch_dates', 'users', 'sessions', 'app_meta'].map(table =>
      [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const schema = store.db.prepare("SELECT sql FROM sqlite_master WHERE name='dispatch_dates'").get();
    const id = await upload([sample('PG1'), sample('PM1'), sample('001')]);
    const job = (await app.inject({ url: `/api/jobs/${id}`, headers })).json();
    assert.equal(job.results.length, 2);
    const cards = (await app.inject({ url: `/api/jobs/${id}/saved-dates`, headers })).json().dates;
    assert.deepEqual(cards.map((entry: { family: string }) => entry.family).sort(), ['PG', 'PM_PK']);
    const mixed = cards.find((entry: { family: string }) => entry.family === 'PM_PK');
    const pg = cards.find((entry: { family: string }) => entry.family === 'PG');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_documents').get()!.n, 3);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_batches').get()!.n, 2);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_batch_documents').get()!.n, 3);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_exports').get()!.n, 2);
    assert.equal(store.db.prepare("SELECT json_extract(payload,'$.data.PIDO') AS pido FROM perodua_documents WHERE pido='001'").get()!.pido, '001');
    await assert.rejects(fs.access(path.join(dir, 'perodua', 'state.json')));
    const pgBook = await complete(pg.id);
    assert.equal(pgBook.getWorksheet('Delivery')!.getCell('H2').value, 'D24L');
    const mixedBook = await complete(mixed.id);
    const sheet = mixedBook.getWorksheet('Delivery')!;
    assert.equal(sheet.columnCount, 13);
    assert.equal(sheet.getCell('K1').value, 'Total Qty');
    assert.equal(sheet.getCell('K2').value, 60);
    assert.equal(sheet.getCell('K3').value, 60);
    assert.equal(sheet.getCell('L1').value, 'Delivery Time');
    assert.equal(sheet.getCell('M1').value, 'TRIP');
    assert.equal(sheet.getCell('G2').value, 'PM1');
    assert.equal(sheet.getCell('G3').value, '001');
    assert.equal(sheet.getCell('I2').value, 'D27A');
    assert.equal(sheet.getCell('I3').value, 'no model');
    assert.deepEqual(['A2', 'B2', 'D2'].map(cell => sheet.getCell(cell).value), [null, null, null]);
    const oldVersion = await app.inject({ url: `/api/perodua/exports/${mixed.export_id}`, headers });
    assert.equal((await app.inject({ method: 'POST', url: `/api/perodua/dates/${mixed.id}/reopen`, headers })).statusCode, 200);
    await upload([sample('002', 2), sample('PM1')], mixed.id);
    const history = (await app.inject({ url: '/api/perodua', headers })).json();
    assert.equal(history.dates.length, 2);
    assert.equal(history.dates.find((entry: { id: string }) => entry.id === mixed.id).order_count, 3);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_documents').get()!.n, 4);
    assert.equal((await complete(mixed.id)).getWorksheet('Delivery')!.rowCount, 4);
    assert.deepEqual((await app.inject({ url: `/api/perodua/exports/${mixed.export_id}`, headers })).rawPayload, oldVersion.rawPayload);
    // Failed SQLite writes roll back only the attempted Perodua change.
    const ledger = readPeroduaLedger(dir);
    const invalid = structuredClone(ledger); invalid.dates[0].document_keys.push('missing-key');
    assert.throws(() => writePeroduaLedger(dir, invalid), /FOREIGN KEY/);
    assert.deepEqual(readPeroduaLedger(dir), ledger);
    const restarted = await buildApp(options);
    try {
      assert.equal((await restarted.app.inject({ url: '/api/perodua', headers })).json().dates.length, 2);
      assert.equal((await restarted.app.inject({ url: '/api/session', headers })).statusCode, 200);
    } finally { await restarted.app.close(); }
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/perodua/dates/${mixed.id}`, headers })).statusCode, 200);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_batches').get()!.n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_documents').get()!.n, 1);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='dispatch_dates'").get(), schema);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/history', headers })).statusCode, 200);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_documents').get()!.n, 0);
    assert.equal((await app.inject({ url: '/api/session', headers })).statusCode, 200);
  } finally { globalThis.fetch = oldFetch; await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('mixed uploads keep Toyota on authenticated n8n callbacks and save Perodua once at completion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-mixed-n8n-'));
  const options = optionsFor(dir);
  const { app, engine, store } = await buildApp(options);
  const oldFetch = globalThis.fetch;
  const calls: { url: string; job: string; secret: string | undefined }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), job: JSON.parse(String(init!.body)).job_id,
      secret: (init!.headers as Record<string, string>)['X-Service-Secret'] });
    return new Response('{}', { status: 200 });
  };
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: origin,
      payload: { username: 'pilot', password: options.password } });
    const headers = { ...origin, cookie: String(login.headers['set-cookie']).split(';')[0] };
    const internal = { 'x-service-secret': options.serviceSecret };
    const form = multipart([textFor(orders[0]), sample('PM5'), sample('005')]);
    const uploaded = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers, 'content-type': form.type }, payload: form.payload });
    const id = uploaded.json().id;
    await engine.start(store.get(id)!);
    const job = store.get(id)!;
    assert.equal(job.state, 'processing');
    assert.equal(job.pages.length, 1);
    assert.equal(job.files[1].perodua!.status, 'extracted');
    assert.deepEqual(calls, [{ url: options.n8nWebhook, job: id, secret: options.serviceSecret }]);
    assert.equal((await app.inject({ method: 'POST', url: `/internal/jobs/${id}/next`, payload: { attempt: job.attempt } })).statusCode, 401);
    const next = await app.inject({ method: 'POST', url: `/internal/jobs/${id}/next`, headers: internal, payload: { attempt: job.attempt } });
    assert.equal(next.statusCode, 200, next.body);
    assert.match(next.json().document_text, /SGIS12AA0747/);
    assert.doesNotMatch(next.json().document_text, /PERODUA/);
    const callback = await app.inject({ method: 'POST', url: `/internal/jobs/${id}/result`, headers: internal,
      payload: { attempt: job.attempt, page_id: next.json().page_id, extraction: pageFor(orders[0]).extraction } });
    assert.equal(callback.statusCode, 200, callback.body);
    const done = await app.inject({ method: 'POST', url: `/internal/jobs/${id}/next`, headers: internal, payload: { attempt: job.attempt } });
    assert.equal(done.json().done, true, done.body);
    assert.equal(store.get(id)!.state, 'completed');
    const cards = (await app.inject({ url: `/api/jobs/${id}/saved-dates`, headers })).json().dates;
    assert.equal(cards.length, 2);
    assert.equal(cards.find((entry: { company: string }) => entry.company === 'PERODUA').family, 'PM_PK');
    assert.equal(store.getDate('2026-09-03')!.orders[0].source_order_id, 'SGIS12AA0747');
    assert.equal((await app.inject({ method: 'POST', url: '/api/dispatch-dates/2026-09-03/complete', headers })).statusCode, 200);
    const download = await app.inject({ url: '/api/dispatch-dates/2026-09-03/workbook', headers });
    assert.equal(download.statusCode, 200);
    assert.match(String(download.headers['content-disposition']), /Toyota_2026-09-03_Combined.xlsx/);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(download.rawPayload as never);
    assert.equal(workbook.getWorksheet('ASSB2016')!.getCell('V13').value, 1200);
    const before = store.db.prepare('SELECT count(*) AS n FROM perodua_exports').get()!.n;
    await engine.finish(store.get(id)!);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_exports').get()!.n, before);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = oldFetch; await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('same-date Perodua batches stay separate, PM accepts PK, and incompatible types notify once behind authentication', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-perodua-batches-'));
  const options = optionsFor(dir);
  const { app, engine, store } = await buildApp(options);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Perodua must not call n8n.'); };
  try {
    store.createUser('staff', 'staff-password-123');
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: origin,
      payload: { username: 'staff', password: 'staff-password-123' } });
    const headers = { ...origin, cookie: String(login.headers['set-cookie']).split(';')[0] };
    async function upload(texts: string[], target?: string) {
      const form = multipart(texts);
      const response = await app.inject({ method: 'POST', url: '/api/jobs' + (target ? '?perodua_entry_id=' + target : ''),
        headers: { ...headers, 'content-type': form.type }, payload: form.payload });
      assert.equal(response.statusCode, 202, response.body);
      await engine.start(store.get(response.json().id)!);
      return (await app.inject({ url: `/api/jobs/${response.json().id}`, headers })).json();
    }
    const first = await upload([sample('PM1')]);
    const firstCard = (await app.inject({ url: `/api/jobs/${first.id}/saved-dates`, headers })).json().dates[0];
    assert.equal(firstCard.family, 'PM');
    const appended = await upload([sample('001')], firstCard.id);
    assert.equal(appended.state, 'completed');
    const mixed = (await app.inject({ url: `/api/jobs/${first.id}/saved-dates`, headers })).json().dates[0];
    assert.equal(mixed.family, 'PM_PK');
    assert.equal(mixed.order_count, 2);
    const second = await upload([sample('PM1'), sample('001')]);
    const secondCard = (await app.inject({ url: `/api/jobs/${second.id}/saved-dates`, headers })).json().dates[0];
    assert.notEqual(secondCard.id, mixed.id);
    assert.equal(secondCard.date, mixed.date);
    assert.match(secondCard.filename, /_PERODUA_PM_PK_PO \(1\)\.xlsx$/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_documents').get()!.n, 2);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_batch_documents').get()!.n, 4);
    const blocked = await upload([sample('PG1'), sample('PG2')], mixed.id);
    assert.equal(blocked.state, 'failed');
    assert.equal(blocked.file_type_error.message, 'Error: different files type, Current file: PM & PK');
    assert.equal(blocked.results.length, 0);
    assert.equal(blocked.files.some((file: { error?: string }) => file.error), false);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM perodua_batches').get()!.n, 2);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/perodua/dates/${mixed.id}`, headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/history', headers })).statusCode, 403);
  } finally { globalThis.fetch = oldFetch; await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
