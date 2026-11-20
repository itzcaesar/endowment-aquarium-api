import type { Sql } from 'postgres';

import type { LookupHistory, LookupOutcome, LookupRecord } from './donor-directory.js';

export class PostgresLookupHistory implements LookupHistory {
  public constructor(private readonly sql: Sql) {}

  public async save(record: LookupRecord): Promise<void> {
    await this.sql`
      insert into endowment_lookups (outcome, code, latency_ms, created_at)
      values (${record.outcome}, ${record.code}, ${record.latencyMs}, ${record.at}::timestamptz)`;
  }

  public async load(limit: number) {
    const [rows, totals, lastError] = await Promise.all([
      this.sql<
        { outcome: string; code: string | null; latency_ms: number; created_at: Date | string }[]
      >`select outcome, code, latency_ms, created_at from endowment_lookups
        order by id desc limit ${limit}`,
      this.sql<{ ok: number; not_found: number; error: number }[]>`
        select count(*) filter (where outcome = 'ok')::int as ok,
               count(*) filter (where outcome = 'not_found')::int as not_found,
               count(*) filter (where outcome = 'error')::int as error
        from endowment_lookups`,
      this.sql<{ code: string | null; created_at: Date | string }[]>`
        select code, created_at from endowment_lookups where outcome = 'error'
        order by id desc limit 1`,
    ]);
    const error = lastError[0];
    return {
      recent: rows.reverse().map((row) => ({
        at: new Date(row.created_at).toISOString(),
        outcome: row.outcome as LookupOutcome,
        code: row.code,
        latencyMs: row.latency_ms,
      })),
      totals: {
        ok: totals[0]?.ok ?? 0,
        notFound: totals[0]?.not_found ?? 0,
        error: totals[0]?.error ?? 0,
      },
      lastError: error
        ? { code: error.code ?? 'UNKNOWN', at: new Date(error.created_at).toISOString() }
        : null,
    };
  }
}
