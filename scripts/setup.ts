import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const source = await fs.readFile('.env.example', 'utf8');
const env = source
  .replace(/^PILOT_PASSWORD=$/m, 'PILOT_PASSWORD=' + randomBytes(18).toString('base64url'))
  .replace(/^SESSION_SECRET=$/m, 'SESSION_SECRET=' + randomBytes(32).toString('hex'))
  .replace(/^SERVICE_SECRET=$/m, 'SERVICE_SECRET=' + randomBytes(32).toString('hex'));
await fs.writeFile('.env', env, { flag: 'wx', mode: 0o600 });
console.log(
  'Created .env with generated credentials. Open it locally to retrieve the pilot password and service secret. Existing .env files are never overwritten.',
);
