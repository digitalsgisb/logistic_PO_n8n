import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseTagging, tagsPerRack } from '../server/tagging.ts';
import { validatePage } from '../server/mapping.ts';
import { pageFor, pdfFor } from './helpers.ts';
import { buildApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { taggingIdentity } from '../server/taggingIdentity.ts';
const small = (codes: string[], place = 'BKT RAJA', sequence = '2026 0908 01') =>
  `ASSB ${place}\n${sequence}\n${codes.map((c) => `${c} STORE ADDRESS`).join('\n')}`;
const rack = (place = 'BKT RAJA', sequence = '2026090801') =>
  `ASSB ${place}\nORDER NUMBER\n${sequence}\nSKID NO. OF`;

test('same-trip HOOK and carpet covers match separate printed identities and POs', () => {
  const smallAt = (codes: string[], supplier: string, dock: string, lane: string) =>
    `SUPPLIER\nDOCK CODE\nASSB SHAH ALAM\nSGIS SUGIHARA GRAND\n${dock}\n${supplier}\nMROSNo.(P/LANE)\nARRIVAL DATE\n08/09/26\n${lane}\n${small(codes, 'SHAH ALAM')}`;
  const rackAt = (supplier: string, dock: string, lane: string) =>
    `${rack('SHAH ALAM')}\n${supplier}\nRECEIVING DOCK CODE MROS NO. (P-LANE)\n${dock} ${lane}`;
  const base = validatePage(pageFor().extraction, pageFor());
  const hook = {
    ...base,
    delivery_sequence: '2026090801',
    tagging_identity: taggingIdentity('SGIS-1-A01 2026090801 1/1 2A\n10 WS02-01'),
  };
  const carpet = {
    ...hook,
    kb_number: 'CARPET-SA',
    tagging_identity: taggingIdentity('SGIS-1 2026090801 1/1 2D\n01 WS02-01'),
    items: [
      {
        part_number: '58500-0KG90-C0',
        item_code: '239X',
        pack_size: 15,
        kanban_count: 3,
        total_quantity: 45,
      },
    ],
  };
  const texts = [
    smallAt(['HU83', 'HU83', 'HU83'], 'SGIS-1-A01', '2A', '10'),
    rackAt('SGIS-1-A01', '2A', '10'),
    smallAt(['239X', '239X', '239X'], 'SGIS-1', '2D', '01'),
    rackAt('SGIS-1', '2D', '01'),
  ];
  const pages = analyseTagging(texts, [hook, carpet]);
  assert.deepEqual(
    pages.map((p) => p.copies),
    [1, 2, 1, 6],
  );
  assert.deepEqual(
    pages.flatMap((p) => p.notes),
    [],
  );
  assert.deepEqual(pages[1].matchedOrders, [hook.kb_number]);
  assert.deepEqual(pages[3].matchedOrders, [carpet.kb_number]);
  const reversed = analyseTagging([...texts].reverse(), [carpet, hook]);
  assert.deepEqual(
    reversed.map((p) => p.copies),
    [6, 1, 2, 1],
  );
  const duplicate = analyseTagging([...texts, texts[1]], [hook, carpet]);
  assert.equal(duplicate[1].copies, 0);
  assert.equal(duplicate[3].copies, 6);
});
test('six small tags across two pages produce twelve rack copies plus two original pages', () => {
  const pages = analyseTagging([small(['56C2', '56C3', '9V82']), small(['9V82', 'D847', 'G360']), rack()]);
  assert.deepEqual(
    pages.map((p) => p.copies),
    [1, 1, 12],
  );
  assert.equal(pages[2].lines.find((l) => l.code === '9V82')?.racks, 2);
});
test('exceptions apply per rack and destination, mixed parts use weighted counts', () => {
  assert.equal(tagsPerRack('BUKIT RAJA', '614'), 1);
  for (const code of ['HU83', '238X', 'HU82']) assert.equal(tagsPerRack('SHAH ALAM', code), 1);
  assert.equal(tagsPerRack('SHAH ALAM', '239X'), 2);
  const pages = analyseTagging([small(['HU83', 'HU83', 'HU83', '239X'], 'SHAH ALAM'), rack('SHAH ALAM')]);
  assert.equal(pages[1].copies, 4);
});
test('dates and destinations do not mix; duplicate rack covers and unknown pages require review', () => {
  const pages = analyseTagging([
    small(['614']),
    rack(),
    small(['HU83'], 'SHAH ALAM', '2026 0909 02'),
    rack('SHAH ALAM', '2026090902'),
  ]);
  assert.deepEqual(
    pages.map((p) => p.copies),
    [1, 1, 1, 2],
  );
  const ambiguous = analyseTagging([small(['614']), rack(), rack(), 'unreadable']);
  assert.equal(ambiguous[1].copies, 0);
  assert.ok(ambiguous[1].notes.some((n) => n.includes('uniquely')));
  assert.equal(ambiguous[3].kind, 'unknown');
});
test('matching PO quantities are cross-checked and differences require review', () => {
  const order = validatePage(pageFor().extraction, pageFor());
  const texts = [
    small(['HU83', 'HU83', 'HU83'], 'SHAH ALAM', '2026 0903 01'),
    rack('SHAH ALAM', '2026090301'),
  ];
  const matched = analyseTagging(texts, [order])[1];
  assert.deepEqual(matched.matchedOrders, [order.kb_number]);
  assert.deepEqual(matched.notes, []);
  assert.equal(matched.copies, 2);
  const mismatch = analyseTagging([...Array.from({ length: 30 }, () => texts[0]), texts[1]], [order]).at(-1)!;
  assert.ok(mismatch.notes.some((n) => n.includes('differ')));
  assert.equal(mismatch.copies, 2);
  assert.equal(mismatch.lines[0].tagRacks, 90);
});
test('tagging upload requires authentication and reads PDF into a review plan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagging-api-'));
  const { app } = await buildApp({
    ...config,
    dataDir: dir,
    username: 'test',
    password: 'test-password',
    sessionSecret: 's'.repeat(40),
  });
  try {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/tagging/review',
          headers: { 'x-requested-with': 'ToyotaPO' },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'x-requested-with': 'ToyotaPO' },
      payload: { username: 'test', password: 'test-password' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const bytes = pdfFor([small(['614']), rack()]);
    const payload = Buffer.concat([
      Buffer.from(
        '--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="tags.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
      ),
      bytes,
      Buffer.from('\r\n--test-boundary--\r\n'),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/tagging/review',
      headers: {
        cookie,
        'x-requested-with': 'ToyotaPO',
        'content-type': 'multipart/form-data; boundary=test-boundary',
      },
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().pages.map((p: { copies: number }) => p.copies),
      [1, 1],
    );
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
