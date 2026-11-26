import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { orderPeroduaDocuments } from '../server/perodua-ordering.ts';

test('PG/PM mapping, Excel columns, mixed sheets and reopened dates follow the requested rules', () => {
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, [fileURLToPath(new URL('./test_pg_pm_export.py', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
});

test('history uses the same PM Back No groups and PG numeric trip order as Excel', () => {
  const entry = (id: string, trip: number, name: string, back = 'GCI010') => ({ key: id, data: { PIDO: id,
    delivery_date: '2026-11-25', delivery_time: '08:50', delivery_trip: trip, Item: [{ part_name: name, back_no: back }] } });
  const pm = [entry('PM10', 1, 'COVER', 'GC602'), entry('PM11', 2, 'DIFFERENT PART NAME', 'gc 501'), entry('PM12', 1, 'CARPET', 'GC201'),
    entry('PM13', 3, 'COVER', 'GC602'), entry('PM2', 3, 'CARPET', 'GC501')];
  assert.deepEqual(orderPeroduaDocuments(pm).map(value => value.key), ['PM2', 'PM11', 'PM10', 'PM13', 'PM12']);
  assert.deepEqual(orderPeroduaDocuments([entry('PG1', 12, 'CARPET'), entry('PG20', 2, 'CARPET')]).map(value => value.key), ['PG20', 'PG1']);
});
