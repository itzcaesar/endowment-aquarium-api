import type { Sql } from 'postgres';

export interface CleanupOptions {
  /** Expired or revoked access tokens are kept this long for incident review. */
  tokenGraceDays: number;
  /** Endowment lookup metrics older than this are dropped. */
  lookupRetentionDays: number;
}

export const defaultCleanupOptions: CleanupOptions = { tokenGraceDays: 7, lookupRetentionDays: 90 };

/** Deletes data that only grows and has no further use. Game events and audit entries are kept. */
export async function runCleanup(sql: Sql, now: Date, options = defaultCleanupOptions) {
  const tokenCutoff = new Date(now.getTime() - options.tokenGraceDays * 86_400_000).toISOString();
  const lookupCutoff = new Date(
    now.getTime() - options.lookupRetentionDays * 86_400_000,
  ).toISOString();
  const tokens = await sql`
    delete from access_tokens
    where (expires_at is not null and expires_at < ${tokenCutoff}::timestamptz)
       or (revoked_at is not null and revoked_at < ${tokenCutoff}::timestamptz)`;
  const lookups = await sql`
    delete from endowment_lookups where created_at < ${lookupCutoff}::timestamptz`;
  return { accessTokens: tokens.count, endowmentLookups: lookups.count };
}
