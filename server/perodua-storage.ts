import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const peroduaSchema = fs.readFileSync(fileURLToPath(new URL('./perodua-schema.sql', import.meta.url)), 'utf8');

function connect(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'jobs.sqlite'));
  db.exec('PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;');
  db.exec(peroduaSchema);
  return db;
}

export function readPeroduaLedger(dataDir: string): any {
  const db = connect(dataDir);
  try {
    const values = (table: string) => db.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.payload)));
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM perodua_meta').all().map(row => [String(row.key), JSON.parse(String(row.value))]));
    return { documents: values('perodua_documents'), dates: values('perodua_batches'), exports: values('perodua_exports'),
      last_used: meta.last_used ?? null, models: meta.models ?? {} };
  } finally { db.close(); }
}

/** Replace only the Perodua ledger in one transaction; Toyota and accounts are untouched. */
export function writePeroduaLedger(dataDir: string, ledger: any) {
  const db = connect(dataDir);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DELETE FROM perodua_batch_documents; DELETE FROM perodua_exports; DELETE FROM perodua_batches; DELETE FROM perodua_documents;');
    for (const entry of ledger.documents) {
      const data = entry.data;
      db.prepare('INSERT INTO perodua_documents VALUES (?,?,?,?,?,?,?)').run(entry.key, String(data.PIDO), data.delivery_date,
        data.delivery_time, data.delivery_trip ?? null, entry.source_file, JSON.stringify(entry));
    }
    const batches = ledger.dates ?? [];
    const ids = new Set(batches.map((entry: any) => entry.id ?? entry.date));
    for (const entry of batches) {
      const id = entry.id ?? entry.date;
      db.prepare('INSERT INTO perodua_batches VALUES (?,?,?,?,?)').run(id, entry.date, entry.family ?? 'MIXED', entry.status, JSON.stringify(entry));
      entry.document_keys.forEach((key: string, index: number) => db.prepare('INSERT INTO perodua_batch_documents VALUES (?,?,?)').run(id, key, index));
    }
    for (const entry of ledger.exports ?? []) db.prepare('INSERT INTO perodua_exports VALUES (?,?,?,?,?,?)').run(entry.id,
      ids.has(entry.collection_id) ? entry.collection_id : null, entry.save_date ?? entry.generated_date, entry.family ?? null, entry.filename, JSON.stringify(entry));
    for (const [key, value] of Object.entries({ initialized: true, last_used: ledger.last_used ?? null, models: ledger.models ?? {} }))
      db.prepare('INSERT INTO perodua_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
