import { describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { InMemoryMockStore } from '../../modules/donations/mock-store.js';

const config = {
  nodeEnv: 'test' as const,
  logLevel: 'silent' as const,
  port: 4000,
  webhookUrl: 'http://localhost:3000/webhooks/v1/endowment',
  webhookSecret: 'test-webhook-secret-123456',
  corsOrigins: ['http://localhost:5173'],
};

describe('Mock Endowment API', () => {
  it('creates, replays, refunds, and runs tier scenarios through signed delivery', async () => {
    const store = new InMemoryMockStore();
    const deliveries: Array<{ rawBody: string; timestamp: string; eventId: string }> = [];
    const app = await createApp({
      config,
      store,
      deliver: async (rawBody, timestamp, eventId) => {
        deliveries.push({ rawBody, timestamp, eventId });
        return { statusCode: 202, responseBody: { accepted: true } };
      },
    });
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/mock/v1/donations',
        headers: { 'content-type': 'application/json' },
        payload: {
          donorExternalId: 'mock-1',
          donorName: 'Mock Donor',
          donorEmail: 'private@example.com',
          showName: false,
          amount: 1_000_000,
          currency: 'IDR',
        },
      });
      expect(create.statusCode).toBe(200);
      const donationId = create.json().data.donationId as string;
      const originalEventId = create.json().data.eventId as string;
      expect(deliveries[0]?.eventId).toBe(originalEventId);
      expect(JSON.stringify(create.json())).not.toContain('private@example.com');

      const replay = await app.inject({
        method: 'POST',
        url: `/mock/v1/donations/${donationId}/replay`,
      });
      expect(replay.statusCode).toBe(200);
      expect(deliveries[1]?.eventId).toBe(originalEventId);

      const refund = await app.inject({
        method: 'POST',
        url: `/mock/v1/donations/${donationId}/refund`,
      });
      expect(refund.statusCode).toBe(200);
      expect(refund.json().data.status).toBe('refunded');
      expect(deliveries[2]?.eventId).not.toBe(originalEventId);

      for (const scenario of ['common', 'rare', 'epic', 'legendary']) {
        const response = await app.inject({
          method: 'POST',
          url: `/mock/v1/scenarios/${scenario}`,
        });
        expect(response.statusCode).toBe(200);
      }
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/mock/v1/donations' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid donation input', async () => {
    const app = await createApp({
      config,
      deliver: async () => ({ statusCode: 202, responseBody: null }),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/mock/v1/donations',
        payload: { amount: -1 },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    } finally {
      await app.close();
    }
  });

  it('allows configured browser origins without treating other origins as server errors', async () => {
    const app = await createApp({
      config,
      deliver: async () => ({ statusCode: 202, responseBody: null }),
    });
    try {
      const allowed = await app.inject({
        method: 'GET',
        url: '/mock/v1/health',
        headers: { origin: 'http://localhost:5173' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

      const disallowed = await app.inject({
        method: 'GET',
        url: '/mock/v1/health',
        headers: { origin: 'https://untrusted.example' },
      });
      expect(disallowed.statusCode).toBe(200);
      expect(disallowed.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
