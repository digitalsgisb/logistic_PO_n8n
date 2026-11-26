import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export function datedFilename(prefix: string, date: string, copy = 0) {
  if (!/^(?:TOYOTA|PERODUA_(?:PG|PM|PK)(?:_(?:PG|PM|PK))*)$/.test(prefix) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(copy) || copy < 0)
    throw new Error('Invalid export filename.');
  return `${date.split('-').reverse().join('-')}_${prefix}_PO${copy ? ` (${copy})` : ''}.xlsx`;
}

/** COPYFILE_EXCL prevents overwriting even if another process uses the name first. */
export async function saveUniqueWorkbook(source: string, directory: string, prefix: string, date: string) {
  await fs.mkdir(directory, { recursive: true });
  for (let copy = 0; ; copy++) {
    const filename = datedFilename(prefix, date, copy);
    const destination = path.join(directory, filename);
    try { await fs.copyFile(source, destination, constants.COPYFILE_EXCL); return { filename, path: destination }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
