-- Additive Perodua storage in the existing jobs.sqlite database.
-- Toyota jobs, dispatch_dates, users, sessions and app_meta are unchanged.
CREATE TABLE IF NOT EXISTS perodua_documents (
  document_key TEXT PRIMARY KEY,
  pido TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  delivery_time TEXT NOT NULL,
  delivery_trip INTEGER,
  source_file TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS perodua_documents_pido ON perodua_documents(pido);
CREATE TABLE IF NOT EXISTS perodua_batches (
  id TEXT PRIMARY KEY,
  save_date TEXT NOT NULL,
  family TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'complete')),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS perodua_batches_date ON perodua_batches(save_date);
CREATE TABLE IF NOT EXISTS perodua_batch_documents (
  batch_id TEXT NOT NULL REFERENCES perodua_batches(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL REFERENCES perodua_documents(document_key),
  position INTEGER NOT NULL,
  PRIMARY KEY (batch_id, document_key)
);
CREATE TABLE IF NOT EXISTS perodua_exports (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES perodua_batches(id) ON DELETE CASCADE,
  save_date TEXT NOT NULL,
  family TEXT,
  filename TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS perodua_exports_batch ON perodua_exports(batch_id);
CREATE TABLE IF NOT EXISTS perodua_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
