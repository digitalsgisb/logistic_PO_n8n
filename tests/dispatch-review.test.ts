import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DateBoard } from '../web/DateBoard.tsx';

test('dispatch saved-order board focuses on completion without global history tools', () => {
  const html = renderToStaticMarkup(React.createElement(DateBoard, {
    jobId: 'batch-1', refreshKey: 'batch-1:completed', canClearHistory: false, onUpdated() {},
  }));
  assert.match(html, /dispatch-date-board-title/);
  assert.match(html, /This batch’s saved orders/);
  assert.match(html, /mark each entry complete and download its Excel here/);
  assert.match(html, /Refresh batch/);
  assert.doesNotMatch(html, /Clear history|Sort dates|Refresh dates/);
});

test('full history retains its filters and controls separately from dispatch review', () => {
  const html = renderToStaticMarkup(React.createElement(DateBoard, {
    refreshKey: '', canClearHistory: true, onHistoryCleared() {},
  }));
  assert.match(html, /Sort dates|Refresh dates/);
  assert.match(html, /Clear history/);
  const fields = ['Company', 'Choose date', '>Year', 'Sort dates'];
  for (let i = 1; i < fields.length; i++) assert.ok(html.indexOf(fields[i - 1]) < html.indexOf(fields[i]));
  assert.match(html, /type="date"/);
  assert.match(html, /aria-label="Filter Toyota"/);
  assert.match(html, /aria-label="Filter Perodua"/);
  assert.match(html, /aria-label="Clear filters"/);
  assert.equal((html.match(/<select/g) ?? []).length, 2);
  for (const option of ['Oldest first', 'Newest first', 'Waiting first']) assert.ok(html.includes(option));
  assert.doesNotMatch(html, /dispatch-date-board-title/);
});
