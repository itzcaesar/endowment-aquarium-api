import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { createDatabaseConnection } from '../../db/client.js';
import { createWebhookSignature } from '../../modules/webhooks/signature-service.js';
import { AppError } from '../../shared/errors.js';
import { runCleanup } from '../../modules/maintenance/cleanup.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const donorTotals = new Map<string, number>([['3171010101017777', 10_000_000]]);
const secret = process.env.ENDOWMENT_WEBHOOK_SECRET ?? 'integration-secret-123456';

if (!testDatabaseUrl) {
  process.stdout.write('Skipping PostgreSQL integration tests: TEST_DATABASE_URL is not set.\n');
}

integration('PostgreSQL integration (isolated TEST_DATABASE_URL only)', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let connection: ReturnType<typeof createDatabaseConnection>;

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    connection = createDatabaseConnection(testDatabaseUrl);
    await connection.sql`
      truncate table endowment_lookups, admin_audit_log, game_events, access_tokens, player_inventory, fish, donations, webhook_events, aquariums, donors restart identity cascade
    `;
    app = await createApp({
      config: {
        nodeEnv: 'test',
        logLevel: 'silent',
        port: 3000,
        databaseUrl: testDatabaseUrl,
        webhookSecret: secret,
        endowmentApiBaseUrl: 'http://127.0.0.1:4100',
        endowmentApiTicket: 'test-endowment-ticket',
        endowmentApiTimeoutMs: 2_000,
        webhookTimestampToleranceSeconds: 300,
        corsOrigins: [],
        adminDashboardToken: 'integration-admin-token-0123456789abcdef',
      },
      donorDirectory: {
        findByNik: async (nik: string) => {
          const total = donorTotals.get(nik);
          if (total === undefined)
            throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan di Endowment');
          return { nik, name: 'Integration NIK Donor', totalDonation: total };
        },
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (connection) await connection.close();
  });

  it('persists one fish, reuses donor/aquarium, idempotently replays, and refunds', async () => {
    const body = {
      eventId: 'integration-event-1',
      eventType: 'donation.confirmed',
      occurredAt: new Date().toISOString(),
      data: {
        donationId: 'integration-donation-1',
        donor: {
          externalId: 'integration-donor',
          name: 'Integration Donor',
          email: 'private@example.com',
          showName: false,
        },
        amount: 50_000,
        currency: 'IDR',
        status: 'CONFIRMED',
        donatedAt: new Date().toISOString(),
      },
    };
    const send = async (payload: unknown, eventId: string, statusExpected: number) => {
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/v1/endowment',
        payload: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-endowment-event-id': eventId,
          'x-endowment-timestamp': timestamp,
          'x-endowment-signature': createWebhookSignature(rawBody, timestamp, secret),
        },
      });
      expect(response.statusCode).toBe(statusExpected);
      return response;
    };
    await send(body, body.eventId, 202);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=15' })).json().data
        .fish[0],
    ).toMatchObject({ speciesCode: 'GUPPY', assetCode: 'FISH_COMMON_GUPPY' });
    await send(body, body.eventId, 200);
    const refund = {
      eventId: 'integration-refund-1',
      eventType: 'donation.refunded',
      occurredAt: new Date().toISOString(),
      data: { donationId: body.data.donationId, status: 'REFUNDED' },
    };
    await send(refund, refund.eventId, 202);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=15' })).json().data.fish,
    ).toHaveLength(0);
  });

  it('syncs NIK donors into PostgreSQL with a tiered fish and inventory', async () => {
    const login = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/nik',
        payload: { nik: '3171010101017777' },
      });
    const first = await login();
    expect(first.statusCode).toBe(200);
    expect(first.json().data.donor.tierCode).toBe('EPIC');
    const headers = { authorization: `Bearer ${first.json().data.accessToken as string}` };

    const inventory = await app.inject({ method: 'GET', url: '/api/v1/me/inventory', headers });
    expect(inventory.json().data).toEqual({ points: 1_000, ownedAccessories: [] });

    donorTotals.set('3171010101017777', 30_000_000);
    expect((await login()).json().data.donor.tierCode).toBe('LEGENDARY');
    const aquarium = await app.inject({ method: 'GET', url: '/api/v1/me/aquarium', headers });
    expect(aquarium.json().data.fish).toHaveLength(1);
    expect(aquarium.json().data.fish[0].tierCode).toBe('LEGENDARY');

    const donors = await connection.sql<{ count: string }[]>`
      select count(*)::text as count from donors where nik = '3171010101017777'
    `;
    expect(donors[0]?.count).toBe('1');
  });

  it('aggregates dashboard statistics from PostgreSQL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
      headers: { 'x-admin-token': 'integration-admin-token-0123456789abcdef' },
    });
    expect(response.statusCode).toBe(200);
    const stats = response.json().data.stats;
    expect(stats.fishByTier.map((tier: { tierCode: string }) => tier.tierCode)).toEqual([
      'COMMON',
      'RARE',
      'EPIC',
      'LEGENDARY',
    ]);
    expect(stats.donors.nikSynced).toBeGreaterThanOrEqual(1);
    expect(stats.hourlyEvents).toHaveLength(24);
    expect(stats.recentEvents.length).toBeGreaterThan(0);
    expect(stats.webhooks.processed + stats.webhooks.duplicate).toBeGreaterThan(0);
  });

  describe('admin dashboard API', () => {
    const headers = { 'x-admin-token': 'integration-admin-token-0123456789abcdef' };

    async function nikDonorId() {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/donors?source=nik&search=3171010101017777',
        headers,
      });
      expect(list.statusCode).toBe(200);
      const item = list.json().data.items[0];
      expect(item.nikMasked).toBe('3171••••••••7777');
      expect(JSON.stringify(list.json())).not.toContain('3171010101017777');
      return item.id as string;
    }

    it('rejects requests without the admin token', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/admin/fish' })).statusCode).toBe(401);
    });

    it('lists the catalog and fish with filters and pagination', async () => {
      const catalog = await app.inject({ method: 'GET', url: '/api/v1/admin/catalog', headers });
      expect(catalog.json().data.species.map((s: { code: string }) => s.code)).toContain('GUPPY');
      const fish = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/fish?status=all&pageSize=1',
        headers,
      });
      expect(fish.statusCode).toBe(200);
      expect(fish.json().data.items).toHaveLength(1);
      expect(fish.json().data.total).toBeGreaterThanOrEqual(2);
      const legendary = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/fish?tier=LEGENDARY',
        headers,
      });
      expect(
        legendary.json().data.items.every((f: { tierCode: string }) => f.tierCode === 'LEGENDARY'),
      ).toBe(true);
    });

    it('creates, edits, feeds and deactivates fish with audit entries and game events', async () => {
      const donorId = await nikDonorId();
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/fish',
        headers,
        payload: {
          donorId,
          speciesCode: 'CLOWNFISH',
          displayName: 'Nemo',
          colorCode: '#00e5ff',
          reason: 'event reward',
        },
      });
      expect(created.statusCode).toBe(201);
      const fish = created.json().data;
      expect(fish).toMatchObject({ tierCode: 'RARE', displayName: 'Nemo', colorCode: '#00E5FF' });

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/fish/${fish.id as string}`,
        headers,
        payload: { accessoryCode: 'TELU_CAP', hunger: 40, tierCode: 'EPIC' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data).toMatchObject({
        accessoryCode: 'TELU_CAP',
        hunger: 40,
        mood: 'neutral',
        tierCode: 'EPIC',
      });

      const deactivated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/fish/${fish.id as string}`,
        headers,
        payload: { isActive: false },
      });
      expect(deactivated.json().data.isActive).toBe(false);

      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/admin/fish/${fish.id as string}`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/fish',
            headers,
            payload: { donorId, speciesCode: 'SHARK' },
          })
        ).statusCode,
      ).toBe(400);

      const events = await connection.sql<{ event_type: string }[]>`
        select event_type from game_events where fish_id = ${fish.id as string}::uuid order by id`;
      expect(events.map((event) => event.event_type)).toEqual([
        'fish.created',
        'fish.tier_changed',
        'fish.customized',
        'fish.fed',
        'fish.deactivated',
      ]);

      const audit = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit?targetType=fish&targetId=${fish.id as string}`,
        headers,
      });
      const entries = audit.json().data.items;
      expect(entries.map((entry: { action: string }) => entry.action)).toEqual([
        'fish.update',
        'fish.update',
        'fish.create',
      ]);
      expect(entries[2].reason).toBe('event reward');
      expect(entries[1].changes.accessoryCode).toEqual({ from: 'NONE', to: 'TELU_CAP' });
    });

    it('edits donors, adjusts inventory safely, and re-syncs from Endowment', async () => {
      const donorId = await nikDonorId();
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/donors/${donorId}`,
        headers,
        payload: { showNamePublicly: false },
      });
      expect(renamed.json().data.showNamePublicly).toBe(false);

      const inventory = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/donors/${donorId}/inventory`,
        headers,
        payload: { pointsDelta: 250, grantAccessories: ['TELU_CAP', 'GRADUATION_HAT'] },
      });
      expect(inventory.statusCode).toBe(200);
      const points = inventory.json().data.points as number;
      expect(inventory.json().data.ownedAccessories).toEqual(['TELU_CAP', 'GRADUATION_HAT']);

      const revoke = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/donors/${donorId}/inventory`,
        headers,
        payload: { revokeAccessories: ['TELU_CAP'] },
      });
      expect(revoke.json().data.ownedAccessories).toEqual(['GRADUATION_HAT']);

      // Audit entries are newest-first by numeric id and only list fields that changed.
      const inventoryAudit = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit?targetType=inventory&targetId=${donorId}`,
        headers,
      });
      const auditItems = inventoryAudit.json().data.items as Array<{
        id: number;
        changes: Record<string, unknown>;
      }>;
      expect(auditItems.map((item) => item.id)).toEqual(
        [...auditItems.map((item) => item.id)].sort((left, right) => right - left),
      );
      expect(Object.keys(auditItems[0]?.changes ?? {})).toEqual(['ownedAccessories']);

      const overdraw = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/donors/${donorId}/inventory`,
        headers,
        payload: { pointsDelta: -(points + 1) },
      });
      expect(overdraw.statusCode).toBe(409);

      donorTotals.set('3171010101017777', 1_000_000);
      const resync = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/donors/${donorId}/resync`,
        headers,
        payload: { reason: 'manual check' },
      });
      expect(resync.statusCode).toBe(200);
      expect(resync.json().data).toMatchObject({ tierCode: 'RARE', totalDonation: 1_000_000 });

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/donors/${donorId}`,
        headers,
      });
      expect(detail.json().data.inventory.ownedAccessories).toEqual(['GRADUATION_HAT']);
      expect(detail.json().data.fish.length).toBeGreaterThanOrEqual(1);
    });

    it('reactivates with a Unity-compatible event, exposes fish history, and exports CSV', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/fish?status=inactive',
        headers,
      });
      const fishId = list.json().data.items[0].id as string;
      const reactivated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/fish/${fishId}`,
        headers,
        payload: { isActive: true, reason: 'restored' },
      });
      expect(reactivated.json().data.isActive).toBe(true);

      const history = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/fish/${fishId}/history`,
        headers,
      });
      const items = history.json().data.items as Array<{
        kind: string;
        type: string;
        details: Record<string, unknown>;
        reason: string | null;
      }>;
      expect(items[0]?.kind === 'admin' || items[0]?.kind === 'game-event').toBe(true);
      const respawn = items.find((item) => item.kind === 'game-event' && item.details.reactivated);
      expect(respawn?.type).toBe('fish.created');
      expect(items.some((item) => item.kind === 'admin' && item.reason === 'restored')).toBe(true);

      const csv = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/export/fish.csv',
        headers,
      });
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="aquarium-fish-/);
      expect(csv.body).toContain(fishId);
      const donorsCsv = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/export/donors.csv',
        headers,
      });
      expect(donorsCsv.body).not.toContain('3171010101017777');
      expect(donorsCsv.body).toContain('3171••••••••7777');
      const exportsAudit = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?targetType=export',
        headers,
      });
      expect(
        exportsAudit.json().data.items.map((entry: { action: string }) => entry.action),
      ).toEqual(['export.donors', 'export.fish']);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/admin/export/secrets.csv', headers }))
          .statusCode,
      ).toBe(400);
    });

    it('persists Endowment lookup history across app restarts', async () => {
      const rows = await connection.sql<{ count: number }[]>`
        select count(*)::int as count from endowment_lookups`;
      expect(rows[0]?.count).toBeGreaterThan(0);
      const restarted = await createApp({
        config: {
          nodeEnv: 'test',
          logLevel: 'silent',
          port: 3000,
          databaseUrl: testDatabaseUrl!,
          webhookSecret: secret,
          endowmentApiBaseUrl: 'http://127.0.0.1:4100',
          endowmentApiTicket: 'test-endowment-ticket',
          endowmentApiTimeoutMs: 2_000,
          webhookTimestampToleranceSeconds: 300,
          corsOrigins: [],
          adminDashboardToken: 'integration-admin-token-0123456789abcdef',
        },
      });
      try {
        const stats = await restarted.inject({
          method: 'GET',
          url: '/api/v1/admin/stats',
          headers,
        });
        const endowment = stats.json().data.endowment;
        expect(endowment.totals.ok).toBe(rows[0]?.count);
        expect(endowment.recent.length).toBeGreaterThan(0);
        expect(JSON.stringify(endowment)).not.toContain('3171010101017777');
      } finally {
        await restarted.close();
      }
    });

    it('cleans up expired tokens and old lookup rows but keeps current data', async () => {
      const donorRows = await connection.sql<{ id: string }[]>`select id from donors limit 1`;
      const donorId = donorRows[0]!.id;
      await connection.sql`
        insert into access_tokens (donor_id, token_hash, expires_at)
        values (${donorId}::uuid, 'cleanup-old', now() - interval '30 days'),
               (${donorId}::uuid, 'cleanup-fresh', now() + interval '1 day')`;
      await connection.sql`
        insert into endowment_lookups (outcome, latency_ms, created_at)
        values ('ok', 5, now() - interval '120 days')`;
      const removed = await runCleanup(connection.sql, new Date());
      expect(removed).toEqual({ accessTokens: 1, endowmentLookups: 1 });
      const remaining = await connection.sql<{ token_hash: string }[]>`
        select token_hash from access_tokens where token_hash like 'cleanup-%'`;
      expect(remaining.map((row) => row.token_hash)).toEqual(['cleanup-fresh']);
    });
  });
});
