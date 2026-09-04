import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Job } from './types.ts';
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);',
    );
  }
  save(job: Job) {
    job.updated_at = new Date().toISOString();
    this.db
      .prepare('INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(job.id, JSON.stringify(job));
    return job;
  }
  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  all(): Job[] {
    return this.db
      .prepare('SELECT payload FROM jobs ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r.payload)));
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
  }
  close() {
    this.db.close();
  }
}
