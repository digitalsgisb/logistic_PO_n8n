import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Job } from './types.ts';
import { hashPassword, verifyPassword } from './auth.ts';

export interface UserAccount {
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_username ON sessions(username);
    `);
  }

  ensureBootstrapUser(username: string, password: string) {
    const existing = this.db.prepare('SELECT username FROM users WHERE username=?').get(username);
    if (!existing)
      this.db
        .prepare('INSERT INTO users VALUES (?,?,1,?)')
        .run(username, hashPassword(password), new Date().toISOString());
  }

  authenticate(username: string, password: string): UserAccount | undefined {
    const row = this.db
      .prepare('SELECT username,password_hash,is_admin,created_at FROM users WHERE username=?')
      .get(username) as
      | { username: string; password_hash: string; is_admin: number; created_at: string }
      | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) return undefined;
    return { username: row.username, isAdmin: !!row.is_admin, createdAt: row.created_at };
  }

  getUser(username: string): UserAccount | undefined {
    const row = this.db
      .prepare('SELECT username,is_admin,created_at FROM users WHERE username=?')
      .get(username) as { username: string; is_admin: number; created_at: string } | undefined;
    return row && { username: row.username, isAdmin: !!row.is_admin, createdAt: row.created_at };
  }

  listUsers(): UserAccount[] {
    return (
      this.db
        .prepare('SELECT username,is_admin,created_at FROM users ORDER BY username COLLATE NOCASE')
        .all() as {
        username: string;
        is_admin: number;
        created_at: string;
      }[]
    ).map((row) => ({ username: row.username, isAdmin: !!row.is_admin, createdAt: row.created_at }));
  }

  createUser(username: string, password: string) {
    this.db
      .prepare('INSERT INTO users VALUES (?,?,0,?)')
      .run(username, hashPassword(password), new Date().toISOString());
    return this.getUser(username)!;
  }

  updatePassword(username: string, password: string) {
    this.db
      .prepare('UPDATE users SET password_hash=? WHERE username=?')
      .run(hashPassword(password), username);
  }

  deleteUser(username: string) {
    return this.db.prepare('DELETE FROM users WHERE username=?').run(username).changes > 0;
  }

  createSession(username: string) {
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run(tokenHash(token), username, new Date().toISOString());
    return token;
  }

  userForSession(token: string): UserAccount | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare(
        `SELECT u.username,u.is_admin,u.created_at
         FROM sessions s JOIN users u ON u.username=s.username
         WHERE s.token_hash=?`,
      )
      .get(tokenHash(token)) as { username: string; is_admin: number; created_at: string } | undefined;
    return row && { username: row.username, isAdmin: !!row.is_admin, createdAt: row.created_at };
  }

  deleteSession(token: string) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
  }

  deleteOtherSessions(username: string, currentToken: string) {
    this.db
      .prepare('DELETE FROM sessions WHERE username=? AND token_hash<>?')
      .run(username, tokenHash(currentToken));
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
