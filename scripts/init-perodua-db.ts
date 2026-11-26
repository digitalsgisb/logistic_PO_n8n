import path from 'node:path';
import { config } from '../server/config.ts';
import { Store } from '../server/store.ts';

// Schema creation is idempotent and requires no login or n8n connection.
const store = new Store(config.dataDir);
try {
  console.log(path.join(config.dataDir, 'jobs.sqlite'));
  console.log(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'perodua_%' ORDER BY name").all());
} finally { store.close(); }
