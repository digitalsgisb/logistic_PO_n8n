import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Move generated workbooks aside first so a locked file cannot partly delete a date. */
export async function removeHistoryFiles<T>(files: string[], commit: () => T | Promise<T>): Promise<T> {
  const moved: { from: string; temporary: string }[] = [];
  let result: T;
  try {
    for (const from of new Set(files)) {
      const temporary = from + '.delete-' + randomUUID() + '.tmp';
      try { await fs.rename(from, temporary); moved.push({ from, temporary }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    result = await commit();
  } catch (error) {
    for (const file of moved.reverse()) await fs.rename(file.temporary, file.from);
    throw error;
  }
  // The history is already committed. A failed cleanup must not undo that state.
  for (const file of moved) await fs.rm(file.temporary, { force: true }).catch(() => {});
  return result;
}
