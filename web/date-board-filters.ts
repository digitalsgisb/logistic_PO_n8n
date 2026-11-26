import type { SavedDate } from './SavedDateCard';

export type SortOrder = 'newest' | 'oldest' | 'waiting';
export type CompanyFilter = 'all' | SavedDate['company'];

/** Filter the loaded history in memory, without reading or changing persistence. */
export function filterSavedDates(dates: SavedDate[], company: CompanyFilter, date: string, year: string, sort: SortOrder) {
  return dates.filter(entry => (company === 'all' || entry.company === company) &&
    (!date || entry.date === date) && (year === 'all' || entry.date.startsWith(year + '-'))).sort((a, b) => {
    if (sort === 'waiting') {
      const status = Number(a.status === 'complete') - Number(b.status === 'complete');
      if (status) return status;
    }
    return (sort === 'newest' ? -1 : 1) * a.date.localeCompare(b.date) || a.company.localeCompare(b.company);
  });
}
