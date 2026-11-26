/** Mirror the export ordering so reopened history lists the same PO sequence. */
type Item = { number?: number; part_name?: string; back_no?: string; part_no?: string };
type Entry = { key: string; data: { PIDO: string; delivery_date: string; delivery_time: string; delivery_trip?: number | null; Item: Item[] } };
const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
const family = (entry: Entry) => entry.data.PIDO.trim().toUpperCase().slice(0, 2);
const trip = (entry: Entry) => entry.data.delivery_trip ?? Infinity;
const groupName = (item: Item) => item.back_no?.replace(/\s+/g, '').toUpperCase() ?? '';

export function orderPeroduaDocuments<T extends Entry>(entries: T[]): T[] {
  const result: T[] = [], seen = new Set<string>();
  const push = (entry: T) => { if (!seen.has(entry.key)) { seen.add(entry.key); result.push(entry); } };
  for (const date of [...new Set(entries.map(entry => entry.data.delivery_date))].sort()) {
    const daily = entries.filter(entry => entry.data.delivery_date === date);
    daily.filter(entry => family(entry) === 'PG').sort((a, b) => (trip(a) - trip(b) || 0) ||
      natural(a.data.PIDO, b.data.PIDO) || a.data.delivery_time.localeCompare(b.data.delivery_time) || a.key.localeCompare(b.key)).forEach(push);
    const groups = new Map<string, { entry: T; item: Item }[]>();
    for (const entry of daily.filter(entry => family(entry) === 'PM')) {
      for (const item of entry.data.Item.length ? entry.data.Item : [{}]) {
        const name = groupName(item);
        groups.set(name, [...(groups.get(name) ?? []), { entry, item }]);
      }
    }
    const seed = (rows: { entry: T }[]) => rows.map(row => row.entry.data.PIDO).sort(natural)[0];
    for (const [, rows] of [...groups.entries()].sort(([a, aa], [b, bb]) => natural(seed(aa), seed(bb)) || a.localeCompare(b))) {
      const first = seed(rows);
      rows.sort((a, b) => Number(natural(a.entry.data.PIDO, first) !== 0) - Number(natural(b.entry.data.PIDO, first) !== 0) ||
        (trip(a.entry) - trip(b.entry) || 0) || natural(a.entry.data.PIDO, b.entry.data.PIDO) ||
        a.entry.key.localeCompare(b.entry.key)).forEach(row => push(row.entry));
    }
    daily.filter(entry => !['PG', 'PM'].includes(family(entry))).sort((a, b) => (trip(a) - trip(b) || 0) ||
      a.data.delivery_time.localeCompare(b.data.delivery_time) || natural(a.data.PIDO, b.data.PIDO) || a.key.localeCompare(b.key)).forEach(push);
  }
  return result;
}
