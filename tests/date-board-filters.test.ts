import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSavedDates } from '../web/date-board-filters.ts';
import type { SavedDate } from '../web/SavedDateCard';

const entry = (id: string, date: string, company: SavedDate['company'], status: SavedDate['status']): SavedDate => ({
  id, date, company, status, order_count: 1, trip_count: 1, order_numbers: [], sources: [], updated_at: '',
});
const history = [entry('pm', '2026-11-26', 'PERODUA', 'complete'), entry('old', '2025-11-26', 'TOYOTA', 'open'),
  entry('pg', '2026-11-26', 'PERODUA', 'open'), entry('toyota', '2026-11-26', 'TOYOTA', 'open'),
  entry('next', '2026-12-01', 'TOYOTA', 'complete')];
const ids = (entries: SavedDate[]) => entries.map(entry => entry.id);

test('company, exact card date and year filters work together and keep duplicate-date batches', () => {
  assert.deepEqual(ids(filterSavedDates(history, 'PERODUA', '2026-11-26', '2026', 'oldest')), ['pm', 'pg']);
  assert.deepEqual(ids(filterSavedDates(history, 'TOYOTA', '2026-11-26', '2026', 'oldest')), ['toyota']);
  assert.deepEqual(ids(filterSavedDates(history, 'all', '', '2025', 'oldest')), ['old']);
  assert.deepEqual(ids(filterSavedDates(history, 'PERODUA', '2026-12-01', 'all', 'oldest')), []);
});

test('existing date sorts and waiting-first order work in memory without changing source history', () => {
  const before = structuredClone(history);
  assert.deepEqual(ids(filterSavedDates(history, 'all', '', 'all', 'oldest')), ['old', 'pm', 'pg', 'toyota', 'next']);
  assert.deepEqual(ids(filterSavedDates(history, 'all', '', 'all', 'newest')), ['next', 'pm', 'pg', 'toyota', 'old']);
  assert.deepEqual(ids(filterSavedDates(history, 'all', '', 'all', 'waiting')), ['old', 'pg', 'toyota', 'pm', 'next']);
  assert.deepEqual(history, before);
});
