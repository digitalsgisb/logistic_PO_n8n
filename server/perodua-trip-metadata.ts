export function tripSummary(entries: { delivery_date: string; delivery_trip?: number | null }[]) {
  const keys = new Set(entries.filter(entry => Number.isInteger(entry.delivery_trip) && entry.delivery_trip! > 0)
    .map(entry => `${entry.delivery_date}|${entry.delivery_trip}`));
  return { trip_count: keys.size, missing_trip_count: entries.filter(entry => !Number.isInteger(entry.delivery_trip) || entry.delivery_trip! <= 0).length };
}
