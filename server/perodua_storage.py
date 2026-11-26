"""Perodua tables only; the configured production database is jobs.sqlite."""
import json
from pathlib import Path
import sqlite3

_database = None


def configure_database(filename):
    global _database
    _database = Path(filename) if filename else None


def database_path(state_dir):
    return _database or Path(state_dir) / 'perodua.sqlite'


def connection(state_dir):
    filename = database_path(state_dir)
    filename.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(filename, timeout=30)
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(Path(__file__).with_name('perodua-schema.sql').read_text(encoding='utf-8'))
    return db


def load_ledger(state_dir):
    db = connection(state_dir)
    try:
        meta = {key: json.loads(value) for key, value in db.execute('SELECT key,value FROM perodua_meta')}
        legacy = Path(state_dir) / 'state.json'
        if not meta.get('initialized') and legacy.exists():
            # Import legacy Perodua JSON once; leave the original available for review.
            ledger = json.loads(legacy.read_text(encoding='utf-8'))
            save_ledger(state_dir, ledger)
            return ledger
        return {'documents': [json.loads(row[0]) for row in db.execute('SELECT payload FROM perodua_documents ORDER BY rowid')],
                'dates': [json.loads(row[0]) for row in db.execute('SELECT payload FROM perodua_batches ORDER BY rowid')],
                'exports': [json.loads(row[0]) for row in db.execute('SELECT payload FROM perodua_exports ORDER BY rowid')],
                'last_used': meta.get('last_used'), 'models': meta.get('models', {})}
    finally:
        db.close()


def save_ledger(state_dir, ledger):
    db = connection(state_dir)
    encode = lambda value: json.dumps(value, ensure_ascii=False, allow_nan=False)
    try:
        with db:
            db.execute('DELETE FROM perodua_batch_documents')
            db.execute('DELETE FROM perodua_exports')
            db.execute('DELETE FROM perodua_batches')
            db.execute('DELETE FROM perodua_documents')
            for entry in ledger.get('documents', []):
                data = entry['data']
                db.execute('INSERT INTO perodua_documents VALUES (?,?,?,?,?,?,?)',
                           (entry['key'], str(data['PIDO']), data['delivery_date'], data['delivery_time'],
                            data.get('delivery_trip'), entry['source_file'], encode(entry)))
            batches = ledger.get('dates', [])
            ids = {entry.get('id', entry['date']) for entry in batches}
            for entry in batches:
                identity = entry.get('id', entry['date'])
                db.execute('INSERT INTO perodua_batches VALUES (?,?,?,?,?)',
                           (identity, entry['date'], entry.get('family', 'MIXED'), entry['status'], encode(entry)))
                for position, key in enumerate(entry['document_keys']):
                    db.execute('INSERT INTO perodua_batch_documents VALUES (?,?,?)', (identity, key, position))
            for entry in ledger.get('exports', []):
                batch = entry.get('collection_id')
                db.execute('INSERT INTO perodua_exports VALUES (?,?,?,?,?,?)',
                           (entry['id'], batch if batch in ids else None, entry.get('save_date') or entry['generated_date'],
                            entry.get('family'), entry['filename'], encode(entry)))
            for key, value in {'initialized': True, 'last_used': ledger.get('last_used'), 'models': ledger.get('models', {})}.items():
                db.execute('INSERT INTO perodua_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, encode(value)))
    finally:
        db.close()
