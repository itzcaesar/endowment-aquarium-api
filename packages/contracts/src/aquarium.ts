import { z } from 'zod';

import { personalFishSchema, publicFishSchema, tierCodeSchema } from './fish.js';

export const bigAquariumQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

export const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const aquariumStatisticsSchema = z.object({
  fishCount: z.number().int().min(0),
  highestTier: tierCodeSchema.nullable(),
});

export const personalAquariumSchema = z.object({
  aquariumId: z.uuid(),
  publicSlug: z.string(),
  name: z.string().nullable(),
  owner: z.object({ displayName: z.string().nullable() }),
  statistics: aquariumStatisticsSchema,
  fish: z.array(personalFishSchema),
  syncCursor: z.number().int().min(0),
});

export const publicAquariumSchema = z.object({
  aquariumId: z.uuid(),
  publicSlug: z.string(),
  name: z.string().nullable(),
  owner: z.object({ displayName: z.string() }),
  statistics: aquariumStatisticsSchema,
  fish: z.array(personalFishSchema),
  syncCursor: z.number().int().min(0),
});

export const bigAquariumSchema = z.object({
  mode: z.literal('EXHIBITION'),
  refreshAfterSeconds: z.literal(60),
  syncCursor: z.number().int().min(0),
  fish: z.array(publicFishSchema),
});

export const gameEventSchema = z.object({
  cursor: z.number().int().positive(),
  eventType: z.string(),
  fishId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});

export const gameEventsPageSchema = z.object({
  events: z.array(gameEventSchema),
  nextCursor: z.number().int().min(0),
  hasMore: z.boolean(),
});

export type BigAquariumQuery = z.infer<typeof bigAquariumQuerySchema>;
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
export type PersonalAquarium = z.infer<typeof personalAquariumSchema>;
export type PublicAquarium = z.infer<typeof publicAquariumSchema>;
export type BigAquarium = z.infer<typeof bigAquariumSchema>;
export type GameEventsPage = z.infer<typeof gameEventsPageSchema>;
