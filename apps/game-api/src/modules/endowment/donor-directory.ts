import { AppError } from '../../shared/errors.js';

export interface EndowmentDonor {
  nik: string;
  name: string;
  totalDonation: number;
}

export interface DonorDirectory {
  findByNik(nik: string): Promise<EndowmentDonor>;
}

export interface EndowmentClientOptions {
  baseUrl: string;
  ticket: string;
  timeoutMs: number;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function toSafeAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Accepts both the documented shape (`nik`, `nama`, `total_donasi`) and common
 * aliases (`name`/`full_name`, `total_donation`/`amount`), optionally wrapped in
 * a `{ data: ... }` envelope.
 */
export function normalizeDonorPayload(payload: unknown, expectedNik: string): EndowmentDonor {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(502, 'ENDOWMENT_INVALID_RESPONSE', 'Respons Endowment tidak valid');
  }

  const root = payload as Record<string, unknown>;
  const record =
    root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;

  const nik = firstString(record.nik) ?? expectedNik;
  if (nik !== expectedNik || !/^\d{16}$/.test(nik)) {
    throw new AppError(502, 'ENDOWMENT_INVALID_RESPONSE', 'NIK pada respons Endowment tidak cocok');
  }

  const name = firstString(record.nama, record.name, record.full_name, record.fullName);
  const totalDonation = toSafeAmount(
    record.total_donasi ?? record.total_donation ?? record.totalDonation ?? record.amount,
  );
  if (!name || totalDonation === null) {
    throw new AppError(502, 'ENDOWMENT_INVALID_RESPONSE', 'Data donor Endowment tidak lengkap');
  }

  return { nik, name: name.slice(0, 150), totalDonation };
}

export class HttpDonorDirectory implements DonorDirectory {
  public constructor(private readonly options: EndowmentClientOptions) {}

  public async findByNik(nik: string): Promise<EndowmentDonor> {
    const url = new URL(`/api/v1/donors/${encodeURIComponent(nik)}`, this.options.baseUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.ticket}`,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new AppError(503, 'ENDOWMENT_UNAVAILABLE', 'Layanan Endowment tidak dapat dihubungi');
    }

    if (response.status === 404) {
      throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan di Endowment');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, 'ENDOWMENT_AUTH_FAILED', 'Kredensial API Endowment ditolak');
    }
    if (!response.ok) {
      throw new AppError(503, 'ENDOWMENT_UNAVAILABLE', 'Layanan Endowment sedang bermasalah');
    }

    const payload: unknown = await response.json().catch(() => null);
    return normalizeDonorPayload(payload, nik);
  }
}

export type LookupOutcome = 'ok' | 'not_found' | 'error';

export interface LookupRecord {
  at: string;
  outcome: LookupOutcome;
  code: string | null;
  latencyMs: number;
}

export interface EndowmentHealth {
  status: 'unknown' | 'good' | 'warning' | 'critical';
  host: string;
  totals: { ok: number; notFound: number; error: number };
  window: number;
  p50Ms: number | null;
  p95Ms: number | null;
  lastError: { code: string; at: string } | null;
  recent: LookupRecord[];
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/**
 * Wraps a directory and keeps in-process metrics about real lookups (no NIKs are stored),
 * so the operations dashboard can show upstream health without extra probe calls.
 */
export class InstrumentedDonorDirectory implements DonorDirectory {
  private readonly records: LookupRecord[] = [];
  private readonly totals = { ok: 0, notFound: 0, error: 0 };
  private lastError: { code: string; at: string } | null = null;

  public constructor(
    private readonly inner: DonorDirectory,
    private readonly host: string,
    private readonly capacity = 100,
  ) {}

  public async findByNik(nik: string): Promise<EndowmentDonor> {
    const started = performance.now();
    try {
      const donor = await this.inner.findByNik(nik);
      this.record('ok', null, started);
      return donor;
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'UNEXPECTED_ERROR';
      this.record(code === 'DONOR_NOT_FOUND' ? 'not_found' : 'error', code, started);
      throw error;
    }
  }

  private record(outcome: LookupOutcome, code: string | null, started: number): void {
    const at = new Date().toISOString();
    this.records.push({ at, outcome, code, latencyMs: Math.round(performance.now() - started) });
    if (this.records.length > this.capacity) this.records.shift();
    if (outcome === 'ok') this.totals.ok += 1;
    else if (outcome === 'not_found') this.totals.notFound += 1;
    else {
      this.totals.error += 1;
      this.lastError = { code: code ?? 'UNKNOWN', at };
    }
  }

  public health(): EndowmentHealth {
    const window = this.records.slice(-20);
    const errors = window.filter((item) => item.outcome === 'error').length;
    const status: EndowmentHealth['status'] =
      window.length === 0
        ? 'unknown'
        : errors === 0
          ? 'good'
          : errors / window.length >= 0.5
            ? 'critical'
            : 'warning';
    const latencies = this.records
      .filter((item) => item.outcome !== 'error')
      .map((item) => item.latencyMs)
      .sort((left, right) => left - right);
    return {
      status,
      host: this.host,
      totals: { ...this.totals },
      window: window.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      lastError: this.lastError,
      recent: [...this.records].reverse().slice(0, 15),
    };
  }
}
