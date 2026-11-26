import fs from 'node:fs/promises';
import path from 'node:path';

/** Called once per processed document, never by polling or downloads. */
export async function logScan(dataDir: string, jobId: string, fileId: string, result: unknown) {
  const json = JSON.stringify(result, null, 2);
  console.log(`\n[DOCUMENT SCAN]\n${json}\n[/DOCUMENT SCAN]\n`);
  const directory = path.join(dataDir, jobId, 'scans');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${fileId}.json`), json + '\n');
  await fs.appendFile(path.join(dataDir, 'scans.jsonl'), JSON.stringify(result) + '\n');
}
