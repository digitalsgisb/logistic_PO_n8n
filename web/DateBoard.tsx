import React, { useEffect, useState } from 'react';
import { PeroduaHistory } from './PeroduaHistory';
import { CompanyFilters } from './CompanyFilters';
import type { PeroduaDocument } from './perodua-types';
import { SavedDateCard, dateLabel } from './SavedDateCard';
import type { SavedDate } from './SavedDateCard';
import { filterSavedDates } from './date-board-filters';
import type { CompanyFilter, SortOrder } from './date-board-filters';

export function DateBoard({ refreshKey, canClearHistory, onHistoryCleared, onUpdated, jobId, disabled = false }: {
  refreshKey: string; canClearHistory: boolean; onHistoryCleared?: () => void; onUpdated?: () => Promise<void> | void;
  jobId?: string; disabled?: boolean;
}) {
  const [dates, setDates] = useState<SavedDate[]>([]);
  const [perodua, setPerodua] = useState<PeroduaDocument[]>([]);
  const [working, setWorking] = useState(''), [error, setError] = useState('');
  const [year, setYear] = useState('all'), [sort, setSort] = useState<SortOrder>('oldest');
  const [company, setCompany] = useState<CompanyFilter>('all'), [chosenDate, setChosenDate] = useState('');
  const [loading, setLoading] = useState(true);
  const resetFilters = () => { setCompany('all'); setChosenDate(''); setYear('all'); };
  const load = async () => {
    setLoading(true);
    try {
      if (jobId) {
        const response = await fetch(`/api/jobs/${jobId}/saved-dates`);
        if (!response.ok) throw new Error((await response.json()).error ?? 'Could not load this batch’s saved orders.');
        const data = await response.json();
        setDates(data.dates); setPerodua([]); setError('');
        return;
      }
      const [response, peroduaResponse] = await Promise.all([fetch('/api/dispatch-dates'), fetch('/api/perodua')]);
      if (!response.ok || !peroduaResponse.ok) throw new Error('Could not load saved order dates.');
      const [toyota, saved] = await Promise.all([response.json(), peroduaResponse.json()]);
      setDates([...toyota.dates.map((entry: SavedDate) => ({ ...entry, company: 'TOYOTA' })), ...(saved.dates ?? [])]);
      setPerodua(saved.documents); setError('');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, [refreshKey, jobId]);
  const change = async (entry: SavedDate) => {
    const complete = entry.status === 'open';
    if (complete && !window.confirm(`All POs for ${entry.filename ?? entry.company + ' ' + dateLabel(entry.date)} received and upload warnings reviewed? This will release this batch's Excel for download.`)) return;
    setWorking(entry.company + entry.date); setError('');
    try {
      const base = entry.company === 'PERODUA' ? '/api/perodua/dates' : '/api/dispatch-dates';
      const response = await fetch(`${base}/${entry.id ?? entry.date}/${complete ? 'complete' : 'reopen'}`, {
        method: 'POST', headers: { 'X-Requested-With': 'ToyotaPO' },
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not update this date.');
      await load(); await onUpdated?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setWorking(''); }
  };
  const removeDate = async (entry: SavedDate) => {
    if (!window.confirm(`Delete ${entry.filename ?? entry.company + ' ' + dateLabel(entry.date)}? This removes only this batch and its Excel versions. Other batches stay saved.`)) return;
    setWorking(entry.company + entry.date); setError('');
    try {
      const base = entry.company === 'PERODUA' ? '/api/perodua/dates' : '/api/dispatch-dates';
      const response = await fetch(`${base}/${entry.id ?? entry.date}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToyotaPO' } });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not delete this date.');
      await load(); await onUpdated?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setWorking(''); }
  };
  const clearHistory = async () => {
    if (!window.confirm('Clear all PO history? This permanently deletes saved dates, generated Excel files and previous uploads. Test settings and the Excel template will stay.')) return;
    setWorking('clear'); setError('');
    try {
      const response = await fetch('/api/history', { method: 'DELETE', headers: { 'X-Requested-With': 'ToyotaPO' } });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not clear history.');
      setDates([]); setPerodua([]); resetFilters(); onHistoryCleared?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setWorking(''); }
  };
  const years = [...new Set([...dates.map(entry => entry.date.slice(0, 4)), ...(year === 'all' ? [] : [year])])].sort((a, b) => b.localeCompare(a));
  const ordered = filterSavedDates(dates, company, chosenDate, year, sort);
  const hasFilters = company !== 'all' || !!chosenDate || year !== 'all';
  // Legacy pending POs have no saved-entry date yet, so only show them in an unfiltered date view.
  const showPending = company !== 'TOYOTA' && !chosenDate && year === 'all';
  const peroduaDates = dates.filter(entry => entry.company === 'PERODUA');
  const headingId = jobId ? 'dispatch-date-board-title' : 'date-board-title';
  return <section className="date-board" aria-labelledby={headingId} aria-busy={loading}>
    <div className="date-board-heading"><div><h3 id={headingId}>{jobId ? 'This batch’s saved orders' : 'Orders by date'}</h3>
      {jobId && <p>Review the saved POs, mark each entry complete and download its Excel here.</p>}</div>
      <button type="button" className="outline" disabled={loading} onClick={() => void load().catch(cause => setError(cause.message))}>{jobId ? 'Refresh batch' : 'Refresh dates'}</button>
    </div>
    {!jobId && <div className="date-board-toolbar">
      <CompanyFilters company={company} onCompany={setCompany} onClear={resetFilters} />
      <label>Choose date<input type="date" value={chosenDate} onChange={event => {
        const value = event.target.value; setChosenDate(value);
        if (value) setYear(value.slice(0, 4));
      }} /></label>
      <label>Year<select value={year} onChange={event => {
        const value = event.target.value; setYear(value);
        if (value !== 'all' && chosenDate && !chosenDate.startsWith(value + '-')) setChosenDate('');
      }}><option value="all">All years</option>
        {years.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Sort dates<select value={sort} onChange={event => setSort(event.target.value as SortOrder)}>
        <option value="oldest">Oldest first</option><option value="newest">Newest first</option><option value="waiting">Waiting first</option>
      </select></label>
      {canClearHistory && <button type="button" className="clear-history" disabled={!!working} onClick={() => void clearHistory()}>{working === 'clear' ? 'Clearing…' : 'Clear history'}</button>}
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {!jobId && showPending && <PeroduaHistory documents={perodua} dates={peroduaDates} onUpdated={async () => { await load(); await onUpdated?.(); }} />}
    {loading && !dates.length ? <p role="status">Loading saved orders…</p> : !dates.length && !perodua.length ? <p>{jobId ? 'No saved entries for this batch yet. Check document errors above or retry unsuccessful POs.' : 'No saved PO dates yet. Upload a PO PDF to start.'}</p> : !ordered.length && (!!dates.length || hasFilters) ? <p>No saved orders match these filters.</p> :
      <div className="date-board-grid">{ordered.map(entry => <SavedDateCard key={entry.company + (entry.id ?? entry.date)} entry={entry} working={!!working || loading || disabled}
        change={() => void change(entry)}
        remove={canClearHistory ? () => void removeDate(entry) : undefined}
        add={entry.company === 'PERODUA' ? () => window.dispatchEvent(new CustomEvent('add-perodua-pos', { detail: { date: entry.date, entry_id: entry.id } })) : undefined} />)}</div>}
  </section>;
}
