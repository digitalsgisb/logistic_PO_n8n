import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { assemble, destination, kbNumber, validatePage, headers } from '../server/mapping.ts';
import { batchFilename, writeBatch } from '../server/workbook.ts';
import { readPdf } from '../server/pdf.ts';
import { orders, pageFor, pdfFor, textFor } from './helpers.ts';

test('four sample orders produce one daily sheet with nine quantities and PO numbers in Remarks', async () => {
  const pages = orders.map((o, i) => ({ ...pageFor(o, String(i)), number: i + 1 }));
  const result = assemble(pages);
  assert.deepEqual(result.errors, []);
  assert.equal(result.orders.length, 4);
  assert.equal(
    result.orders.reduce((s, o) => s + o.items.length, 0),
    9,
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-workbooks-'));
  try {
    const file = path.join(dir, batchFilename(result.orders));
    await writeBatch(result.orders, 'templates/toyota.xlsx', file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    assert.equal(wb.worksheets.length, 1);
    const s = wb.getWorksheet('ASSB2016')!;
    assert.equal(s.getCell('F4').value, 'DATE : 03/09/2026');
    for (const order of result.orders)
      for (const item of order.items) {
        const row = 13 + (order.trip - 1) * 3,
          col = headers[item.item_code].column;
        assert.equal(s.getCell(row, col).value, item.total_quantity);
        assert.equal(s.getCell(row + 1, col).value, null);
        assert.equal(s.getCell(row + 2, col).value, null);
      }
    assert.equal(s.getCell('A25').value, 'TRIP 5');
    assert.equal(s.getCell('H10').value, null);
    assert.equal(s.getCell('C13').value, null);
    assert.equal(s.getCell('V13').value, 1200);
    assert.equal(s.getCell('AE13').value, 'SGIS12AA0747-SA');
    assert.equal(s.getCell('AE14').value, '* SGIS12DA3251-SA');
    assert.equal(s.getCell('AE16').value, 'SGIS12DA3252-SA');
    assert.equal(s.getCell('AE17').value, '* SGIS13FA5002-BR');
    assert.equal(s.getCell('H16').value, 30);
    assert.equal(s.getCell('H19').value, null);
    assert.equal(s.getCell('AE19').value, null);
    assert.equal(s.getCell('AE17').font.size, 20);
    assert.equal(s.getCell('AE17').font.bold, true);
    assert.equal(s.getCell('AE15').value, null);
    assert.equal(s.pageSetup.printArea, 'A4:AE42');
    assert.equal(s.pageSetup.paperSize, 9);
    assert.equal(s.pageSetup.orientation, 'landscape');
    assert.equal(s.pageSetup.fitToPage, true);
    assert.equal(s.pageSetup.fitToWidth, 1);
    assert.equal(s.pageSetup.fitToHeight, 1);
    assert.equal(s.getCell('V13').numFmt, '0');
    assert.equal(s.getCell('W13').numFmt, '"* "0');
    assert.equal(s.getCell('D16').numFmt, '"* "0');
    assert.ok(s.model.merges.includes('D6:U6'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('shared item and trip quantities add without overwriting; dates stay on separate daily sheets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-combined-'));
  try {
    const a = validatePage(pageFor().extraction, pageFor());
    const sameTrip = { ...structuredClone(a), source_order_id: 'SGIS12AA0748', kb_number: 'SGIS12AA0748-SA' };
    const otherDate = {
      ...structuredClone(a),
      source_order_id: 'SGIS12AA0749',
      kb_number: 'SGIS12AA0749-SA',
      delivery_date: '2026-09-04',
      delivery_sequence: '2026090401',
    };
    const file = path.join(dir, 'combined.xlsx');
    await writeBatch([a, sameTrip, otherDate], 'templates/toyota.xlsx', file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    assert.deepEqual(
      wb.worksheets.map((s) => s.name),
      ['2026-09-03', '2026-09-04'],
    );
    const first = wb.worksheets[0],
      second = wb.worksheets[1];
    assert.equal(first.getCell('V13').value, 2400);
    assert.equal(second.getCell('V13').value, 1200);
    assert.equal(first.getCell('V13').numFmt, '0"\n*"');
    assert.equal(second.getCell('V13').numFmt, '0');
    assert.equal(first.getCell('AE14').value, '* SGIS12AA0748-SA');
    assert.equal(second.getCell('AE13').value, 'SGIS12AA0749-SA');
    assert.equal(second.getCell('AE14').value, null);
    assert.equal(second.getCell('F4').value, 'DATE : 04/09/2026');
    assert.deepEqual(first.model.merges, second.model.merges);
    assert.deepEqual(first.pageSetup, second.pageSetup);
    assert.equal(first.getColumn(31).width, second.getColumn(31).width);
    const crowded = Array.from({ length: 7 }, (_, i) => ({
      ...structuredClone(a),
      source_order_id: `SGIS12AA${8000 + i}`,
      kb_number: `SGIS12AA${8000 + i}-SA`,
    }));
    await writeBatch(crowded, 'templates/toyota.xlsx', file);
    const many = new ExcelJS.Workbook();
    await many.xlsx.readFile(file);
    const sheet = many.worksheets[0];
    assert.equal(sheet.getCell('V13').value, 8400);
    assert.equal(sheet.getCell('V13').numFmt, '0"\n*\n**\n***\n****\n*****\n******"');
    assert.deepEqual(
      [13, 14, 15].flatMap((r) => String(sheet.getCell(r, 31).value).split('\n')),
      crowded.map((o, i) => (i ? `${'*'.repeat(i)} ${o.kb_number}` : o.kb_number)),
    );
    assert.ok(sheet.getRow(13).height! >= 84);
    sameTrip.items[0].part_number = 'XXXXX-XXXXX-XX';
    await assert.rejects(
      writeBatch([a, sameTrip], 'templates/toyota.xlsx', file),
      /Conflicting part numbers/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('destination normalization and suffix derivation preserve the original ID', () => {
  assert.equal(destination('ASSB BKT RAJA'), 'BUKIT RAJA');
  assert.equal(destination('ASSB BUKIT RAJA'), 'BUKIT RAJA');
  assert.equal(kbNumber('SGIS12AA0747', 'SHAH ALAM'), 'SGIS12AA0747-SA');
  assert.equal(kbNumber('SGIS13FA5002', 'BUKIT RAJA'), 'SGIS13FA5002-BR');
  assert.throws(() => kbNumber('SGIS12AA0747-SA', 'SHAH ALAM'));
  const p = pageFor();
  const o = validatePage(p.extraction, p);
  assert.equal(o.source_order_id, 'SGIS12AA0747');
  assert.equal(o.trip, 1);
  assert.equal(p.extraction?.source_order_id, 'SGIS12AA0747');
});

test('trip comes from the printed delivery sequence independently of the route suffix', () => {
  for (const trip of [1, 2, 10]) {
    const p = pageFor(orders[3]);
    const sequence = `20260903${String(trip).padStart(2, '0')}`;
    p.text = p.text.replace('2026090302', sequence);
    const result = validatePage(p.extraction, p);
    assert.equal(result.trip, trip);
    assert.equal(result.delivery_sequence, sequence);
    assert.equal(result.route, 'WM02-03');
  }
  const p = pageFor();
  p.text = p.text.replace('WS02-01', 'WS02-12');
  p.extraction!.route = 'WS02-12';
  p.text += '\n2026090301'; // Duplicate text of the same sequence is harmless.
  assert.equal(validatePage(p.extraction, p).trip, 1);
});

test('missing, conflicting, invalid, or wrong-date sequences require review instead of using the route', () => {
  for (const replacement of [
    '',
    '2026090300',
    '2026090311',
    '2026090401',
    '2026090301 2026090302',
    '20260903010',
  ]) {
    const p = pageFor();
    p.text = p.text.replace('2026090301', replacement);
    assert.throws(() => validatePage(p.extraction, p), /[Dd]elivery sequence/);
    assert.equal(assemble([p]).orders.length, 0);
  }
});

test('different delivery sequences across pages of one order require review', () => {
  const first = structuredClone(orders[0]);
  first.page_count = 2;
  const second = { ...structuredClone(first), page_number: 2 };
  const p = pageFor(first, 'a');
  const q = pageFor(second, 'b');
  q.text = q.text.replace('2026090301', '2026090302');
  const result = assemble([p, q]);
  assert.equal(result.orders.length, 0);
  assert.match(result.errors[0].error!, /Conflicting versions or delivery details/);
});
test('unknown/conflicting destinations cannot receive a guessed suffix', () => {
  for (const value of ['ASSB UNKNOWN', 'ASSB SHAH ALAM BKT RAJA']) assert.throws(() => destination(value));
  const p = pageFor();
  p.extraction!.destination = 'BUKIT RAJA';
  assert.throws(() => validatePage(p.extraction, p), /Destination/);
});
test('reject hallucinated identifiers, unknown codes, incomplete items, and unsupported routes', () => {
  for (const change of [
    (p: ReturnType<typeof pageFor>) => (p.extraction!.source_order_id = 'SGIS999AA999'),
    (p: ReturnType<typeof pageFor>) => (p.extraction!.items[0].item_code = 'ZZZZ'),
    (p: ReturnType<typeof pageFor>) => (p.extraction!.items = []),
    (p: ReturnType<typeof pageFor>) => (p.extraction!.route = 'PA1-10'),
  ]) {
    const p = pageFor();
    change(p);
    assert.throws(() => validatePage(p.extraction, p));
  }
});
test('validate quantity arithmetic, source row relationships, and TOTAL', () => {
  const p = pageFor();
  p.extraction!.items[0].total_quantity = 3;
  assert.throws(() => validatePage(p.extraction, p), /arithmetic/);
  const q = pageFor();
  q.extraction!.items[0].pack_size = 300;
  q.extraction!.items[0].total_quantity = 900;
  assert.throws(() => validatePage(q.extraction, q), /source/);
  const r = pageFor();
  r.text = r.text.replace('TOTAL 3', 'TOTAL 4');
  assert.throws(() => validatePage(r.extraction, r), /TOTAL/);
});
test('identical pages deduplicate but conflicting versions require review', () => {
  const p = pageFor(),
    copy = { ...structuredClone(p), id: 'copy', filename: 'copy.pdf' };
  assert.equal(assemble([p, copy]).orders.length, 1);
  copy.extraction!.items[0].total_quantity = 800;
  copy.extraction!.items[0].kanban_count = 2;
  copy.text = textFor(copy.extraction!);
  assert.equal(assemble([p, copy]).orders.length, 0);
  assert.equal(assemble([p, copy]).errors.length, 1);
});
test('multi-page orders merge matching items; missing/failed pages block the order', () => {
  const a = structuredClone(orders[0]),
    b = structuredClone(orders[0]);
  a.page_count = 2;
  b.page_count = 2;
  b.page_number = 2;
  const p = pageFor(a, 'a'),
    q = { ...pageFor(b, 'b'), number: 2 };
  const result = assemble([p, q]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.orders[0].items[0].total_quantity, 2400);
  assert.equal(assemble([p]).orders.length, 0);
  q.error = 'AI failed';
  q.extraction = undefined;
  assert.equal(assemble([p, q]).orders.length, 0);
});
test('different orders sharing an item code remain separate', () => {
  const result = assemble([pageFor(orders[1], 'a'), pageFor(orders[2], 'b')]);
  assert.equal(result.orders.length, 2);
  assert.deepEqual(
    result.orders.map((o) => o.trip),
    [1, 2],
  );
});
test('PDF text overlay duplicates are removed without removing real item rows', async () => {
  const pages = await readPdf(pdfFor(orders.map(textFor), true));
  assert.equal(pages.length, 4);
  assert.equal(pages[0].split('58521-KK010-00').length - 1, 1);
  for (let i = 0; i < 4; i++) {
    const page = pageFor(orders[i]);
    page.text = pages[i];
    assert.doesNotThrow(() => validatePage(page.extraction, page));
  }
});
test('malformed documents and page limits fail clearly', async () => {
  await assert.rejects(readPdf(Buffer.from('not a pdf')));
  await assert.rejects(readPdf(pdfFor(orders.map(textFor)), 2), /page limit/);
});
