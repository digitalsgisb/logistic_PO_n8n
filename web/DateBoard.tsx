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

export function DateBoard({ refreshKey }: { refreshKey: string }) {
  const [dates, setDates] = useState<DispatchDate[]>([]);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    const response = await fetch('/api/dispatch-dates');
    if (!response.ok) throw new Error('Could not load saved order dates.');
    const body = await response.json();
    setDates(body.dates.sort((a: DispatchDate, b: DispatchDate) =>
      Number(a.status === 'complete') - Number(b.status === 'complete') || b.date.localeCompare(a.date)));
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
  return (
    <section className="date-board" aria-labelledby="date-board-title">
      <div className="date-board-heading">
        <div>
          <h3 id="date-board-title">Orders by date</h3>
          <p>POs are saved under the delivery date printed on each page. Add more PDFs anytime. When all POs for a date have arrived, mark that date complete to release its Excel. Dates still waiting for POs appear first.</p>
        </div>
        <button type="button" className="outline" onClick={() => void load().catch((cause) => setError(cause.message))}>Refresh dates</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!dates.length ? <p>No saved PO dates yet. Upload a PO PDF to start.</p> : (
        <div className="date-board-grid">
          {dates.map((entry) => (
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
          ))}
        </div>
      )}
    </section>
  );
}
