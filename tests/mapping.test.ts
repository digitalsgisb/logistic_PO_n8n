import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { assemble, destination, kbNumber, validatePage, headers } from '../server/mapping.ts';
import { writeOrder } from '../server/workbook.ts';
import { readPdf } from '../server/pdf.ts';
import { orders, pageFor, pdfFor, textFor } from './helpers.ts';

test('all four sample orders map to the expected trip, quantity, and suffixed KB cells', async () => {
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
    for (const order of result.orders) {
      const file = path.join(dir, order.kb_number + '.xlsx');
      await writeOrder(order, 'templates/toyota.xlsx', file);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      assert.equal(wb.worksheets.length, 1);
      const s = wb.getWorksheet('ASSB2016')!;
      assert.equal(s.getCell('F4').value, 'DATE : 03/09/2026');
      for (const item of order.items) {
        const row = 13 + (order.trip - 1) * 3,
          col = headers[item.item_code].column;
        assert.equal(s.getCell(row, col).value, item.total_quantity);
        assert.equal(s.getCell(row + 1, col).value, order.kb_number);
        assert.equal(s.getCell(row + 2, col).value, null);
      }
      assert.equal(s.getCell('A25').value, 'TRIP 5');
      assert.equal(s.getCell('H10').value, null);
      assert.equal(s.getCell('C13').value, null);
      assert.equal(s.getCell('V13').value, order.source_order_id === 'SGIS12AA0747' ? 1200 : null);
    }
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
