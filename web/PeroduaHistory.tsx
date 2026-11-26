import React, { useState } from 'react';
import type { PeroduaDocument } from './perodua-types';
import type { SavedDate } from './SavedDateCard';
import { dateLabel } from './SavedDateCard';

export function PeroduaHistory({ documents, dates, onUpdated }: { documents: PeroduaDocument[]; dates: SavedDate[]; onUpdated?: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const processPending = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/perodua/generate', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToyotaPO' },
        body: JSON.stringify({ document_keys: pending.map(entry => entry.key), serials: ['', '', ''] }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not process pending POs.');
      await onUpdated?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const included = new Set(dates.flatMap(entry => entry.document_keys ?? []));
  const pending = documents.filter(entry => !included.has(entry.key));
  if (!pending.length) return null;
  const trips = new Set(pending.filter(entry => entry.delivery_trip).map(entry => `${entry.delivery_date}|${entry.delivery_trip}`));
  return <section aria-label="Pending Perodua POs"><article className="date-card">
    <strong>PERODUA · Waiting to save to a date</strong>
    <small>{pending.length} PO pending · {trips.size} delivery trips</small>
    <details><summary>View pending POs</summary>{pending.map(entry => <p key={entry.key}>
      PIDO {entry.pido} · {dateLabel(entry.delivery_date)} · {entry.delivery_trip ? `Trip ${entry.delivery_trip}` : 'Trip unavailable'}
      <br /><small>{entry.source_file}</small>
    </p>)}</details>
    {error && <p role="alert" className="error">{error}</p>}
    <button type="button" className="outline" disabled={busy} onClick={() => void processPending()}>{busy ? 'Processing…' : 'Process pending POs'}</button>
  </article></section>;
}
