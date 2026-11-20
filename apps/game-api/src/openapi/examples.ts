import type { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../shared/envelope.js';
import { jsonSchema } from '../shared/validation.js';

interface ResponseExample {
  name: string;
  summary: string;
  value: unknown;
}

/**
 * The OpenAPI generator converts `x-examples` on a response schema into named
 * media examples that Scalar renders. The API contract test enforces that
 * every documented GAME API response uses this helper.
 */
export function documentedResponse(
  schema: z.ZodType,
  examples: readonly ResponseExample[],
  description?: string,
): Record<string, unknown> {
  return {
    ...jsonSchema(schema),
    ...(description ? { 'x-response-description': description } : {}),
    'x-examples': Object.fromEntries(
      examples.map(({ name, summary, value }) => [name, { summary, value }]),
    ),
  };
}

const fishId = '11111111-1111-4111-8111-111111111111';
const aquariumId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';

const personalFish = {
  id: fishId,
  speciesCode: 'CLOWNFISH',
  assetCode: 'FISH_RARE_CLOWNFISH',
  tierCode: 'RARE',
  displayName: null,
  appearance: {
    colorCode: 'DEFAULT',
    accessoryCode: 'NONE',
  },
  state: {
    hunger: 100,
    mood: 'happy',
    isActive: true,
    lastFedAt: null,
  },
  createdAt: '2026-07-20T10:00:00.000Z',
};

const publicFish = {
  id: fishId,
  speciesCode: 'CLOWNFISH',
  assetCode: 'FISH_RARE_CLOWNFISH',
  tierCode: 'RARE',
  donorDisplayName: 'Caesar Rifqi',
  appearance: {
    colorCode: 'OCEAN_BLUE',
    accessoryCode: 'TELU_CAP',
  },
};

const personalAquarium = {
  aquariumId,
  publicSlug: 'aqr-abc12345',
  name: "Caesar's Aquarium",
  owner: { displayName: 'Caesar Rifqi' },
  statistics: { fishCount: 1, highestTier: 'RARE' },
  fish: [personalFish],
  syncCursor: 20,
};

const publicAquarium = {
  aquariumId,
  publicSlug: 'aqr-abc12345',
  name: "Caesar's Aquarium",
  owner: { displayName: 'Caesar Rifqi' },
  statistics: { fishCount: 1, highestTier: 'RARE' },
  fish: [personalFish],
  syncCursor: 20,
};

const bigAquarium = {
  mode: 'EXHIBITION',
  refreshAfterSeconds: 60,
  syncCursor: 20,
  fish: [publicFish],
};

const fedFish = {
  ...personalFish,
  state: {
    ...personalFish.state,
    lastFedAt: '2026-07-20T14:00:00.000Z',
  },
};

const appearanceFish = {
  ...personalFish,
  appearance: {
    colorCode: 'OCEAN_BLUE',
    accessoryCode: 'TELU_CAP',
  },
};

const gameEventsPage = {
  events: [
    {
      cursor: 20,
      eventType: 'fish.customized',
      fishId,
      payload: {
        colorCode: 'OCEAN_BLUE',
        accessoryCode: 'TELU_CAP',
      },
      createdAt: '2026-07-20T14:00:00.000Z',
    },
  ],
  nextCursor: 20,
  hasMore: false,
};

const emptyGameEventsPage = {
  events: [],
  nextCursor: 20,
  hasMore: false,
};

export const responseExamples = {
  health: [
    {
      name: 'healthy',
      summary: 'GAME API is healthy',
      value: successEnvelope('req_123', { status: 'ok' }),
    },
  ],
  meta: [
    {
      name: 'metadata',
      summary: 'GAME API metadata',
      value: successEnvelope('req_123', {
        apiVersion: '1.0',
        schemaVersion: '1.0',
        service: 'tel-u-endowment-aquarium',
      }),
    },
  ],
  authExchange: [
    {
      name: 'token',
      summary: 'Exchanged bearer token',
      value: successEnvelope('req_123', {
        accessToken: 'raw-magic-token',
        tokenType: 'Bearer',
        expiresAt: null,
      }),
    },
  ],
  personalAquarium: [
    {
      name: 'aquarium',
      summary: 'Personal aquarium with one fish',
      value: successEnvelope('req_123', personalAquarium),
    },
  ],
  publicAquarium: [
    {
      name: 'publicAquarium',
      summary: 'Public aquarium',
      value: successEnvelope('req_123', publicAquarium),
    },
  ],
  bigAquarium: [
    {
      name: 'exhibition',
      summary: 'Big Aquarium exhibition feed',
      value: successEnvelope('req_123', bigAquarium),
    },
  ],
  feed: [
    {
      name: 'fed',
      summary: 'Fish fed successfully',
      value: successEnvelope('req_123', {
        fish: fedFish,
        nextFeedAt: '2026-07-20T18:00:00.000Z',
      }),
    },
  ],
  appearance: [
    {
      name: 'customized',
      summary: 'Fish appearance updated',
      value: successEnvelope('req_123', { fish: appearanceFish }),
    },
  ],
  events: [
    {
      name: 'events',
      summary: 'Incremental game events',
      value: successEnvelope('req_123', gameEventsPage),
    },
    {
      name: 'empty',
      summary: 'No events after the cursor',
      value: successEnvelope('req_123', emptyGameEventsPage),
    },
  ],
  authNik: [
    {
      name: 'nikLogin',
      summary: 'Donor authenticated from the Endowment NIK lookup',
      value: successEnvelope('req_123', {
        accessToken: 'raw-magic-token',
        tokenType: 'Bearer',
        expiresAt: '2026-07-27T10:00:00.000Z',
        donor: {
          nik: '3171010101010004',
          name: 'Dewi Lestari',
          tierCode: 'LEGENDARY',
          totalDonation: 30_000_000,
        },
      }),
    },
  ],
  inventory: [
    {
      name: 'inventory',
      summary: 'Points and owned accessories for the authenticated donor',
      value: successEnvelope('req_123', {
        points: 3_000,
        ownedAccessories: [],
      }),
    },
  ],
  webhookAccepted: [
    {
      name: 'accepted',
      summary: 'New webhook accepted for processing',
      value: successEnvelope('req_123', {
        accepted: true,
        duplicate: false,
        eventId,
      }),
    },
    {
      name: 'duplicate',
      summary: 'Duplicate webhook accepted idempotently',
      value: successEnvelope('req_123', {
        accepted: true,
        duplicate: true,
        eventId,
      }),
    },
  ],
} as const;

export const errorExamples = {
  internal: [
    {
      name: 'internalServerError',
      summary: 'Unexpected GAME API failure',
      value: errorEnvelope('req_123', 'INTERNAL_SERVER_ERROR', 'Terjadi kesalahan internal'),
    },
  ],
  validation: [
    {
      name: 'validationError',
      summary: 'Invalid request input',
      value: errorEnvelope('req_123', 'VALIDATION_ERROR', 'Input tidak valid', [
        { code: 'too_big', path: ['limit'], message: 'Too big: expected number to be <=50' },
      ]),
    },
  ],
  invalidToken: [
    {
      name: 'invalidAccessToken',
      summary: 'Invalid bearer token',
      value: errorEnvelope('req_123', 'INVALID_ACCESS_TOKEN', 'Access token tidak valid'),
    },
  ],
  authenticationRequired: [
    {
      name: 'authenticationRequired',
      summary: 'Bearer token is missing',
      value: errorEnvelope('req_123', 'AUTHENTICATION_REQUIRED', 'Bearer token diperlukan'),
    },
  ],
  aquariumNotFound: [
    {
      name: 'aquariumNotFound',
      summary: 'Aquarium was not found',
      value: errorEnvelope('req_123', 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan'),
    },
  ],
  fishNotFound: [
    {
      name: 'fishNotFound',
      summary: 'Fish was not found',
      value: errorEnvelope('req_123', 'FISH_NOT_FOUND', 'Fish tidak ditemukan'),
    },
  ],
  feedingCooldown: [
    {
      name: 'feedingCooldown',
      summary: 'Fish cannot be fed again yet',
      value: errorEnvelope('req_123', 'FEEDING_COOLDOWN_ACTIVE', 'Feeding masih dalam cooldown', {
        nextFeedAt: '2026-07-20T18:00:00.000Z',
      }),
    },
  ],
  fishInactive: [
    {
      name: 'fishInactive',
      summary: 'Inactive fish cannot be changed',
      value: errorEnvelope('req_123', 'FISH_INACTIVE', 'Fish sudah tidak aktif'),
    },
  ],
  donorNotFound: [
    {
      name: 'donorNotFound',
      summary: 'NIK was not found in the Endowment API',
      value: errorEnvelope('req_123', 'DONOR_NOT_FOUND', 'Donor tidak ditemukan di Endowment'),
    },
  ],
  endowmentUnavailable: [
    {
      name: 'endowmentUnavailable',
      summary: 'Endowment API cannot be reached',
      value: errorEnvelope(
        'req_123',
        'ENDOWMENT_UNAVAILABLE',
        'Layanan Endowment sedang bermasalah',
      ),
    },
  ],
  endowmentAuthFailed: [
    {
      name: 'endowmentAuthFailed',
      summary: 'GAME API ticket was rejected by Endowment',
      value: errorEnvelope('req_123', 'ENDOWMENT_AUTH_FAILED', 'Kredensial API Endowment ditolak'),
    },
  ],
  invalidWebhookSignature: [
    {
      name: 'invalidWebhookSignature',
      summary: 'Webhook signature rejected',
      value: errorEnvelope('req_123', 'INVALID_WEBHOOK_SIGNATURE', 'Signature webhook tidak valid'),
    },
  ],
  invalidWebhookBody: [
    {
      name: 'invalidWebhookBody',
      summary: 'Webhook body is not valid JSON',
      value: errorEnvelope('req_123', 'INVALID_WEBHOOK_BODY', 'Payload webhook bukan JSON valid'),
    },
  ],
  webhookEventIdMismatch: [
    {
      name: 'webhookEventIdMismatch',
      summary: 'Webhook event ID does not match the header',
      value: errorEnvelope('req_123', 'WEBHOOK_EVENT_ID_MISMATCH', 'Event ID webhook tidak cocok'),
    },
  ],
  noMatchingTier: [
    {
      name: 'noMatchingTier',
      summary: 'Donation amount has no matching fish tier',
      value: errorEnvelope(
        'req_123',
        'NO_MATCHING_TIER',
        'Nominal donasi tidak memiliki tier ikan',
      ),
    },
  ],
} as const;
