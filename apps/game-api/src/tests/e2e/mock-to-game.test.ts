import { describe, expect, it } from 'vitest';

import { createApp as createGameApp } from '../../app.js';
import { MemoryStore } from '../../store/memory-store.js';
import { createApp as createMockApp } from '../../../../mock-endowment-api/src/app.js';

const gameConfig = {
  nodeEnv: 'test' as const,
  logLevel: 'silent' as const,
  port: 0,
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/test',
  webhookSecret: 'test-webhook-secret-123456',
  endowmentApiBaseUrl: 'http://127.0.0.1:4100',
  endowmentApiTicket: 'test-endowment-ticket',
  endowmentApiTimeoutMs: 2_000,
  webhookTimestampToleranceSeconds: 300,
  corsOrigins: [],
};

describe('mock-to-game end-to-end flow', () => {
  it('creates a rare fish, replays idempotently, and refunds it', async () => {
    const game = await createGameApp({ config: gameConfig, store: new MemoryStore() });
    await game.listen({ port: 0, host: '127.0.0.1' });
    const address = game.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Game server did not expose a port');

    const mock = await createMockApp({
      config: {
        nodeEnv: 'test',
        logLevel: 'silent',
        port: 0,
        webhookUrl: `http://127.0.0.1:${address.port}/webhooks/v1/endowment`,
        webhookSecret: gameConfig.webhookSecret,
        endowmentApiTicket: gameConfig.endowmentApiTicket,
        corsOrigins: [],
      },
    });
    await mock.listen({ port: 0, host: '127.0.0.1' });
    try {
      const created = await mock.inject({ method: 'POST', url: '/mock/v1/scenarios/rare' });
      expect(created.statusCode).toBe(200);
      expect(created.json().data.delivery.statusCode).toBe(202);
      const firstBig = await game.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=15' });
      expect(firstBig.json().data.fish).toHaveLength(1);
      expect(firstBig.json().data.fish[0]).toMatchObject({
        speciesCode: 'CLOWNFISH',
        assetCode: 'FISH_RARE_CLOWNFISH',
      });

      const donationId = created.json().data.donationId as string;
      const replay = await mock.inject({
        method: 'POST',
        url: `/mock/v1/donations/${donationId}/replay`,
      });
      expect(replay.json().data.delivery.statusCode).toBe(200);
      expect(
        (await game.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=15' })).json().data
          .fish,
      ).toHaveLength(1);

      const refund = await mock.inject({
        method: 'POST',
        url: `/mock/v1/donations/${donationId}/refund`,
      });
      expect(refund.json().data.delivery.statusCode).toBe(202);
      expect(
        (await game.inject({ method: 'GET', url: '/api/v1/big-aquarium?limit=15' })).json().data
          .fish,
      ).toHaveLength(0);
    } finally {
      await mock.close();
      await game.close();
    }
  }, 15_000);

  it('logs a donor in by NIK through the server-to-server Endowment lookup', async () => {
    const mock = await createMockApp({
      config: {
        nodeEnv: 'test',
        logLevel: 'silent',
        port: 0,
        webhookUrl: 'http://127.0.0.1:9/webhooks/v1/endowment',
        webhookSecret: gameConfig.webhookSecret,
        endowmentApiTicket: gameConfig.endowmentApiTicket,
        corsOrigins: [],
      },
    });
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const address = mock.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Mock server did not expose a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const game = await createGameApp({
      config: { ...gameConfig, endowmentApiBaseUrl: baseUrl },
      store: new MemoryStore(),
    });
    const wrongTicket = await createGameApp({
      config: { ...gameConfig, endowmentApiBaseUrl: baseUrl, endowmentApiTicket: 'wrong' },
      store: new MemoryStore(),
    });
    try {
      const login = await game.inject({
        method: 'POST',
        url: '/api/v1/auth/nik',
        payload: { nik: '3171010101010002' },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().data.donor).toEqual({
        nik: '3171010101010002',
        name: 'Budi Santoso',
        tierCode: 'RARE',
        totalDonation: 1_000_000,
      });

      const unknown = await game.inject({
        method: 'POST',
        url: '/api/v1/auth/nik',
        payload: { nik: '9999999999999999' },
      });
      expect(unknown.statusCode).toBe(404);

      const rejected = await wrongTicket.inject({
        method: 'POST',
        url: '/api/v1/auth/nik',
        payload: { nik: '3171010101010002' },
      });
      expect(rejected.statusCode).toBe(502);
      expect(rejected.json().error.code).toBe('ENDOWMENT_AUTH_FAILED');
    } finally {
      await wrongTicket.close();
      await game.close();
      await mock.close();
    }
  }, 15_000);
});
