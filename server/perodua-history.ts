import { tripSummary } from './perodua-trip-metadata.ts';
import { orderPeroduaDocuments } from './perodua-ordering.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readPeroduaLedger, writePeroduaLedger } from './perodua-storage.ts';
import { removeHistoryFiles } from './history-files.ts';

type Document = {
  key: string; source_file: string;
  data: { PIDO: string; delivery_date: string; delivery_time: string; delivery_trip?: number | null; Item: { back_no: string }[] };
  rows: unknown[] | null;
};
export type PeroduaExport = {
  collection_id?: string; family?: string;
  save_date?: string; completed_at?: string; trip_count?: number; missing_trip_count?: number;
  id: string; generated_date: string; created_at: string; filename: string;
  document_keys: string[]; document_count: number; item_count: number;
  documents: { key: string; pido: string; source_file: string; delivery_date: string; item_count: number }[];
};
type Ledger = { documents: Document[]; last_used: string[] | null; models: Record<string, string>; dates?: DateRecord[]; exports?: PeroduaExport[] };

type DateRecord = { id?: string; family?: string; date: string; status: 'open' | 'complete'; document_keys: string[]; serials: string[];
  current_export_id?: string; revision: number; updated_at: string; completed_at?: string; reopened_reason?: string; dirty?: boolean };
export type PeroduaSavedDate = {
  id: string; family?: string; versions: { id: string; filename: string; created_at: string }[];
  date: string; status: 'open' | 'complete'; company: 'PERODUA'; order_count: number;
  trip_count: number; missing_trip_count: number; serials: string[]; document_keys: string[];
  order_numbers: string[]; sources: string[]; updated_at: string; completed_at?: string;
  reopened_reason?: string; revision: number; export_id?: string; filename?: string;
  documents: { key: string; pido: string; source_file: string; delivery_date: string; delivery_trip?: number | null }[];
};

function entryFamily(ledger: Ledger, keys: string[]) {
  const families = new Set(ledger.documents.filter(entry => keys.includes(entry.key)).map(entry => {
    const pido = entry.data.PIDO.toUpperCase();
    return /^[0-9]+$/.test(pido) ? 'PK' : pido.startsWith('PG') ? 'PG' : pido.startsWith('PM') ? 'PM' : 'OTHER';
  }));
  return families.size === 2 && families.has('PM') && families.has('PK') ? 'PM_PK' : families.size === 1 ? [...families][0] : 'MIXED';
}

export function resolvePeroduaDate<T extends { id?: string; date: string }>(entries: T[], key: string) {
  const exact = entries.find(entry => (entry.id ?? entry.date) === key);
  if (exact) return exact;
  const matches = entries.filter(entry => entry.date === key);
  if (matches.length > 1) throw Object.assign(new Error('Several batches use this date. Choose the individual history entry.'), { statusCode: 409 });
  return matches[0];
}

function exportsFor(ledger: Ledger, entry: DateRecord) {
  const id = entry.id ?? entry.date;
  return (ledger.exports ?? []).filter(value => value.collection_id === id ||
    !value.collection_id && id === entry.date && (value.save_date ?? value.generated_date) === entry.date);
}

function dateRecords(ledger: Ledger): DateRecord[] {
  if (ledger.dates) return ledger.dates.map(entry => ({ ...entry, id: entry.id ?? entry.date,
    family: entryFamily(ledger, entry.document_keys) === 'PM_PK' ? 'PM_PK' : entry.family ?? entryFamily(ledger, entry.document_keys) }));
  const entries = new Map<string, DateRecord>();
  for (const exported of ledger.exports ?? []) {
    const date = exported.save_date ?? exported.generated_date;
    const key = exported.collection_id ?? date;
    const current = entries.get(key) ?? { id: key, date, status: 'open', document_keys: [],
      serials: (exported as PeroduaExport & { serials?: string[] }).serials ?? ['', '', ''],
      revision: 1, updated_at: exported.created_at, dirty: true, reopened_reason: 'ordering_update' };
    current.document_keys = [...new Set([...current.document_keys, ...exported.document_keys])];
    current.current_export_id = exported.id;
    entries.set(key, current);
  }
  return [...entries.values()].map(entry => ({ ...entry, id: entry.id ?? entry.date, family: entryFamily(ledger, entry.document_keys) }));
}

function savedDates(ledger: Ledger): PeroduaSavedDate[] {
  return dateRecords(ledger).map(entry => {
    const documents = orderPeroduaDocuments(ledger.documents.filter(value => entry.document_keys.includes(value.key)));
    const exported = ledger.exports?.find(value => value.id === entry.current_export_id);
    return { ...entry, id: entry.id ?? entry.date,
      versions: exportsFor(ledger, entry).filter(value => value.completed_at || !value.save_date).map(value => ({ id: value.id, filename: value.filename, created_at: value.created_at })),
      company: 'PERODUA' as const, order_count: documents.length,
      ...tripSummary(documents.map(value => value.data)), document_keys: documents.map(value => value.key),
      order_numbers: documents.map(value => value.data.PIDO), sources: [...new Set(documents.map(value => value.source_file))],
      export_id: exported?.id, filename: exported?.filename,
      documents: documents.map(value => ({ key: value.key, pido: value.data.PIDO, source_file: value.source_file,
        delivery_date: value.data.delivery_date, delivery_trip: value.data.delivery_trip })) };
  });
}

export async function savedPeroduaExport(dataDir: string, id?: string) {
  const ledger: Ledger = readPeroduaLedger(dataDir);
  const entry = id ? ledger.exports?.find(value => value.id === id) : ledger.exports?.at(-1);
  if (!entry) return undefined;
  if (path.basename(entry.filename) !== entry.filename || !/^(?:\d{2}-\d{2}-\d{4}_PERODUA_(?:PG|PM|PK)(?:_(?:PG|PM|PK))*_PO(?: \([1-9]\d*\))?|\d{2}-\d{2}-\d{4}_PERODUA_PO(?:_\d+)?|PERODUA_(?:PG|PM|PK)(?:_(?:PG|PM|PK))*_\d{2}-\d{2}-\d{4}(?: \([1-9]\d*\))?)\.xlsx$/.test(entry.filename))
    throw new Error('Invalid saved Perodua export filename.');
  return { ...entry, path: path.join(dataDir, 'perodua', 'exports', entry.filename) };
}

export async function deletePeroduaDate(dataDir: string, date: string) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(date)) throw Object.assign(new Error('Invalid saved date.'), { statusCode: 400 });
  const ledger: Ledger = readPeroduaLedger(dataDir);
  const dates = dateRecords(ledger);
  const entry = resolvePeroduaDate(dates, date);
  if (!entry) throw Object.assign(new Error('Saved Perodua date not found.'), { statusCode: 404 });
  const deletedExports = exportsFor(ledger, entry);
  // Validate every generated filename before changing either files or SQLite.
  const files: string[] = [];
  for (const exported of deletedExports) files.push((await savedPeroduaExport(dataDir, exported.id))!.path);
  const exportIds = new Set(deletedExports.map(value => value.id));
  const remainingDates = dates.filter(value => (value.id ?? value.date) !== (entry.id ?? entry.date));
  const remainingExports = (ledger.exports ?? []).filter(value => !exportIds.has(value.id));
  const retainedKeys = new Set([...remainingDates.flatMap(value => value.document_keys), ...remainingExports.flatMap(value => value.document_keys)]);
  const removedKeys = new Set(entry.document_keys.filter(key => !retainedKeys.has(key)));
  const updated: Ledger = { ...ledger, dates: remainingDates, exports: remainingExports,
    documents: ledger.documents.filter(value => !removedKeys.has(value.key)) };
  return removeHistoryFiles(files, async () => {
    writePeroduaLedger(dataDir, updated);
    return { id: entry.id ?? entry.date, date: entry.date, document_keys: entry.document_keys, removed_document_keys: [...removedKeys], export_ids: [...exportIds] };
  });
}

export async function peroduaReview(dataDir: string, settingsPath: string) {
  const ledger: Ledger = readPeroduaLedger(dataDir);
  const documents = ledger.documents.map(entry => {
    const codes = [...new Set(entry.data.Item.map(item => item.back_no.toUpperCase()))];
    const exported = Array.isArray(entry.rows);
    return {
      key: entry.key, source_file: entry.source_file, pido: entry.data.PIDO,
      delivery_date: entry.data.delivery_date, delivery_time: entry.data.delivery_time, delivery_trip: entry.data.delivery_trip,
      item_count: entry.data.Item.length, exported, codes,
      missing_models: [] as string[],
    };
  });
  return { first_serials: [], models: {}, last_used: ledger.last_used,
    documents, dates: savedDates(ledger), today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), exports: ledger.exports ?? [], missing_models: [...new Set(documents.flatMap(entry => entry.missing_models))] };
}
