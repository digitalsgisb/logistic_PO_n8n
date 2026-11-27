import React from 'react';
import type { CompanyFilter } from './date-board-filters';

const peroduaLogo = new URL('./assets/company-perodua.png', import.meta.url).href;
const toyotaLogo = new URL('./assets/company-toyota.png', import.meta.url).href;
const clearIcon = new URL('./assets/clear-filters.png', import.meta.url).href;

export function CompanyFilters({ company, onCompany, onClear }: {
  company: CompanyFilter; onCompany: (company: CompanyFilter) => void; onClear: () => void;
}) {
  return <fieldset className="company-filter-field">
    <legend>Company</legend>
    <div className="company-filter-buttons">
      <button type="button" className="company-filter-button perodua" aria-label="Filter Perodua" title="Perodua"
        aria-pressed={company === 'PERODUA'} onClick={() => onCompany('PERODUA')}>
        <img src={peroduaLogo} alt="" />
      </button>
      <button type="button" className="company-filter-button toyota" aria-label="Filter Toyota" title="Toyota"
        aria-pressed={company === 'TOYOTA'} onClick={() => onCompany('TOYOTA')}>
        <img src={toyotaLogo} alt="" />
      </button>
      <button type="button" className="company-filter-button reset" aria-label="Clear filters" title="Clear filters"
        onClick={onClear}>
        <img src={clearIcon} alt="" />
      </button>
    </div>
  </fieldset>;
}
