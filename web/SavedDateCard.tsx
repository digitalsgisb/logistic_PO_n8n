import React from 'react';
import { ExcelDownload } from './ExcelDownload';

export type SavedDate = {
  id?: string; family?: string; filename?: string;
  versions?: { id: string; filename: string; created_at: string }[];
  company: 'PERODUA' | 'TOYOTA'; date: string; status: 'open' | 'complete';
  order_count: number; trip_count: number; missing_trip_count?: number;
  order_numbers: string[]; sources: string[]; updated_at: string; reopened_reason?: string;
  document_keys?: string[]; serials?: string[];
  documents?: { key: string; pido: string; source_file: string; delivery_date: string; delivery_trip?: number | null }[];
};
export const dateLabel = (date: string) => date.split('-').reverse().join('/');
export const familyLabel = (family?: string) => family === 'PM_PK' ? 'PM & PK' : family;
export const savedCounts = (orders: number, trips: number) => `${orders} PO saved · ${trips} delivery trips`;

/** Toyota and Perodua share the same date card and completion controls. */
export function SavedDateCard({ entry, working, change, add, remove }: {
  entry: SavedDate; working: boolean; change: () => void; add?: () => void; remove?: () => void;
}) {
  const base = entry.company === 'PERODUA' ? '/api/perodua/dates' : '/api/dispatch-dates';
  const key = entry.id ?? entry.date;
  return <article className="date-card" data-company={entry.company} data-save-date={entry.date}>
    <div className="date-card-top">
      <div><strong>{dateLabel(entry.date)} - {entry.company}{entry.family ? ` ${familyLabel(entry.family)}` : ''}</strong>
        {entry.filename && <small>{entry.filename}</small>}
        <small>{savedCounts(entry.order_count, entry.trip_count)}</small></div>
      <span className={entry.status === 'complete' ? 'date-status complete' : 'date-status'}>
        {entry.status === 'complete' ? 'Complete' : 'Waiting for more POs'}
      </span>
    </div>
    <details><summary>View saved POs</summary>
      {entry.documents ? entry.documents.map(document => <p key={document.key}>
        PIDO {document.pido} · {dateLabel(document.delivery_date)} · {document.delivery_trip ? `Trip ${document.delivery_trip}` : 'Trip unavailable'}
        <br /><small>{document.source_file}</small>
      </p>) : <><p>{entry.order_numbers.join(', ')}</p>
        {!!entry.sources.length && <small>From: {entry.sources.join(', ')}</small>}</>}
    </details>
    {!!entry.missing_trip_count && <p className="tag-warning">Delivery Trip unavailable for {entry.missing_trip_count} PO. These POs follow the numbered trips on their delivery date.</p>}
    <div className="date-card-actions">
      {entry.status === 'complete' ? <>
        <ExcelDownload href={`${base}/${key}/workbook`} date={entry.date} orders={entry.order_count}
          label={entry.company === 'PERODUA' ? 'Download Perodua Excel' : undefined} />
        <button type="button" className="outline" disabled={working} onClick={change}>Reopen date</button>
      </> : <>
        {entry.reopened_reason === 'new_po' && <p><strong>New PO received.</strong> Review the saved POs and confirm this date again.</p>}
        {add && <button type="button" className="outline" disabled={working} onClick={add}>Add POs to this date</button>}
        <button type="button" className="primary" disabled={working} onClick={change}>{working ? 'Saving…' : 'Mark date complete'}</button>
      </>}
      {remove && <button type="button" className="clear-history" disabled={working} onClick={remove}
        aria-label={`Delete ${entry.company} history for ${dateLabel(entry.date)}`}>Delete date</button>}
    </div>
  </article>;
}
