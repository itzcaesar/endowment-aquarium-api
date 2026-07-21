import { randomUUID } from 'node:crypto';

import { createMockDonationSchema, type CreateMockDonationInput } from '@telu/contracts';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { MockApiConfig } from './config/environment.js';
import {
  InMemoryMockStore,
  type MockDeliveryResult,
  type MockStore,
} from './modules/donations/mock-store.js';
import { AppError } from './shared/errors.js';
import { errorEnvelope, successEnvelope } from './shared/envelope.js';
import { createWebhookSignature } from './shared/signature.js';
import { jsonSchema, parseInput } from './shared/validation.js';

interface AppOptions {
  config: MockApiConfig;
  store?: MockStore;
  deliver?: (rawBody: string, timestamp: string, eventId: string) => Promise<MockDeliveryResult>;
}

const deliverySchema = z.object({ statusCode: z.number().int(), responseBody: z.unknown() });
const mockDonationSchema = z.object({
  donationId: z.string(),
  eventId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.enum(['confirmed', 'refunded']),
  delivery: deliverySchema.nullable(),
});

function publicRecord(record: ReturnType<MockStore['create']>) {
  return {
    donationId: record.donationId,
    eventId: record.eventId,
    amount: record.payload.data.amount,
    currency: record.payload.data.currency,
    status: record.refunded ? 'refunded' : 'confirmed',
    delivery: record.lastDelivery,
  };
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.config.logLevel, redact: ['req.headers.x-endowment-signature'] },
    bodyLimit: 1_048_576,
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && supplied.length > 0 ? supplied : randomUUID();
    },
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body || {}),
  );
  const store = options.store ?? new InMemoryMockStore();
  const deliver =
    options.deliver ??
    (async (rawBody: string, timestamp: string, eventId: string) => {
      try {
        const response = await fetch(options.config.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-endowment-signature': createWebhookSignature(
              rawBody,
              timestamp,
              options.config.webhookSecret,
            ),
            'x-endowment-event-id': eventId,
            'x-endowment-timestamp': timestamp,
          },
          body: rawBody,
        });
        const responseBody = (await response.json().catch(() => null)) as unknown;
        return { statusCode: response.status, responseBody };
      } catch {
        return { statusCode: 502, responseBody: { code: 'GAME_API_UNREACHABLE' } };
      }
    });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || options.config.corsOrigins.includes(origin)) callback(null, true);
      else callback(null, false);
    },
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Tel-U Mock Endowment API', version: '1.0.0' },
      servers: [{ url: 'http://localhost:4000' }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorEnvelope(request.id, 'ROUTE_NOT_FOUND', 'Route tidak ditemukan')),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply
        .code(error.statusCode)
        .send(errorEnvelope(request.id, error.code, error.message, error.details));
      return;
    }
    if (
      error &&
      typeof error === 'object' &&
      'validation' in error &&
      Array.isArray(error.validation)
    ) {
      reply
        .code(400)
        .send(errorEnvelope(request.id, 'VALIDATION_ERROR', 'Input tidak valid', error.validation));
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const statusCode = error.statusCode;
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        const fastifyCode = 'code' in error && typeof error.code === 'string' ? error.code : '';
        const code =
          fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : 'REQUEST_ERROR';
        const message =
          code === 'UNSUPPORTED_MEDIA_TYPE'
            ? 'Content-Type tidak didukung'
            : 'Request tidak dapat diproses';
        reply.code(statusCode).send(errorEnvelope(request.id, code, message));
        return;
      }
    }
    request.log.error({ err: error }, 'Unhandled mock request error');
    reply
      .code(500)
      .send(errorEnvelope(request.id, 'INTERNAL_SERVER_ERROR', 'Terjadi kesalahan internal'));
  });
  app.get('/openapi.json', async () => app.swagger());
  app.get('/health', async (request) => successEnvelope(request.id, { status: 'ok' }));
  app.get('/mock/v1/health', async (request) => successEnvelope(request.id, { status: 'ok' }));

  app.post(
    '/mock/v1/donations',
    { schema: { tags: ['donations'], body: jsonSchema(createMockDonationSchema) } },
    async (request) => {
      const input = parseInput(createMockDonationSchema, request.body);
      const record = store.create(input);
      const rawBody = JSON.stringify(record.payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const delivery = await deliver(rawBody, timestamp, record.eventId);
      store.markDelivery(record.donationId, delivery);
      return successEnvelope(request.id, publicRecord(record));
    },
  );

  app.get(
    '/mock/v1/donations',
    {
      schema: {
        response: {
          200: jsonSchema(
            z.object({
              schemaVersion: z.literal('1.0'),
              requestId: z.string(),
              data: z.object({ donations: z.array(mockDonationSchema) }),
            }),
          ),
        },
      },
    },
    async (request) => successEnvelope(request.id, { donations: store.list().map(publicRecord) }),
  );

  app.post('/mock/v1/donations/:id/replay', async (request) => {
    const params = request.params as { id?: string };
    if (!params.id) throw new AppError(400, 'VALIDATION_ERROR', 'donation id diperlukan');
    let record;
    try {
      record = store.get(params.id);
    } catch {
      throw new AppError(404, 'MOCK_DONATION_NOT_FOUND', 'Mock donation tidak ditemukan');
    }
    const rawBody = JSON.stringify(record.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const delivery = await deliver(rawBody, timestamp, record.eventId);
    store.markDelivery(record.donationId, delivery);
    return successEnvelope(request.id, publicRecord(record));
  });

  app.post('/mock/v1/donations/:id/refund', async (request) => {
    const params = request.params as { id?: string };
    if (!params.id) throw new AppError(400, 'VALIDATION_ERROR', 'donation id diperlukan');
    let record;
    try {
      record = store.get(params.id);
    } catch {
      throw new AppError(404, 'MOCK_DONATION_NOT_FOUND', 'Mock donation tidak ditemukan');
    }
    const refund = store.createRefundEvent(record);
    const rawBody = JSON.stringify(refund.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const delivery = await deliver(rawBody, timestamp, refund.eventId);
    store.markDelivery(record.donationId, delivery);
    return successEnvelope(request.id, { ...publicRecord(record), refundEventId: refund.eventId });
  });

  const scenarioAmounts = {
    common: 50_000,
    rare: 1_000_000,
    epic: 10_000_000,
    legendary: 30_000_000,
  } as const;
  for (const [scenario, amount] of Object.entries(scenarioAmounts)) {
    app.post(`/mock/v1/scenarios/${scenario}`, async (request) => {
      const input: CreateMockDonationInput = {
        donorExternalId: `scenario-${scenario}-${randomUUID().slice(0, 8)}`,
        donorName: `Scenario ${scenario}`,
        donorEmail: `scenario-${scenario}@example.com`,
        showName: false,
        amount,
        currency: 'IDR',
      };
      const record = store.create(input);
      const rawBody = JSON.stringify(record.payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const delivery = await deliver(rawBody, timestamp, record.eventId);
      store.markDelivery(record.donationId, delivery);
      return successEnvelope(request.id, publicRecord(record));
    });
  }
  app.post('/mock/v1/scenarios/random', async (request) => {
    const scenarios = Object.keys(scenarioAmounts) as (keyof typeof scenarioAmounts)[];
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)] ?? 'common';
    const input: CreateMockDonationInput = {
      donorExternalId: `scenario-random-${randomUUID().slice(0, 8)}`,
      donorName: 'Scenario random',
      donorEmail: 'scenario-random@example.com',
      showName: false,
      amount: scenarioAmounts[scenario],
      currency: 'IDR',
    };
    const record = store.create(input);
    const rawBody = JSON.stringify(record.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const delivery = await deliver(rawBody, timestamp, record.eventId);
    store.markDelivery(record.donationId, delivery);
    return successEnvelope(request.id, publicRecord(record));
  });
  return app;
}
