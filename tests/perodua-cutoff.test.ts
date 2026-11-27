import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('PG, PM and PK use the PDF 08:00 cutoff for grouping, filenames and appending', () => {
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, [fileURLToPath(new URL('./test_perodua_cutoff.py', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
});
