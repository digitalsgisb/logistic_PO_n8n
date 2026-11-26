import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from './config.ts';
import type { PeroduaOutput } from './types.ts';

const run = promisify(execFile);

/** Read the original PDF in Python; PDF.js text is used only for routing. */
export async function processPerodua(
  file: { path: string; filename: string },
  dataDir: string,
  outputDir: string,
  settingsPath = config.peroduaSettingsPath,
): Promise<PeroduaOutput> {
  const stateDir = path.resolve(dataDir, 'perodua');
  return runPython([
    '--extract-only', '--pdf', path.resolve(file.path), '--source-name', file.filename,
    '--output-dir', path.resolve(outputDir), '--state-dir', stateDir,
    '--settings', settingsPath,
  ]);
}

export function generatePerodua(dataDir: string, settingsPath: string, selection: { jsonPaths?: string[]; keys?: string[]; serials: string[]; saveDate?: string; saveId?: string; batchId?: string }) {
  return runPython(['--generate-only', '--date-action', 'save', '--state-dir', path.resolve(dataDir, 'perodua'), '--settings', settingsPath,
    ...(selection.saveDate ? ['--save-date', selection.saveDate] : []),
    ...(selection.saveId ? ['--save-id', selection.saveId] : []),
    ...(selection.batchId ? ['--batch-id', selection.batchId] : []),
    ...(selection.jsonPaths ?? []).flatMap(file => ['--document-json', file]),
    ...(selection.keys ?? []).flatMap(key => ['--document-key', key]),
    ...selection.serials.flatMap(value => ['--serial', value]),
  ]);
}

export function changePeroduaDate(dataDir: string, settingsPath: string, date: string, action: 'complete' | 'reopen') {
  return runPython(['--generate-only', '--date-action', action, '--save-id', date,
    '--state-dir', path.resolve(dataDir, 'perodua'), '--settings', settingsPath]);
}

async function runPython(args: string[]): Promise<PeroduaOutput> {
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const script = fileURLToPath(new URL('./perodua_cli.py', import.meta.url));
  try {
    const { stdout } = await run(python, [script, '--database', path.resolve(args[args.indexOf('--state-dir') + 1], '..', 'jobs.sqlite'), ...args], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const output = JSON.parse(stdout) as PeroduaOutput;
    if (!output || !['ready', 'review', 'extracted'].includes(output.status) ||
        typeof output.pido !== 'string' || typeof output.json_path !== 'string' ||
        (output.status === 'ready' && !output.date && (typeof output.path !== 'string' || typeof output.filename !== 'string')) ||
        (output.status === 'review' && typeof output.error !== 'string'))
      throw new Error('Python returned an invalid Perodua result.');
    return output;
  } catch (error) {
    const failure = error as Error & { code?: string; stderr?: string; killed?: boolean };
    if (failure.code === 'ENOENT')
      throw new Error('Python was not found. Install Python or set PYTHON_BIN to its executable path.');
    if (failure.killed) throw new Error('Perodua processing exceeded the 120-second limit.');
    throw new Error(failure.stderr?.trim() || failure.message || 'Perodua processing failed.');
  }
}
