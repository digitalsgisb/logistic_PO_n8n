import fixtures from './fixtures/orders.json' with { type: 'json' };
import type { Extraction, Page } from '../server/types.ts';
import { hash } from '../server/mapping.ts';
export const orders: Extraction[] = fixtures;
// Independently transcribed from the printed sequence on each supplied sample page.
const sequences: Record<string, string> = {
  SGIS12AA0747: '2026090301',
  SGIS12DA3251: '2026090301',
  SGIS12DA3252: '2026090302',
  SGIS13FA5002: '2026090302',
};
export function textFor(x: Extraction) {
  return [
    '03/09/2026 11:15',
    'ASSB ' + x.destination,
    '11 ' + x.source_order_id,
    `SGIS SUGIHARA GRAND SGIS-1 ${sequences[x.source_order_id] ?? x.delivery_date.replaceAll('-', '') + '01'}`,
    `${x.page_number}/${x.page_count}`,
    '10 PA1-10',
    x.route,
    ...x.items.map(
      (i) => `${i.part_number} ${i.item_code} PACK ${i.pack_size} ${i.kanban_count} ${i.total_quantity}`,
    ),
    'TOTAL ' + x.items.reduce((s, i) => s + i.kanban_count, 0),
  ].join('\n');
}
export function pageFor(x = orders[0], id = 'page-1'): Page {
  const text = textFor(x);
  return {
    id,
    file_id: 'file-1',
    filename: 'sample.pdf',
    number: 1,
    text,
    hash: hash(text),
    state: 'extracted',
    extraction: structuredClone(x),
  };
}
// Minimal text-only PDF fixture, without requiring a PDF authoring dependency.
export function pdfFor(texts: string[], overlay = false) {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: number[] = [];
  for (const text of texts) {
    const pageId = objects.length + 1,
      streamId = pageId + 1;
    kids.push(pageId);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 900] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
    );
    const content = text
      .split('\n')
      .flatMap((line, i) =>
        Array(overlay ? 2 : 1).fill(
          `BT /F1 10 Tf 1 0 0 1 30 ${850 - i * 18} Tm (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`,
        ),
      )
      .join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((i) => i + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}
