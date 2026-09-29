import React, { useEffect, useState } from 'react';
import { ExcelDownload } from './ExcelDownload';

type DispatchDate = {
  date: string;
  status: 'open' | 'complete';
  order_count: number;
  order_numbers: string[];
  trips: number[];
  sources: string[];
  updated_at: string;
  reopened_reason?: 'new_po' | 'manual';
};

const label = (date: string) => date.split('-').reverse().join('/');

type SortOrder = 'newest' | 'oldest' | 'waiting';

export function DateBoard({ refreshKey, canClearHistory, onHistoryCleared }: {
  refreshKey: string;
  canClearHistory: boolean;
  onHistoryCleared: () => void;
}) {
  const [dates, setDates] = useState<DispatchDate[]>([]);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [year, setYear] = useState('all');
  const [sort, setSort] = useState<SortOrder>('newest');
  const load = async () => {
    const response = await fetch('/api/dispatch-dates');
    if (!response.ok) throw new Error('Could not load saved order dates.');
    const body = await response.json();
    setDates(body.dates);
    setError('');
  };
  useEffect(() => {
    void load().catch((cause) => setError(cause.message));
  }, [refreshKey]);
  const change = async (entry: DispatchDate) => {
    const complete = entry.status === 'open';
    if (complete && !window.confirm(`All POs for ${label(entry.date)} received and any upload warnings reviewed? This will release its Kanban Excel for download.`)) return;
    setWorking(entry.date);
    setError('');
    try {
      const response = await fetch(`/api/dispatch-dates/${entry.date}/${complete ? 'complete' : 'reopen'}`, {
        method: 'POST', headers: { 'X-Requested-With': 'ToyotaPO' },
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not update this date.');
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setWorking('');
    }
  };
  const clearHistory = async () => {
    if (!window.confirm(`Clear all PO history? This permanently deletes ${dates.length} saved date${dates.length === 1 ? '' : 's'}, all generated Excel files, and previous uploads. User accounts and the Excel template will stay.`)) return;
    setWorking('clear');
    setError('');
    try {
      const response = await fetch('/api/history', {
        method: 'DELETE', headers: { 'X-Requested-With': 'ToyotaPO' },
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not clear history.');
      setDates([]);
      setYear('all');
      onHistoryCleared();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setWorking('');
    }
  };
  const years = [...new Set(dates.map((entry) => entry.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const ordered = dates
    .filter((entry) => year === 'all' || entry.date.startsWith(year + '-'))
    .sort((a, b) => {
      const byYear = (sort === 'oldest' ? 1 : -1) * a.date.slice(0, 4).localeCompare(b.date.slice(0, 4));
      if (byYear) return byYear;
      if (sort === 'waiting') {
        const byStatus = Number(a.status === 'complete') - Number(b.status === 'complete');
        if (byStatus) return byStatus;
      }
      return (sort === 'oldest' ? 1 : -1) * a.date.localeCompare(b.date);
    });
  const grouped = [...new Set(ordered.map((entry) => entry.date.slice(0, 4)))].map((groupYear) => ({
    year: groupYear,
    entries: ordered.filter((entry) => entry.date.startsWith(groupYear + '-')),
  }));
  return (
    <section className="date-board" aria-labelledby="date-board-title">
      <div className="date-board-heading">
        <div>
          <h3 id="date-board-title">Orders by date</h3>
          <p>Each PO is saved under its printed delivery date. Add more PDFs anytime, then mark a date complete when all its POs have arrived.</p>
        </div>
        <button type="button" className="outline" onClick={() => void load().catch((cause) => setError(cause.message))}>Refresh dates</button>
      </div>
      <div className="date-board-toolbar">
        <label>Year
          <select value={year} onChange={(event) => setYear(event.target.value)}>
            <option value="all">All years</option>
            {years.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>Sort dates
          <select value={sort} onChange={(event) => setSort(event.target.value as SortOrder)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="waiting">Waiting first in each year</option>
          </select>
        </label>
        {canClearHistory && <button type="button" className="clear-history" disabled={!!working} onClick={() => void clearHistory()}>
          {working === 'clear' ? 'Clearing…' : 'Clear history'}
        </button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!dates.length ? <p>No saved PO dates yet. Upload a PO PDF to start.</p> : (
        grouped.length ? grouped.map((group) => <div className="date-year-group" key={group.year}>
          <h4>{group.year} <small>{group.entries.length} {group.entries.length === 1 ? 'date' : 'dates'}</small></h4>
          <div className="date-board-grid">{group.entries.map((entry) => (
            <article className="date-card" key={entry.date}>
              <div className="date-card-top">
                <div><strong>{label(entry.date)}</strong><small>{entry.order_count} {entry.order_count === 1 ? 'PO' : 'POs'} saved · {entry.trips.map((trip) => `Trip ${trip}`).join(', ')}</small></div>
                <span className={entry.status === 'complete' ? 'date-status complete' : 'date-status'}>
                  {entry.status === 'complete' ? 'Complete' : 'Waiting for more POs'}
                </span>
              </div>
              <details>
                <summary>View saved POs</summary>
                <p>{entry.order_numbers.join(', ')}</p>
                {!!entry.sources.length && <small>From: {entry.sources.join(', ')}</small>}
              </details>
              {entry.status === 'complete' ? (
                <div className="date-card-actions">
                  <ExcelDownload href={`/api/dispatch-dates/${entry.date}/workbook`} date={entry.date} orders={entry.order_count} />
                  <button type="button" className="outline" disabled={!!working} onClick={() => void change(entry)}>Reopen date</button>
                </div>
              ) : (
                <div className="date-card-actions">
                  {entry.reopened_reason === 'new_po' && <p><strong>New or revised PO received.</strong> Check the saved POs and confirm this date again.</p>}
                  <p>Draft Excel saved. Download unlocks when you confirm the date is complete.</p>
                  <button type="button" className="primary" disabled={!!working} onClick={() => void change(entry)}>
                    {working === entry.date ? 'Saving…' : 'Mark date complete'}
                  </button>
                </div>
              )}
            </article>
          ))}</div>
        </div>) : <p>No dates in {year}. Choose another year.</p>
      )}
    </section>
  );
}
