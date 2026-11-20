import { createHash, timingSafeEqual } from 'node:crypto';

/** Shape returned by the (mock) Endowment donor lookup, matching the agreed spec. */
export interface MockEndowmentDonor {
  nik: string;
  nama: string;
  total_donasi: number;
}

/** Deterministic fixtures covering every tier, so the game can be tested without setup. */
export const seededDonors: readonly MockEndowmentDonor[] = [
  { nik: '3171010101010001', nama: 'Andi Pratama', total_donasi: 50_000 },
  { nik: '3171010101010002', nama: 'Budi Santoso', total_donasi: 1_000_000 },
  { nik: '3171010101010003', nama: 'Citra Ayu', total_donasi: 10_000_000 },
  { nik: '3171010101010004', nama: 'Dewi Lestari', total_donasi: 30_000_000 },
  { nik: '3171010101010005', nama: 'Eko Saputra', total_donasi: 5_000 },
];

export class MockDonorDirectory {
  private readonly donors = new Map<string, MockEndowmentDonor>();

  public constructor(initial: readonly MockEndowmentDonor[] = seededDonors) {
    for (const donor of initial) this.donors.set(donor.nik, { ...donor });
  }

  public get(nik: string): MockEndowmentDonor | undefined {
    const donor = this.donors.get(nik);
    return donor ? { ...donor } : undefined;
  }

  public upsert(donor: MockEndowmentDonor): MockEndowmentDonor {
    this.donors.set(donor.nik, { ...donor });
    return { ...donor };
  }

  public list(): MockEndowmentDonor[] {
    return [...this.donors.values()].map((donor) => ({ ...donor }));
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Accepts `Authorization: Bearer <ticket>` or `X-API-Key: <ticket>`, compared in constant time. */
export function isAuthorizedTicket(
  headers: Record<string, string | string[] | undefined>,
  ticket: string,
): boolean {
  const authorization = headers.authorization;
  const apiKey = headers['x-api-key'];
  let supplied: string | null = null;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    supplied = authorization.slice('Bearer '.length).trim();
  } else if (typeof apiKey === 'string') {
    supplied = apiKey.trim();
  }
  if (!supplied) return false;
  return timingSafeEqual(digest(supplied), digest(ticket));
}
