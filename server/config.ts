import path from 'node:path';
function positive(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive`);
  return n;
}
export const config = {
  port: positive('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  template: path.resolve(process.env.TEMPLATE_PATH ?? 'templates/toyota.xlsx'),
  username: process.env.PILOT_USERNAME ?? 'pilot',
  password: process.env.PILOT_PASSWORD ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  serviceSecret: process.env.SERVICE_SECRET ?? '',
  secureCookie: process.env.COOKIE_SECURE === 'true',
  n8nWebhook: process.env.N8N_WEBHOOK_URL ?? '',
  maxFiles: positive('MAX_FILES', 20),
  maxFileBytes: positive('MAX_FILE_MB', 20) * 1024 ** 2,
  maxBatchBytes: positive('MAX_BATCH_MB', 100) * 1024 ** 2,
  maxPages: positive('MAX_PAGES_PER_FILE', 100),
  retentionDays: positive('RETENTION_DAYS', 7),
  staleMinutes: positive('JOB_TIMEOUT_MINUTES', 15),
};
export function checkConfig() {
  if (config.password.length < 12 || config.sessionSecret.length < 32 || config.serviceSecret.length < 32)
    throw new Error(
      'Set PILOT_PASSWORD (12+ characters), SESSION_SECRET and SERVICE_SECRET (32+ characters) in the environment.',
    );
  if (!config.n8nWebhook) throw new Error('N8N_WEBHOOK_URL is required.');
}
