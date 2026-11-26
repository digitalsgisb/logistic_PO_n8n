import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedDateCard } from '../web/SavedDateCard.tsx';
import { PeroduaHistory } from '../web/PeroduaHistory.tsx';

test('PG, PM and PK cards need no export details or number inputs', () => {
  for (const family of ['PG', 'PM', 'PK']) {
    const html = renderToStaticMarkup(React.createElement(SavedDateCard, {
      entry: { company: 'PERODUA', family, status: 'open', date: '2026-11-26', order_count: 1,
        trip_count: 1, order_numbers: [], sources: [], updated_at: '',
        documents: [{ key: 'one', pido: family === 'PK' ? '123' : family + '123', source_file: 'po.pdf', delivery_date: '2026-11-26' }] },
      working: false, change() {},
    }));
    assert.match(html, /Mark date complete/);
    assert.doesNotMatch(html, /<input|<dialog|export details|optional.*numbers|detected/i);
  }
});

test('legacy unsaved POs can be processed directly without a form', () => {
  const html = renderToStaticMarkup(React.createElement(PeroduaHistory, {
    dates: [], documents: [{ key: 'legacy', source_file: 'old.pdf', pido: 'PM1', delivery_date: '2026-11-25',
      delivery_time: '04:55', item_count: 1, exported: false, codes: [], missing_models: [] }],
  }));
  assert.match(html, /Process pending POs/);
  assert.doesNotMatch(html, /<input|<dialog|export details/i);
});
