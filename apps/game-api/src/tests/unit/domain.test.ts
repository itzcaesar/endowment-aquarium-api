import { describe, expect, it } from 'vitest';

import { calculateHunger, moodForHunger } from '../../modules/fish/hunger-service.js';
import { publicDonorName, toPublicDonor } from '../../modules/donors/privacy-service.js';
import { resolveTier } from '../../modules/tiers/tier-service.js';
import {
  createWebhookSignature,
  verifyWebhookSignature,
} from '../../modules/webhooks/signature-service.js';
import { tierSeed } from '../../db/seed-data.js';
import { appearanceInputSchema, bigAquariumQuerySchema } from '@telu/contracts';
import { toCsv } from '../../modules/admin/csv.js';
import { hourlyBuckets } from '../../modules/dashboard/hourly-buckets.js';

describe('tier resolver', () => {
  it.each([
    [50_000, 'COMMON'],
    [500_000, 'COMMON'],
    [500_001, 'RARE'],
    [5_000_000, 'RARE'],
    [5_000_001, 'EPIC'],
    [25_000_000, 'EPIC'],
    [25_000_001, 'LEGENDARY'],
  ])('%s resolves to %s', (amount, expected) => {
    expect(resolveTier(BigInt(amount), tierSeed)).toMatchObject({ code: expected });
  });

  it('rejects amounts below the Common boundary', () => {
    expect(resolveTier(49_999n, tierSeed)).toBeNull();
  });
});

describe('webhook signature verification', () => {
  const now = new Date('2026-07-20T10:00:00.000Z');
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const body = '{"eventId":"evt_1"}';

  it('accepts a correct signature', () => {
    const signature = createWebhookSignature(body, timestamp, 'secret-1234567890');
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp,
        signature,
        secret: 'secret-1234567890',
        toleranceSeconds: 300,
        now,
      }),
    ).toBe(true);
  });

  it('rejects wrong secrets, modified bodies, old timestamps, malformed hex, and length mismatches', () => {
    const signature = createWebhookSignature(body, timestamp, 'secret-1234567890');
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp,
        signature,
        secret: 'wrong-secret-123456',
        toleranceSeconds: 300,
        now,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: `${body}!`,
        timestamp,
        signature,
        secret: 'secret-1234567890',
        toleranceSeconds: 300,
        now,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp: '1',
        signature,
        secret: 'secret-1234567890',
        toleranceSeconds: 300,
        now,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp,
        signature: 'not-hex',
        secret: 'secret-1234567890',
        toleranceSeconds: 300,
        now,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp,
        signature: signature.slice(2),
        secret: 'secret-1234567890',
        toleranceSeconds: 300,
        now,
      }),
    ).toBe(false);
  });
});

describe('hunger and privacy', () => {
  const now = new Date('2026-07-20T10:00:00.000Z');
  it('decays five points per elapsed hour and never goes below zero', () => {
    expect(calculateHunger(100, new Date('2026-07-20T06:00:00.000Z'), now)).toBe(80);
    expect(calculateHunger(10, new Date('2026-07-20T00:00:00.000Z'), now)).toBe(0);
    expect(calculateHunger(50, new Date('2026-07-20T11:00:00.000Z'), now)).toBe(50);
  });
  it('maps mood boundaries', () => {
    expect(moodForHunger(100)).toBe('happy');
    expect(moodForHunger(70)).toBe('happy');
    expect(moodForHunger(69)).toBe('neutral');
    expect(moodForHunger(30)).toBe('neutral');
    expect(moodForHunger(29)).toBe('hungry');
  });
  it('maps public donor names without exposing email', () => {
    expect(publicDonorName('Caesar', true)).toBe('Caesar');
    expect(publicDonorName('Caesar', false)).toBe('Anonymous Donor');
    expect(
      toPublicDonor({
        displayName: 'Caesar',
        showNamePublicly: true,
        email: 'private@example.com',
      }),
    ).toEqual({ displayName: 'Caesar' });
    expect(
      JSON.stringify(
        toPublicDonor({
          displayName: 'Caesar',
          showNamePublicly: true,
          email: 'private@example.com',
        }),
      ),
    ).not.toContain('private@example.com');
  });
});

describe('contract validation', () => {
  it('rejects invalid appearance and Big Aquarium limits', () => {
    expect(
      appearanceInputSchema.safeParse({ colorCode: 'PURPLE', accessoryCode: 'NONE' }).success,
    ).toBe(false);
    expect(
      appearanceInputSchema.safeParse({ colorCode: 'DEFAULT', accessoryCode: 'CROWN' }).success,
    ).toBe(false);
    expect(bigAquariumQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(bigAquariumQuerySchema.safeParse({ limit: 15 }).success).toBe(true);
  });
});

describe('CSV export', () => {
  it('quotes special characters and neutralises spreadsheet formulas', () => {
    const csv = toCsv(
      ['name', 'note'],
      [
        ['=HYPERLINK("x")', 'a,b'],
        ['Dewi "D" Lestari', null],
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'name,note',
      `"'=HYPERLINK(""x"")","a,b"`,
      '"Dewi ""D"" Lestari",',
      '',
    ]);
  });
});

describe('hourly buckets', () => {
  it('returns 24 buckets ending with the current hour', () => {
    const now = new Date('2026-11-20T12:30:00.000Z');
    const buckets = hourlyBuckets(now, [
      new Date('2026-11-20T12:05:00.000Z'),
      new Date('2026-11-20T11:59:00.000Z'),
      new Date('2026-11-19T12:59:00.000Z'),
      new Date('2026-11-19T11:59:00.000Z'),
    ]);
    expect(buckets).toHaveLength(24);
    expect(buckets.at(-1)).toEqual({ hour: '2026-11-20T12:00:00.000Z', count: 1 });
    expect(buckets.at(-2)?.count).toBe(1);
    expect(buckets[0]).toEqual({ hour: '2026-11-19T13:00:00.000Z', count: 0 });
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
  });
});
