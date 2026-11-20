const HOUR_MS = 60 * 60 * 1000;

/** Builds 24 hourly buckets ending with the hour that contains `now`, oldest first. */
export function hourlyBuckets(
  now: Date,
  timestamps: Iterable<Date>,
): Array<{ hour: string; count: number }> {
  const currentHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const first = currentHour - 23 * HOUR_MS;
  const counts = new Array<number>(24).fill(0);
  for (const timestamp of timestamps) {
    const index = Math.floor((timestamp.getTime() - first) / HOUR_MS);
    if (index >= 0 && index < 24) counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts.map((count, index) => ({
    hour: new Date(first + index * HOUR_MS).toISOString(),
    count,
  }));
}
