import React from 'react';

export function ExcelDownload({
  href,
  date,
  orders,
  files,
}: {
  href: string;
  date?: string;
  orders?: number;
  files?: number;
}) {
  const label = files ? 'Download all Excel files' : 'Download Excel';
  const detail = files
    ? `${files} workbooks · ZIP file`
    : [
        date?.split('-').reverse().join('/'),
        orders !== undefined ? `${orders} ${orders === 1 ? 'order' : 'orders'}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
  return (
    <a
      className="daily-download excel-download"
      href={href}
      aria-label={`${label}${detail ? ' — ' + detail : ''}`}
    >
      <svg className="excel-icon" viewBox="0 0 32 32" width="32" height="32" fill="none" aria-hidden="true">
        <rect x="10" y="3" width="19" height="26" rx="3" fill="currentColor" opacity=".2" />
        <path d="M17 10h8M17 16h8M17 22h8M21 7v18" stroke="currentColor" strokeWidth="1.4" />
        <rect x="2" y="8" width="16" height="17" rx="2" fill="currentColor" />
        <path d="m7 12 6 9m0-9-6 9" stroke="#107c41" strokeWidth="2" />
      </svg>
      <span className="excel-download-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <svg
        className="excel-download-arrow"
        viewBox="0 0 24 24"
        width="21"
        height="21"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </svg>
    </a>
  );
}
