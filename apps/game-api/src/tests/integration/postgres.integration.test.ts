import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { createDatabaseConnection } from '../../db/client.js';
import { createWebhookSignature } from '../../modules/webhooks/signature-service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
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
      truncate table game_events, access_tokens, fish, donations, webhook_events, aquariums, donors restart identity cascade
    `;
    app = await createApp({
      config: {
        nodeEnv: 'test',
        logLevel: 'silent',
        port: 3000,
        databaseUrl: testDatabaseUrl,
        webhookSecret: secret,
        webhookTimestampToleranceSeconds: 300,
        corsOrigins: [],
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
});
