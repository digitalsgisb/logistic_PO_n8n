import { config, checkConfig } from './config.ts';
import { buildApp } from './app.ts';
import fs from 'node:fs/promises';
checkConfig();
await fs.access(config.template);
const { app, engine } = await buildApp();
engine.recover();
const timer = setInterval(() => void engine.tick().catch((e) => app.log.error(e)), 1500);
timer.unref();
await app.listen({ port: config.port, host: config.host });
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  });
