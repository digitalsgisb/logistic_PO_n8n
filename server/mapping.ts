import type { Destination, Extraction, Order, Page, Result } from './types.ts';
import { createHash } from 'node:crypto';
export const headers: Record<string, { column: number; destination: Destination }> = Object.fromEntries(
  [
    '9V82',
    'D847',
    'G360',
    'G361',
    '56C2',
    '56C3',
    '590V',
    '614',
    '812',
    '815V',
    '818V',
    '816V',
    '817V',
    '819V',
    '824V',
    '823V',
    '822V',
    '821V',
    'HU83',
    '239X',
    '240X',
    '238X',
    'HU82',
    'KH97',
    'ZP47',
    'KH98',
    'JP01',
  ].map((code, i) => [code, { column: i + 4, destination: i < 18 ? 'BUKIT RAJA' : 'SHAH ALAM' }]),
);
export const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export function destination(value: string): Destination {
  const text = String(value).toUpperCase();
  const sa = /SHAH\s+ALAM/.test(text),
    br = /B(?:UKIT|KT)\s+RAJA/.test(text);
  if (sa === br) throw new Error('Destination is missing or conflicting; expected Shah Alam or Bukit Raja.');
  return sa ? 'SHAH ALAM' : 'BUKIT RAJA';
}
export function kbNumber(id: string, place: Destination) {
  if (!/^SGIS[A-Z0-9]+$/.test(id)) throw new Error('Invalid original order identifier.');
  return `${id}-${place === 'SHAH ALAM' ? 'SA' : 'BR'}`;
}
export function isoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
    throw new Error('Invalid delivery date.');
  return value;
}
export function validatePage(raw: unknown, page: Page): Order {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('AI returned no order object.');
  const x = raw as Extraction;
  if (typeof x.source_order_id !== 'string' || !/^SGIS[A-Z0-9]+$/.test(x.source_order_id))
    throw new Error('Invalid original order identifier.');
  const sourceIds = [...new Set(page.text.toUpperCase().match(/SGIS\d+[A-Z]+\d+/g) ?? [])];
  if (sourceIds.length !== 1 || sourceIds[0] !== x.source_order_id)
    throw new Error('Order identifier does not match the source page.');
  const place = destination(x.destination);
  if (destination(page.text) !== place) throw new Error('Destination disagrees with the source page.');
  const route = typeof x.route === 'string' ? x.route.toUpperCase() : '';
  if (!/^(WS02|WM02)-(0[1-9]|10)$/.test(route) || !page.text.includes(route))
    throw new Error('Missing, unknown, or ungrounded delivery route.');
  const sourceRoutes = [...new Set(page.text.match(/(?:WS02|WM02)-\d{2}/g) ?? [])];
  if (sourceRoutes.length !== 1) throw new Error('Conflicting delivery routes on the source page.');
  const date = isoDate(String(x.delivery_date));
  const [y, m, d] = date.split('-');
  const sourceDates = [...page.text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4}|\d{2})\b/g)].map(
    (t) => `${t[3].length === 2 ? '20' + t[3] : t[3]}-${t[2]}-${t[1]}`,
  );
  if (!sourceDates.includes(`${y}-${m}-${d}`) || new Set(sourceDates).size !== 1)
    throw new Error('Delivery date is missing or ambiguous in the source.');
  // Page markers must be isolated (dates are excluded).
  const marker = page.text
    .split('\n')
    .flatMap((l) => [...l.matchAll(/(?:^|\s)(\d{1,3})\/(\d{1,3})(?=\s|$)/g)])[0];
  if (
    !Number.isInteger(x.page_number) ||
    !Number.isInteger(x.page_count) ||
    x.page_number < 1 ||
    x.page_count < x.page_number ||
    x.page_count > 100 ||
    !marker ||
    +marker[1] !== x.page_number ||
    +marker[2] !== x.page_count
  )
    throw new Error('Invalid or ungrounded order page numbering.');
  if (!Array.isArray(x.items) || !x.items.length) throw new Error('No line items extracted.');
  const partLines = page.text.split('\n').filter((l) => /\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{2}\b/.test(l));
  if (partLines.length !== x.items.length)
    throw new Error('Extracted line count does not match the source page.');
  const available = [...partLines];
  for (const item of x.items) {
    if (typeof item.item_code !== 'string' || typeof item.part_number !== 'string')
      throw new Error('Invalid item identifiers.');
    const map = headers[item.item_code];
    if (!map || map.destination !== place)
      throw new Error(`Unknown item or wrong plant section: ${item.item_code}.`);
    for (const n of [item.pack_size, item.kanban_count, item.total_quantity])
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid quantity for ${item.item_code}.`);
    if (item.pack_size * item.kanban_count !== item.total_quantity)
      throw new Error(`Quantity arithmetic mismatch for ${item.item_code}.`);
    const index = available.findIndex((line) => {
      const tokens = line.trim().split(/\s+/);
      return (
        tokens[0] === item.part_number &&
        tokens[1] === item.item_code &&
        tokens
          .slice(-3)
          .map(Number)
          .every((n, i) => n === [item.pack_size, item.kanban_count, item.total_quantity][i])
      );
    });
    if (index < 0)
      throw new Error(`Item ${item.item_code} or its quantities were not found together in the source.`);
    available.splice(index, 1);
  }
  const total = page.text.match(/\bTOTAL\s+(\d+)\b/);
  if (!total || +total[1] !== x.items.reduce((n, i) => n + i.kanban_count, 0))
    throw new Error('Kanban total does not reconcile with the page TOTAL.');
  return {
    ...x,
    delivery_date: date,
    destination: place,
    route,
    kb_number: kbNumber(x.source_order_id, place),
    trip: +route.slice(-2),
    source_pages: [`${page.filename} / page ${page.number}`],
    source_page_ids: [page.id],
  };
}
export function assemble(pages: Page[]): { orders: Order[]; errors: Result[] } {
  const groups = new Map<string, Page[]>();
  for (const page of pages) {
    const ids = [...new Set(page.text.match(/SGIS\d+[A-Z]+\d+/g) ?? [])];
    // Include failed pages in the group, so an incomplete order cannot be released.
    let place = 'UNKNOWN';
    try {
      place = destination(page.text);
    } catch {}
    const key = ids.length === 1 ? ids[0] + '|' + place : page.id;
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }
  const orders: Order[] = [],
    errors: Result[] = [];
  for (const [id, group] of groups) {
    try {
      const unique = [...new Map(group.map((p) => [hash(p.text.replace(/\s+/g, ' ').trim()), p])).values()];
      const validated = unique.map((p) => {
        if (p.error || !p.extraction) throw new Error(p.error ?? 'Order contains an unreadable page.');
        return validatePage(p.extraction, p);
      });
      const first = validated[0];
      if (
        validated.some(
          (v) =>
            v.destination !== first.destination ||
            v.delivery_date !== first.delivery_date ||
            v.route !== first.route ||
            v.page_count !== first.page_count,
        )
      )
        throw new Error('Conflicting versions or delivery details for this order.');
      if (
        validated.length !== first.page_count ||
        new Set(validated.map((v) => v.page_number)).size !== first.page_count
      )
        throw new Error('Missing pages or conflicting copies of the same order page.');
      const items = new Map<string, Order['items'][number]>();
      for (const item of validated.flatMap((v) => v.items)) {
        const old = items.get(item.item_code);
        if (old && (old.part_number !== item.part_number || old.pack_size !== item.pack_size))
          throw new Error(`Conflicting part details for ${item.item_code}.`);
        items.set(
          item.item_code,
          old
            ? {
                ...old,
                total_quantity: old.total_quantity + item.total_quantity,
                kanban_count: old.kanban_count + item.kanban_count,
              }
            : { ...item },
        );
      }
      orders.push({
        ...first,
        items: [...items.values()],
        source_pages: validated.flatMap((v) => v.source_pages),
        source_page_ids: group.map((p) => p.id),
      });
    } catch (error) {
      errors.push({
        id: hash(id).slice(0, 20),
        order_id: id.split('|')[0],
        status: 'review',
        error: error instanceof Error ? error.message : String(error),
        sources: group.map((p) => `${p.filename} / page ${p.number}`),
      });
    }
  }
  return { orders, errors };
}
