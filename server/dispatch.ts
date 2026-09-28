/** New uploads choose a shift; the time-based fallback keeps older saved jobs readable. */
export function dispatchSession(createdAt: string, selectedShift?: 'morning' | 'evening') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(createdAt)).map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    shift: selectedShift ?? (Number(parts.hour) >= 17 ? 'evening' as const : 'morning' as const),
  };
}
