import { randomBytes } from 'node:crypto';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createApp } from '../../app.js';
import { hashAccessToken } from '../../modules/auth/token-service.js';
import { createWebhookSignature } from '../../modules/webhooks/signature-service.js';
import type { DonorDirectory, EndowmentDonor } from '../../modules/endowment/donor-directory.js';
import { AppError } from '../../shared/errors.js';
import { MemoryStore } from '../../store/memory-store.js';

const config = {
  nodeEnv: 'test' as const,
  logLevel: 'silent' as const,
  port: 3000,
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/test',
  webhookSecret: 'test-webhook-secret-123456',
  endowmentApiBaseUrl: 'http://127.0.0.1:4100',
  endowmentApiTicket: 'test-endowment-ticket',
  endowmentApiTimeoutMs: 2_000,
  webhookTimestampToleranceSeconds: 300,
  corsOrigins: ['http://localhost:5173'],
};

function confirmedEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${randomBytes(4).toString('hex')}`,
    eventType: 'donation.confirmed',
    occurredAt: '2026-07-20T10:00:00.000Z',
    data: {
      donationId: `don-${randomBytes(4).toString('hex')}`,
      donor: {
        externalId: 'api-test-donor',
        name: 'API Test Donor',
        email: 'private@example.com',
        showName: false,
      },
      amount: 1_000_000,
      currency: 'IDR',
      status: 'CONFIRMED',
      donatedAt: '2026-07-20T10:00:00.000Z',
    },
    ...overrides,
  };
}

async function webhookRequest(
  app: Awaited<ReturnType<typeof createApp>>,
  body: unknown,
  eventId: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const rawBody = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/v1/endowment',
    headers: {
      'content-type': 'application/json',
      'x-endowment-event-id': eventId,
      'x-endowment-timestamp': timestamp,
      'x-endowment-signature': createWebhookSignature(rawBody, timestamp, config.webhookSecret),
    },
    payload: rawBody,
  });
}

class FakeDonorDirectory implements DonorDirectory {
  public readonly donors = new Map<string, EndowmentDonor>([
    [
      '3171010101010004',
      { nik: '3171010101010004', name: 'Dewi Lestari', totalDonation: 30_000_000 },
    ],
    ['3171010101010005', { nik: '3171010101010005', name: 'Eko Saputra', totalDonation: 5_000 }],
  ]);

  public async findByNik(nik: string): Promise<EndowmentDonor> {
    const donor = this.donors.get(nik);
    if (!donor) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan di Endowment');
    return { ...donor };
  }
}

describe('NIK login backed by the Endowment donor lookup', () => {
  let directory: FakeDonorDirectory;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    directory = new FakeDonorDirectory();
    app = await createApp({ config, store: new MemoryStore(), donorDirectory: directory });
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(nik: string) {
    return app.inject({ method: 'POST', url: '/api/v1/auth/nik', payload: { nik } });
  }

  it('validates the NIK format and reports unknown donors', async () => {
    expect((await login('123')).statusCode).toBe(400);
    expect((await login('31710101010100AB')).statusCode).toBe(400);
    const missing = await login('9999999999999999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('DONOR_NOT_FOUND');
  });

  it('caches the donor, creates a tiered fish, awards points, and issues a usable token', async () => {
    const response = await login('3171010101010004');
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toMatchObject({
      tokenType: 'Bearer',
      donor: {
        nik: '3171010101010004',
        name: 'Dewi Lestari',
        tierCode: 'LEGENDARY',
        totalDonation: 30_000_000,
      },
    });
    const headers = { authorization: `Bearer ${data.accessToken as string}` };

    const aquarium = await app.inject({ method: 'GET', url: '/api/v1/me/aquarium', headers });
    expect(aquarium.statusCode).toBe(200);
    expect(aquarium.json().data.fish).toHaveLength(1);
    expect(aquarium.json().data.fish[0].tierCode).toBe('LEGENDARY');

    const inventory = await app.inject({ method: 'GET', url: '/api/v1/me/inventory', headers });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().data).toEqual({ points: 3_000, ownedAccessories: [] });

    const fishId = aquarium.json().data.fish[0].id as string;
    const appearance = await app.inject({
      method: 'PATCH',
      url: `/api/v1/me/fish/${fishId}/appearance`,
      headers,
      payload: { colorCode: '#00e5ff', accessoryCode: 'NONE' },
    });
    expect(appearance.statusCode).toBe(200);
    expect(appearance.json().data.fish.appearance.colorCode).toBe('#00E5FF');

    // A second login re-syncs without duplicating the fish or the donor.
    directory.donors.set('3171010101010004', {
      nik: '3171010101010004',
      name: 'Dewi Lestari',
      totalDonation: 1_000_000,
    });
    const relogin = await login('3171010101010004');
    expect(relogin.json().data.donor.tierCode).toBe('RARE');
    const after = await app.inject({ method: 'GET', url: '/api/v1/me/aquarium', headers });
    expect(after.json().data.fish).toHaveLength(1);
    expect(after.json().data.fish[0].tierCode).toBe('RARE');
    const pointsAfter = await app.inject({ method: 'GET', url: '/api/v1/me/inventory', headers });
    expect(pointsAfter.json().data.points).toBe(3_000);
  });

  it('logs in donors below the COMMON threshold without giving them a fish', async () => {
    const response = await login('3171010101010005');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.donor.tierCode).toBeNull();
  });

  it('requires a bearer token for the inventory', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/inventory' })).statusCode).toBe(401);
  });
});

describe('operations dashboard', () => {
  const adminToken = 'admin-dashboard-token-0123456789abcdef';

  it('serves the dashboard shell with a strict CSP and gates stats behind the admin token', async () => {
    const app = await createApp({
      config: { ...config, adminDashboardToken: adminToken },
      store: new MemoryStore(),
      donorDirectory: new FakeDonorDirectory(),
    });
    try {
      const page = await app.inject({ method: 'GET', url: '/dashboard/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['content-security-policy']).toContain("script-src 'self'");
      expect(page.body).toContain('/dashboard/dashboard.js');
      expect((await app.inject({ method: 'GET', url: '/dashboard/dashboard.js' })).statusCode).toBe(
        200,
      );
      expect((await app.inject({ method: 'GET', url: '/dashboard/admin.js' })).statusCode).toBe(
        200,
      );
      const adminWithoutDb = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/fish',
        headers: { 'x-admin-token': adminToken },
      });
      expect(adminWithoutDb.statusCode).toBe(503);
      expect(adminWithoutDb.json().error.code).toBe('ADMIN_REQUIRES_DATABASE');

      expect((await app.inject({ method: 'GET', url: '/api/v1/admin/stats' })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/admin/stats',
            headers: { 'x-admin-token': 'wrong' },
          })
        ).statusCode,
      ).toBe(401);

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/nik',
        payload: { nik: '3171010101010004' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/nik',
        payload: { nik: '9999999999999999' },
      });

      const stats = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { 'x-admin-token': adminToken },
      });
      expect(stats.statusCode).toBe(200);
      const data = stats.json().data;
      expect(data.database.status).toBe('good');
      expect(data.endowment).toMatchObject({
        status: 'good',
        totals: { ok: 1, notFound: 1, error: 0 },
      });
      expect(JSON.stringify(data)).not.toContain('3171010101010004');
      expect(data.stats.donors).toMatchObject({ total: 1, nikSynced: 1, syncedLast24h: 1 });
      expect(data.stats.fishByTier).toContainEqual({ tierCode: 'LEGENDARY', count: 1 });
      expect(data.stats.hourlyEvents).toHaveLength(24);
      expect(data.stats.hourlyEvents.at(-1).count).toBe(1);
      expect(data.stats.recentEvents[0]).toMatchObject({ eventType: 'fish.created' });
      expect(data.stats.inventoryPoints).toBe(3_000);
    } finally {
      await app.close();
    }
  });

  it('reports the dashboard as disabled when no admin token is configured', async () => {
    const app = await createApp({ config, store: new MemoryStore() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/admin/stats' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('DASHBOARD_DISABLED');
    } finally {
      await app.close();
    }
  });
});

describe('Game API HTTP contract', () => {
  let store: MemoryStore;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    store = new MemoryStore();
    app = await createApp({ config, store });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns request IDs and the success envelope for health', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'req-test-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-test-1');
    expect(response.json()).toEqual({
      schemaVersion: '1.0',
      requestId: 'req-test-1',
      data: { status: 'ok' },
    });
  });

  it('serves Scalar docs with examples for every GAME API response', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs/' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).toContain('Scalar');

    const openapi = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      servers: Array<{ url: string }>;
      paths: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              { content?: { 'application/json'?: { examples?: Record<string, unknown> } } }
            >;
          }
        >
      >;
    };

    expect(openapi.servers).toEqual([{ url: '/' }]);
    const gamePaths = Object.entries(openapi.paths).filter(
      ([path]) => path.startsWith('/api/') || path.startsWith('/webhooks/'),
    );
    expect(gamePaths).toHaveLength(12);
    expect(Object.keys(openapi.paths).some((path) => path.startsWith('/mock/'))).toBe(false);

    for (const [path, pathItem] of gamePaths) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          expect(
            Object.keys(response.content?.['application/json']?.examples ?? {}),
            `${method.toUpperCase()} ${path} ${status} should have a response example`,
          ).not.toHaveLength(0);
        }
      }
    }
  });

  it('allows configured browser origins without treating other origins as server errors', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const disallowed = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://untrusted.example' },
    });
    expect(disallowed.statusCode).toBe(200);
    expect(disallowed.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('validates Big Aquarium limits and authentication', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=51' })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/aquarium' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=15' })).statusCode,
    ).toBe(200);
  });

  it('never rate-limits signed webhooks, even in bursts from one IP', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 110; index += 1) {
      const body = confirmedEvent();
      statuses.push((await webhookRequest(app, body, body.eventId)).statusCode);
    }
    expect(statuses.filter((status) => status === 429)).toHaveLength(0);
    expect(statuses.every((status) => status === 202)).toBe(true);
  });

  it('accepts a signed confirmed webhook once and returns stable species/asset codes', async () => {
    const body = confirmedEvent();
    const first = await webhookRequest(app, body, body.eventId);
    expect(first.statusCode).toBe(202);
    const big = await app.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=15' });
    expect(big.statusCode).toBe(200);
    expect(big.json().data.fish[0]).toMatchObject({
      speciesCode: 'CLOWNFISH',
      assetCode: 'FISH_RARE_CLOWNFISH',
      tierCode: 'RARE',
      donorDisplayName: 'Anonymous Donor',
    });
    expect(JSON.stringify(big.json())).not.toContain('private@example.com');
    const replay = await webhookRequest(app, body, body.eventId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.duplicate).toBe(true);
  });

  it('supports personal access, feed cooldown, appearance, refund, and incremental events', async () => {
    const body = confirmedEvent({
      eventId: 'evt-personal',
      data: {
        ...confirmedEvent().data,
        donationId: 'don-personal',
        donor: {
          externalId: 'personal-donor',
          name: 'Personal',
          email: 'secret@example.com',
          showName: true,
        },
      },
    });
    expect((await webhookRequest(app, body, 'evt-personal')).statusCode).toBe(202);
    const rawToken = `token-${randomBytes(16).toString('hex')}`;
    const issued = await store.issueAccessToken('personal-donor', hashAccessToken(rawToken), null);
    expect(issued.expiresAt).toBeNull();
    const aquarium = await app.inject({
      method: 'GET',
      url: '/api/v1/me/aquarium',
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(aquarium.statusCode).toBe(200);
    const fishId = aquarium.json().data.fish[0].id as string;
    const feed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/fish/${fishId}/feed`,
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(feed.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/me/fish/${fishId}/feed`,
          headers: { authorization: `Bearer ${rawToken}` },
        })
      ).json().error.code,
    ).toBe('FEEDING_COOLDOWN_ACTIVE');
    const appearance = await app.inject({
      method: 'PATCH',
      url: `/api/v1/me/fish/${fishId}/appearance`,
      headers: { authorization: `Bearer ${rawToken}`, 'content-type': 'application/json' },
      payload: { colorCode: 'OCEAN_BLUE', accessoryCode: 'TELU_CAP' },
    });
    expect(appearance.statusCode).toBe(200);
    expect(appearance.json().data.fish.appearance).toEqual({
      colorCode: 'OCEAN_BLUE',
      accessoryCode: 'TELU_CAP',
    });
    const events = await app.inject({
      method: 'GET',
      url: `${aquarium.json().data.publicSlug}/events?after=0&limit=100`,
    });
    expect(events.statusCode).toBe(404);
    const eventPage = await app.inject({
      method: 'GET',
      url: `/api/v1/aquariums/${aquarium.json().data.publicSlug}/events?after=0&limit=100`,
    });
    expect(eventPage.statusCode).toBe(200);
    expect(
      eventPage.json().data.events.map((event: { eventType: string }) => event.eventType),
    ).toEqual(['fish.created', 'fish.fed', 'fish.customized']);
  });
});
