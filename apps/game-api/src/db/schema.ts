import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const donationStatusEnum = pgEnum('donation_status', [
  'pending',
  'confirmed',
  'failed',
  'refunded',
]);

export const webhookStatusEnum = pgEnum('webhook_status', [
  'received',
  'processed',
  'failed',
  'duplicate',
]);

export const fishMoodEnum = pgEnum('fish_mood', ['happy', 'neutral', 'hungry']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const donors = pgTable('donors', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalId: varchar('external_id', { length: 255 }).unique(),
  nik: varchar('nik', { length: 20 }).unique(),
  displayName: varchar('display_name', { length: 150 }),
  email: varchar('email', { length: 255 }),
  showNamePublicly: boolean('show_name_publicly').notNull().default(false),
  totalDonation: bigint('total_donation', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  tierCode: varchar('tier', { length: 30 }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  ...timestamps,
});

export const aquariums = pgTable('aquariums', {
  id: uuid('id').primaryKey().defaultRandom(),
  donorId: uuid('donor_id')
    .notNull()
    .unique()
    .references(() => donors.id),
  publicSlug: varchar('public_slug', { length: 120 }).notNull().unique(),
  name: varchar('name', { length: 150 }),
  ...timestamps,
});

export const fishTiers = pgTable(
  'fish_tiers',
  {
    code: varchar('code', { length: 30 }).primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    minAmount: bigint('min_amount', { mode: 'bigint' }).notNull(),
    maxAmount: bigint('max_amount', { mode: 'bigint' }),
    rarityOrder: integer('rarity_order').notNull().unique(),
    ...timestamps,
  },
  (table) => [
    check('fish_tiers_min_amount_check', sql`${table.minAmount} >= 0`),
    check(
      'fish_tiers_max_amount_check',
      sql`${table.maxAmount} is null or ${table.maxAmount} >= ${table.minAmount}`,
    ),
    check('fish_tiers_rarity_order_check', sql`${table.rarityOrder} > 0`),
  ],
);

export const fishSpecies = pgTable('fish_species', {
  code: varchar('code', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  defaultTierCode: varchar('default_tier_code', { length: 30 })
    .notNull()
    .references(() => fishTiers.code),
  unityAssetCode: varchar('unity_asset_code', { length: 100 }).notNull().unique(),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: varchar('source', { length: 50 }).notNull(),
    externalEventId: varchar('external_event_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signatureValid: boolean('signature_valid').notNull().default(false),
    status: webhookStatusEnum('status').notNull().default('received'),
    processingAttempts: integer('processing_attempts').notNull().default(0),
    errorMessage: text('error_message'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    unique('webhook_events_source_external_event_id_unique').on(
      table.source,
      table.externalEventId,
    ),
    check('webhook_events_processing_attempts_check', sql`${table.processingAttempts} >= 0`),
    index('webhook_events_status_received_at_idx').on(table.status, table.receivedAt),
  ],
);

export const donations = pgTable(
  'donations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    donorId: uuid('donor_id')
      .notNull()
      .references(() => donors.id),
    webhookEventId: uuid('webhook_event_id').references(() => webhookEvents.id),
    source: varchar('source', { length: 50 }).notNull(),
    externalDonationId: varchar('external_donation_id', { length: 255 }).notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('IDR'),
    status: donationStatusEnum('status').notNull().default('confirmed'),
    donatedAt: timestamp('donated_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('donations_source_external_donation_id_unique').on(
      table.source,
      table.externalDonationId,
    ),
    check('donations_amount_check', sql`${table.amount} > 0`),
    index('donations_donor_id_idx').on(table.donorId),
    index('donations_donated_at_idx').on(table.donatedAt),
    index('donations_status_idx').on(table.status),
  ],
);

export const fish = pgTable(
  'fish',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aquariumId: uuid('aquarium_id')
      .notNull()
      .references(() => aquariums.id),
    donationId: uuid('donation_id')
      .unique()
      .references(() => donations.id),
    tierCode: varchar('tier_code', { length: 30 })
      .notNull()
      .references(() => fishTiers.code),
    speciesCode: varchar('species_code', { length: 50 })
      .notNull()
      .references(() => fishSpecies.code),
    displayName: varchar('display_name', { length: 100 }),
    colorCode: varchar('color_code', { length: 50 }).notNull().default('DEFAULT'),
    accessoryCode: varchar('accessory_code', { length: 50 }).notNull().default('NONE'),
    hunger: integer('hunger').notNull().default(100),
    mood: fishMoodEnum('mood').notNull().default('happy'),
    lastFedAt: timestamp('last_fed_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    /** donation (webhook), endowment_sync (NIK login) or admin. Sync only manages its own fish. */
    source: varchar('source', { length: 20 }).notNull().default('donation'),
    /** Why the fish is inactive: refund, admin, or endowment_below_common (sync may undo only the last). */
    deactivatedReason: varchar('deactivated_reason', { length: 40 }),
    ...timestamps,
  },
  (table) => [
    check('fish_hunger_check', sql`${table.hunger} between 0 and 100`),
    index('fish_aquarium_id_idx').on(table.aquariumId),
    index('fish_tier_code_idx').on(table.tierCode),
    index('fish_species_code_idx').on(table.speciesCode),
    index('fish_is_active_created_at_idx').on(table.isActive, table.createdAt),
  ],
);

export const accessTokens = pgTable('access_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  donorId: uuid('donor_id')
    .notNull()
    .references(() => donors.id),
  tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const playerInventory = pgTable(
  'player_inventory',
  {
    donorId: uuid('donor_id')
      .primaryKey()
      .references(() => donors.id, { onDelete: 'cascade' }),
    points: integer('points').notNull().default(0),
    /** Points already granted from the donation total, so re-syncs only add the increase. */
    donationPointsGranted: integer('donation_points_granted').notNull().default(0),
    ownedAccessories: jsonb('owned_accessories')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (table) => [check('player_inventory_points_check', sql`${table.points} >= 0`)],
);

export const gameEvents = pgTable(
  'game_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    aquariumId: uuid('aquarium_id')
      .notNull()
      .references(() => aquariums.id),
    fishId: uuid('fish_id').references(() => fish.id),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('game_events_aquarium_id_id_idx').on(table.aquariumId, table.id),
    index('game_events_event_type_created_at_idx').on(table.eventType, table.createdAt),
  ],
);

/** Append-only record of every change made through the admin dashboard. */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    action: varchar('action', { length: 80 }).notNull(),
    targetType: varchar('target_type', { length: 40 }).notNull(),
    targetId: varchar('target_id', { length: 64 }).notNull(),
    changes: jsonb('changes').$type<Record<string, unknown>>().notNull().default({}),
    reason: varchar('reason', { length: 500 }),
    actorIp: varchar('actor_ip', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('admin_audit_log_created_at_idx').on(table.createdAt),
    index('admin_audit_log_target_idx').on(table.targetType, table.targetId),
  ],
);

/** One row per server-to-server Endowment lookup (no NIK stored), for dashboard health history. */
export const endowmentLookups = pgTable(
  'endowment_lookups',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    code: varchar('code', { length: 80 }),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('endowment_lookups_created_at_idx').on(table.createdAt)],
);
