import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompanyFilters } from '../web/CompanyFilters.tsx';

test('company filters use the three supplied images with accessible buttons and no dropdown', () => {
  const html = renderToStaticMarkup(React.createElement(CompanyFilters, { company: 'all', onCompany() {}, onClear() {} }));
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  for (const label of ['Filter Perodua', 'Filter Toyota', 'Clear filters']) assert.ok(html.includes(`aria-label="${label}"`));
  for (const file of ['company-perodua.png', 'company-toyota.png', 'clear-filters.png']) assert.ok(html.includes(file));
  assert.doesNotMatch(html, /<select/);
});

test('each company button exposes its current selected state', () => {
  for (const company of ['PERODUA', 'TOYOTA'] as const) {
    const html = renderToStaticMarkup(React.createElement(CompanyFilters, { company, onCompany() {}, onClear() {} }));
    const buttons = html.match(/<button\b[^>]*>/g)!;
    assert.equal(buttons.filter(button => button.includes('aria-pressed="true"')).length, 1);
    assert.ok(buttons.find(button => button.includes(company === 'PERODUA' ? 'Filter Perodua' : 'Filter Toyota'))!.includes('aria-pressed="true"'));
  }
});
