import { randomUUID } from 'node:crypto';

import {
  appearanceInputSchema,
  bigAquariumQuerySchema,
  bigAquariumSchema,
  errorEnvelopeSchema,
  endowmentWebhookSchema,
  eventsQuerySchema,
  gameEventsPageSchema,
  personalAquariumSchema,
  personalFishSchema,
  publicAquariumSchema,
  successEnvelopeSchema,
} from '@telu/contracts';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';

import type { GameApiConfig } from './config/environment.js';
import { createDatabaseConnection } from './db/client.js';
import { PostgresStore } from './store/postgres-store.js';
import type { AppStore } from './store/types.js';
import { hashAccessToken, bearerToken } from './modules/auth/token-service.js';
import { verifyWebhookSignature } from './modules/webhooks/signature-service.js';
import { AppError, safeErrorCode } from './shared/errors.js';
import { errorEnvelope, successEnvelope } from './shared/envelope.js';
import { jsonSchema, parseInput } from './shared/validation.js';

interface AppOptions {
  config: GameApiConfig;
  store?: AppStore;
}

const healthDataSchema = z.object({ status: z.literal('ok') });
const metaDataSchema = z.object({
  apiVersion: z.literal('1.0'),
  schemaVersion: z.literal('1.0'),
  service: z.literal('tel-u-endowment-aquarium'),
});
const authExchangeDataSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresAt: z.iso.datetime().nullable(),
});
const webhookAcceptedDataSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  eventId: z.string(),
});
const feedDataSchema = z.object({
  fish: personalFishSchema,
  nextFeedAt: z.iso.datetime(),
});
const appearanceDataSchema = z.object({ fish: personalFishSchema });

function rawBodyText(request: FastifyRequest): string {
  if (!request.rawBody) {
    throw new AppError(400, 'RAW_BODY_UNAVAILABLE', 'Raw webhook body tidak tersedia');
  }
  return request.rawBody.toString('utf8');
}

async function authenticatedDonor(request: FastifyRequest, store: AppStore): Promise<string> {
  const token = bearerToken(request.headers.authorization);
  const authenticated = await store.authenticateToken(hashAccessToken(token), new Date());
  if (!authenticated) throw new AppError(401, 'INVALID_ACCESS_TOKEN', 'Access token tidak valid');
  return authenticated.donorId;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.x-endowment-signature'],
    },
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

  const connection = options.store ? null : createDatabaseConnection(options.config.databaseUrl);
  const store = options.store ?? new PostgresStore(connection!);
  const errorResponseSchema = jsonSchema(errorEnvelopeSchema);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || options.config.corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Tel-U Endowment Aquarium API',
        version: '1.0.0',
        description: 'Stable REST contract for the Tel-U Endowment Aquarium Unity client.',
      },
      servers: [{ url: 'http://localhost:3000' }],
      components: {
        schemas: {
          ErrorEnvelope: errorResponseSchema,
        },
        examples: {
          ErrorEnvelopeExample: {
            summary: 'Stable API error envelope',
            value: {
              schemaVersion: '1.0',
              requestId: 'req_123',
              error: { code: 'FISH_NOT_FOUND', message: 'Fish tidak ditemukan', details: null },
            },
          },
        },
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorEnvelope(request.id, 'ROUTE_NOT_FOUND', 'Route tidak ditemukan'));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply
        .code(error.statusCode)
        .send(errorEnvelope(request.id, error.code, error.message, error.details));
      return;
    }
    if (
      error !== null &&
      typeof error === 'object' &&
      'validation' in error &&
      Array.isArray(error.validation)
    ) {
      reply
        .code(400)
        .send(errorEnvelope(request.id, 'VALIDATION_ERROR', 'Input tidak valid', error.validation));
      return;
    }
    if (error !== null && typeof error === 'object' && 'statusCode' in error) {
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
    request.log.error({ err: error, errorCode: safeErrorCode(error) }, 'Unhandled request error');
    reply
      .code(500)
      .send(errorEnvelope(request.id, 'INTERNAL_SERVER_ERROR', 'Terjadi kesalahan internal'));
  });

  app.get('/openapi.json', async () => app.swagger());

  app.get(
    '/api/v1/health',
    {
      schema: {
        tags: ['health'],
        response: {
          200: jsonSchema(successEnvelopeSchema(healthDataSchema)),
          500: errorResponseSchema,
        },
      },
    },
    async (request) => successEnvelope(request.id, { status: 'ok' }),
  );

  app.get(
    '/api/v1/meta',
    {
      schema: {
        tags: ['health'],
        response: {
          200: jsonSchema(successEnvelopeSchema(metaDataSchema)),
          500: errorResponseSchema,
        },
      },
    },
    async (request) =>
      successEnvelope(request.id, {
        apiVersion: '1.0',
        schemaVersion: '1.0',
        service: 'tel-u-endowment-aquarium',
      }),
  );

  app.post(
    '/api/v1/auth/exchange',
    {
      schema: {
        tags: ['auth'],
        body: jsonSchema(z.object({ token: z.string().min(1) }).strict()),
        response: {
          200: jsonSchema(successEnvelopeSchema(authExchangeDataSchema)),
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const body = parseInput(z.object({ token: z.string().min(1) }).strict(), request.body);
      const authenticated = await store.authenticateToken(hashAccessToken(body.token), new Date());
      if (!authenticated)
        throw new AppError(401, 'INVALID_ACCESS_TOKEN', 'Access token tidak valid');
      return successEnvelope(request.id, {
        accessToken: body.token,
        tokenType: 'Bearer',
        expiresAt: authenticated.expiresAt?.toISOString() ?? null,
      });
    },
  );

  app.get(
    '/api/v1/me/aquarium',
    {
      schema: {
        tags: ['aquariums'],
        security: [{ bearerAuth: [] }],
        response: {
          200: jsonSchema(successEnvelopeSchema(personalAquariumSchema)),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      successEnvelope(
        request.id,
        await store.getPersonalAquarium(await authenticatedDonor(request, store), new Date()),
      ),
  );

  app.get(
    '/api/v1/aquariums/:publicSlug',
    {
      schema: {
        tags: ['aquariums'],
        response: {
          200: jsonSchema(successEnvelopeSchema(publicAquariumSchema)),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as { publicSlug?: string };
      if (!params.publicSlug) throw new AppError(400, 'VALIDATION_ERROR', 'publicSlug diperlukan');
      return successEnvelope(
        request.id,
        await store.getPublicAquarium(params.publicSlug, new Date()),
      );
    },
  );

  app.get(
    '/api/v1/big-aquarium',
    {
      schema: {
        tags: ['aquariums'],
        querystring: jsonSchema(bigAquariumQuerySchema),
        response: {
          200: jsonSchema(successEnvelopeSchema(bigAquariumSchema)),
          400: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const query = parseInput(bigAquariumQuerySchema, request.query);
      return successEnvelope(request.id, await store.getBigAquarium(query.limit, new Date()));
    },
  );

  app.post(
    '/api/v1/me/fish/:fishId/feed',
    {
      schema: {
        tags: ['fish'],
        security: [{ bearerAuth: [] }],
        response: {
          200: jsonSchema(successEnvelopeSchema(feedDataSchema)),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as { fishId?: string };
      if (!params.fishId) throw new AppError(400, 'VALIDATION_ERROR', 'fishId diperlukan');
      const result = await store.feedFish(
        await authenticatedDonor(request, store),
        params.fishId,
        new Date(),
      );
      return successEnvelope(request.id, result);
    },
  );

  app.patch(
    '/api/v1/me/fish/:fishId/appearance',
    {
      schema: {
        tags: ['fish'],
        security: [{ bearerAuth: [] }],
        body: jsonSchema(appearanceInputSchema),
        response: {
          200: jsonSchema(successEnvelopeSchema(appearanceDataSchema)),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as { fishId?: string };
      if (!params.fishId) throw new AppError(400, 'VALIDATION_ERROR', 'fishId diperlukan');
      const appearance = parseInput(appearanceInputSchema, request.body);
      const result = await store.updateAppearance(
        await authenticatedDonor(request, store),
        params.fishId,
        appearance,
        new Date(),
      );
      return successEnvelope(request.id, result);
    },
  );

  app.get(
    '/api/v1/aquariums/:publicSlug/events',
    {
      schema: {
        tags: ['game-events'],
        querystring: jsonSchema(eventsQuerySchema),
        response: {
          200: jsonSchema(successEnvelopeSchema(gameEventsPageSchema)),
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as { publicSlug?: string };
      if (!params.publicSlug) throw new AppError(400, 'VALIDATION_ERROR', 'publicSlug diperlukan');
      const query = parseInput(eventsQuerySchema, request.query);
      return successEnvelope(
        request.id,
        await store.getEvents(params.publicSlug, query.after, query.limit),
      );
    },
  );

  app.post(
    '/webhooks/v1/endowment',
    {
      config: { rawBody: true },
      schema: {
        tags: ['webhooks'],
        headers: {
          type: 'object',
          required: ['x-endowment-signature', 'x-endowment-event-id', 'x-endowment-timestamp'],
          properties: {
            'x-endowment-signature': { type: 'string' },
            'x-endowment-event-id': { type: 'string' },
            'x-endowment-timestamp': { type: 'string' },
          },
        },
        body: jsonSchema(endowmentWebhookSchema),
        response: {
          200: jsonSchema(successEnvelopeSchema(webhookAcceptedDataSchema)),
          202: jsonSchema(successEnvelopeSchema(webhookAcceptedDataSchema)),
          400: errorResponseSchema,
          401: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rawBody = rawBodyText(request);
      const signature = request.headers['x-endowment-signature'];
      const eventIdHeader = request.headers['x-endowment-event-id'];
      const timestamp = request.headers['x-endowment-timestamp'];
      if (
        typeof signature !== 'string' ||
        typeof eventIdHeader !== 'string' ||
        typeof timestamp !== 'string' ||
        !verifyWebhookSignature({
          rawBody,
          timestamp,
          signature,
          secret: options.config.webhookSecret,
          toleranceSeconds: options.config.webhookTimestampToleranceSeconds,
        })
      ) {
        throw new AppError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Signature webhook tidak valid');
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch {
        throw new AppError(400, 'INVALID_WEBHOOK_BODY', 'Payload webhook bukan JSON valid');
      }
      const event = parseInput(endowmentWebhookSchema, parsedBody);
      if (event.eventId !== eventIdHeader) {
        throw new AppError(401, 'WEBHOOK_EVENT_ID_MISMATCH', 'Event ID webhook tidak cocok');
      }
      const result = await store.processWebhook(event, parsedBody as Record<string, unknown>);
      reply.code(result.duplicate ? 200 : 202);
      return successEnvelope(request.id, {
        accepted: true,
        duplicate: result.duplicate,
        eventId: event.eventId,
      });
    },
  );

  app.addHook('onClose', async () => {
    if (connection) await connection.close();
  });

  return app;
}
