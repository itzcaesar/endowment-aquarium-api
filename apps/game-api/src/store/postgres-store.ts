import { randomBytes } from 'node:crypto';

import type {
  AppearanceInput,
  BigAquarium,
  EndowmentWebhook,
  GameEventsPage,
  Inventory,
  PersonalAquarium,
  PersonalFish,
  PublicAquarium,
  TierCode,
} from '@telu/contracts';
import { accessoryCodeSchema, colorCodeSchema, tierCodeSchema } from '@telu/contracts';
import { and, asc, desc, eq, gt, isNull, max, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { calculateHunger, moodForHunger } from '../modules/fish/hunger-service.js';
import { resolveTier } from '../modules/tiers/tier-service.js';
import { AppError } from '../shared/errors.js';
import type { DatabaseConnection } from '../db/client.js';
import * as schema from '../db/schema.js';
import { publicDonorName } from '../modules/donors/privacy-service.js';
import type {
  AppStore,
  AppearanceResult,
  AuthenticatedToken,
  DonorSyncInput,
  FeedFishResult,
  IssuedAccessToken,
  StoreStats,
  SyncedDonor,
  WebhookProcessingResult,
} from './types.js';
import { hourlyBuckets } from '../modules/dashboard/hourly-buckets.js';

type AppDatabase = PostgresJsDatabase<typeof schema>;
type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

const SOURCE = 'endowment';
const FEED_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const MAX_POINTS = 2_147_483_647;

interface FishRow {
  id: string;
  speciesCode: string;
  assetCode: string;
  tierCode: string;
  displayName: string | null;
  colorCode: string;
  accessoryCode: string;
  hunger: number;
  mood: string;
  lastFedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
}

function safeCursor(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new AppError(500, 'CURSOR_OVERFLOW', 'Cursor tidak dapat diserialisasi dengan aman');
  }
  return numeric;
}

function toIso(date: Date | null): string | null {
  return date?.toISOString() ?? null;
}

function toPersonalFish(row: FishRow, now: Date): PersonalFish {
  const hunger = calculateHunger(row.hunger, row.lastFedAt ?? row.createdAt, now);
  return {
    id: row.id,
    speciesCode: row.speciesCode,
    assetCode: row.assetCode,
    tierCode: tierCodeSchema.parse(row.tierCode),
    displayName: row.displayName,
    appearance: {
      colorCode: colorCodeSchema.parse(row.colorCode),
      accessoryCode: accessoryCodeSchema.parse(row.accessoryCode),
    },
    state: {
      hunger,
      mood: moodForHunger(hunger),
      isActive: row.isActive,
      lastFedAt: toIso(row.lastFedAt),
    },
    createdAt: row.createdAt.toISOString(),
  };
}

function toPublicFish(row: {
  id: string;
  speciesCode: string;
  assetCode: string;
  tierCode: string;
  donorDisplayName: string;
  colorCode: string;
  accessoryCode: string;
}): BigAquarium['fish'][number] {
  return {
    id: row.id,
    speciesCode: row.speciesCode,
    assetCode: row.assetCode,
    tierCode: tierCodeSchema.parse(row.tierCode),
    donorDisplayName: row.donorDisplayName,
    appearance: {
      colorCode: colorCodeSchema.parse(row.colorCode),
      accessoryCode: accessoryCodeSchema.parse(row.accessoryCode),
    },
  };
}

function highestTier(
  fishRows: readonly { tierCode: string; rarityOrder: number }[],
): TierCode | null {
  const highest = [...fishRows].sort((left, right) => right.rarityOrder - left.rarityOrder)[0];
  return highest ? tierCodeSchema.parse(highest.tierCode) : null;
}

export class PostgresStore implements AppStore {
  public constructor(private readonly connection: DatabaseConnection) {}

  public async close(): Promise<void> {
    await this.connection.close();
  }

  private get db(): AppDatabase {
    return this.connection.db;
  }

  private async aquariumBySlug(publicSlug: string) {
    const rows = await this.db
      .select({
        id: schema.aquariums.id,
        donorId: schema.aquariums.donorId,
        publicSlug: schema.aquariums.publicSlug,
        name: schema.aquariums.name,
        displayName: schema.donors.displayName,
        showNamePublicly: schema.donors.showNamePublicly,
      })
      .from(schema.aquariums)
      .innerJoin(schema.donors, eq(schema.donors.id, schema.aquariums.donorId))
      .where(eq(schema.aquariums.publicSlug, publicSlug))
      .limit(1);
    return rows[0] ?? null;
  }

  private async fishRowsForAquarium(
    database: AppDatabase | AppTransaction,
    aquariumId: string,
    includeInactive: boolean,
  ): Promise<(FishRow & { rarityOrder: number })[]> {
    const rows = await database
      .select({
        id: schema.fish.id,
        speciesCode: schema.fishSpecies.code,
        assetCode: schema.fishSpecies.unityAssetCode,
        tierCode: schema.fish.tierCode,
        displayName: schema.fish.displayName,
        colorCode: schema.fish.colorCode,
        accessoryCode: schema.fish.accessoryCode,
        hunger: schema.fish.hunger,
        mood: schema.fish.mood,
        lastFedAt: schema.fish.lastFedAt,
        isActive: schema.fish.isActive,
        createdAt: schema.fish.createdAt,
        rarityOrder: schema.fishTiers.rarityOrder,
      })
      .from(schema.fish)
      .innerJoin(schema.fishSpecies, eq(schema.fishSpecies.code, schema.fish.speciesCode))
      .innerJoin(schema.fishTiers, eq(schema.fishTiers.code, schema.fish.tierCode))
      .where(
        includeInactive
          ? eq(schema.fish.aquariumId, aquariumId)
          : and(eq(schema.fish.aquariumId, aquariumId), eq(schema.fish.isActive, true)),
      )
      .orderBy(desc(schema.fish.createdAt));
    return rows;
  }

  private async aquariumCursor(
    database: AppDatabase | AppTransaction,
    aquariumId: string,
  ): Promise<number> {
    const rows = await database
      .select({ cursor: max(schema.gameEvents.id) })
      .from(schema.gameEvents)
      .where(eq(schema.gameEvents.aquariumId, aquariumId));
    return safeCursor(rows[0]?.cursor);
  }

  private async globalCursor(database: AppDatabase | AppTransaction): Promise<number> {
    const rows = await database
      .select({ cursor: max(schema.gameEvents.id) })
      .from(schema.gameEvents);
    return safeCursor(rows[0]?.cursor);
  }

  public async getPersonalAquarium(donorId: string, now: Date): Promise<PersonalAquarium> {
    const rows = await this.db
      .select({
        aquariumId: schema.aquariums.id,
        publicSlug: schema.aquariums.publicSlug,
        name: schema.aquariums.name,
        displayName: schema.donors.displayName,
      })
      .from(schema.aquariums)
      .innerJoin(schema.donors, eq(schema.donors.id, schema.aquariums.donorId))
      .where(eq(schema.aquariums.donorId, donorId))
      .limit(1);
    const aquarium = rows[0];
    if (!aquarium) throw new AppError(404, 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan');

    const fishRows = await this.fishRowsForAquarium(this.db, aquarium.aquariumId, true);
    const activeRows = fishRows.filter((row) => row.isActive);
    return {
      aquariumId: aquarium.aquariumId,
      publicSlug: aquarium.publicSlug,
      name: aquarium.name,
      owner: { displayName: aquarium.displayName },
      statistics: {
        fishCount: activeRows.length,
        highestTier: highestTier(activeRows),
      },
      fish: fishRows.map((row) => toPersonalFish(row, now)),
      syncCursor: await this.aquariumCursor(this.db, aquarium.aquariumId),
    };
  }

  public async getPublicAquarium(publicSlug: string, now: Date): Promise<PublicAquarium> {
    const aquarium = await this.aquariumBySlug(publicSlug);
    if (!aquarium) throw new AppError(404, 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan');

    const fishRows = await this.fishRowsForAquarium(this.db, aquarium.id, false);
    return {
      aquariumId: aquarium.id,
      publicSlug: aquarium.publicSlug,
      name: aquarium.name,
      owner: {
        displayName: publicDonorName(aquarium.displayName, aquarium.showNamePublicly),
      },
      statistics: {
        fishCount: fishRows.length,
        highestTier: highestTier(fishRows),
      },
      fish: fishRows.map((row) => toPersonalFish(row, now)),
      syncCursor: await this.aquariumCursor(this.db, aquarium.id),
    };
  }

  public async getBigAquarium(limit: number): Promise<BigAquarium> {
    const rows = await this.db
      .selectDistinctOn([schema.donors.id], {
        id: schema.fish.id,
        speciesCode: schema.fishSpecies.code,
        assetCode: schema.fishSpecies.unityAssetCode,
        tierCode: schema.fish.tierCode,
        donorDisplayName: schema.donors.displayName,
        showNamePublicly: schema.donors.showNamePublicly,
        colorCode: schema.fish.colorCode,
        accessoryCode: schema.fish.accessoryCode,
      })
      .from(schema.fish)
      .innerJoin(schema.aquariums, eq(schema.aquariums.id, schema.fish.aquariumId))
      .innerJoin(schema.donors, eq(schema.donors.id, schema.aquariums.donorId))
      .innerJoin(schema.fishSpecies, eq(schema.fishSpecies.code, schema.fish.speciesCode))
      .where(eq(schema.fish.isActive, true))
      .orderBy(schema.donors.id, desc(schema.fish.createdAt))
      .limit(limit);

    return {
      mode: 'EXHIBITION',
      refreshAfterSeconds: 60,
      syncCursor: await this.globalCursor(this.db),
      fish: rows.map((row) =>
        toPublicFish({
          ...row,
          donorDisplayName: publicDonorName(row.donorDisplayName, row.showNamePublicly),
        }),
      ),
    };
  }

  public async authenticateToken(tokenHash: string, now: Date): Promise<AuthenticatedToken | null> {
    const rows = await this.db
      .select({ donorId: schema.accessTokens.donorId, expiresAt: schema.accessTokens.expiresAt })
      .from(schema.accessTokens)
      .where(
        and(
          eq(schema.accessTokens.tokenHash, tokenHash),
          isNull(schema.accessTokens.revokedAt),
          or(isNull(schema.accessTokens.expiresAt), gt(schema.accessTokens.expiresAt, now)),
        ),
      )
      .limit(1);
    const token = rows[0];
    if (!token) return null;
    await this.db
      .update(schema.accessTokens)
      .set({ usedAt: sql`coalesce(${schema.accessTokens.usedAt}, now())` })
      .where(eq(schema.accessTokens.tokenHash, tokenHash));
    return token;
  }

  public async issueAccessToken(
    donorExternalId: string,
    tokenHash: string,
    expiresAt: Date | null,
  ): Promise<IssuedAccessToken> {
    const donorRows = await this.db
      .select({ id: schema.donors.id })
      .from(schema.donors)
      .where(eq(schema.donors.externalId, donorExternalId))
      .limit(1);
    const donor = donorRows[0];
    if (!donor) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan');
    return this.issueAccessTokenForDonor(donor.id, tokenHash, expiresAt);
  }

  public async issueAccessTokenForDonor(
    donorId: string,
    tokenHash: string,
    expiresAt: Date | null,
  ): Promise<IssuedAccessToken> {
    const rows = await this.db
      .insert(schema.accessTokens)
      .values({ donorId, tokenHash, expiresAt })
      .returning({
        donorId: schema.accessTokens.donorId,
        expiresAt: schema.accessTokens.expiresAt,
      });
    const issued = rows[0];
    if (!issued) throw new AppError(500, 'TOKEN_ISSUE_FAILED', 'Token tidak dapat dibuat');
    return issued;
  }

  public async syncDonor(input: DonorSyncInput, now: Date): Promise<SyncedDonor> {
    const totalDonation = BigInt(input.totalDonation);
    return this.db.transaction(async (tx) => {
      const tierRows = await tx
        .select({
          code: schema.fishTiers.code,
          minAmount: schema.fishTiers.minAmount,
          maxAmount: schema.fishTiers.maxAmount,
          rarityOrder: schema.fishTiers.rarityOrder,
        })
        .from(schema.fishTiers)
        .orderBy(asc(schema.fishTiers.rarityOrder));
      const tier = resolveTier(
        totalDonation,
        tierRows.map((row) => ({ ...row, code: tierCodeSchema.parse(row.code) })),
      );

      const findDonor = async () =>
        (
          await tx
            .select({ id: schema.donors.id, tierCode: schema.donors.tierCode })
            .from(schema.donors)
            .where(or(eq(schema.donors.nik, input.nik), eq(schema.donors.externalId, input.nik)))
            .limit(1)
        )[0];

      // Insert-if-missing is idempotent: a concurrent first login for the same NIK waits on the
      // unique index, does nothing, and then reads the row the other request created.
      let existing = await findDonor();
      const isNewDonor = !existing;
      if (!existing) {
        await tx
          .insert(schema.donors)
          .values({
            nik: input.nik,
            externalId: input.nik,
            displayName: input.name,
            showNamePublicly: true,
            totalDonation,
            tierCode: tier?.code ?? null,
            lastSyncedAt: now,
          })
          .onConflictDoNothing();
        existing = await findDonor();
      }
      if (!existing) throw new AppError(500, 'DONOR_UPSERT_FAILED', 'Donor tidak dapat disimpan');
      const donorId = existing.id;

      // Serialise syncs for the same donor so points and fish are not double-applied.
      const locked = await tx
        .select({ tierCode: schema.donors.tierCode })
        .from(schema.donors)
        .where(eq(schema.donors.id, donorId))
        .for('update');
      const previousTier = isNewDonor ? null : (locked[0]?.tierCode ?? existing.tierCode);
      await tx
        .update(schema.donors)
        .set({
          nik: input.nik,
          displayName: input.name,
          totalDonation,
          tierCode: tier?.code ?? null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.donors.id, donorId));

      const publicSlug = `aqr-${randomBytes(9).toString('base64url')}`;
      await tx
        .insert(schema.aquariums)
        .values({ donorId, publicSlug })
        .onConflictDoNothing({ target: schema.aquariums.donorId });
      const aquariumRows = await tx
        .select({ id: schema.aquariums.id, publicSlug: schema.aquariums.publicSlug })
        .from(schema.aquariums)
        .where(eq(schema.aquariums.donorId, donorId))
        .limit(1);
      const aquarium = aquariumRows[0];
      if (!aquarium)
        throw new AppError(500, 'AQUARIUM_CREATE_FAILED', 'Aquarium tidak dapat dibuat');

      // Points: only the increase in donation-derived points since the last grant is added, so
      // admin adjustments (and spending) are never undone by a later login.
      await tx
        .insert(schema.playerInventory)
        .values({ donorId })
        .onConflictDoNothing({ target: schema.playerInventory.donorId });
      const inventoryRows = await tx
        .select({
          points: schema.playerInventory.points,
          granted: schema.playerInventory.donationPointsGranted,
        })
        .from(schema.playerInventory)
        .where(eq(schema.playerInventory.donorId, donorId))
        .limit(1);
      const inventory = inventoryRows[0] ?? { points: 0, granted: 0 };
      const earned = Math.min(MAX_POINTS, Math.floor(input.totalDonation / 10_000));
      if (earned > inventory.granted) {
        await tx
          .update(schema.playerInventory)
          .set({
            points: Math.min(MAX_POINTS, inventory.points + (earned - inventory.granted)),
            donationPointsGranted: earned,
            updatedAt: now,
          })
          .where(eq(schema.playerInventory.donorId, donorId));
      }

      // Fish: sync manages only the fish it created. Donation and admin fish are never touched,
      // and an admin's deactivation or tier override stands until the donor's real tier changes.
      const syncRows = await tx
        .select({
          id: schema.fish.id,
          tierCode: schema.fish.tierCode,
          isActive: schema.fish.isActive,
          deactivatedReason: schema.fish.deactivatedReason,
        })
        .from(schema.fish)
        .where(
          and(eq(schema.fish.aquariumId, aquarium.id), eq(schema.fish.source, 'endowment_sync')),
        )
        .orderBy(desc(schema.fish.createdAt))
        .limit(1);
      const syncFish = syncRows[0];
      const tierChanged = (tier?.code ?? null) !== previousTier;
      const event = (fishId: string, eventType: string, payload: Record<string, unknown>) =>
        tx
          .insert(schema.gameEvents)
          .values({ aquariumId: aquarium.id, fishId, eventType, payload });

      if (tier) {
        const speciesRows = await tx
          .select({ code: schema.fishSpecies.code })
          .from(schema.fishSpecies)
          .where(
            and(
              eq(schema.fishSpecies.defaultTierCode, tier.code),
              eq(schema.fishSpecies.active, true),
            ),
          )
          .orderBy(asc(schema.fishSpecies.code))
          .limit(1);
        const species = speciesRows[0];
        if (!species)
          throw new AppError(500, 'SPECIES_NOT_CONFIGURED', 'Species untuk tier belum tersedia');
        const payload = {
          tierCode: tier.code,
          speciesCode: species.code,
          source: 'endowment.sync',
        };

        if (!syncFish) {
          const created = await tx
            .insert(schema.fish)
            .values({
              aquariumId: aquarium.id,
              donationId: null,
              tierCode: tier.code,
              speciesCode: species.code,
              source: 'endowment_sync',
            })
            .returning({ id: schema.fish.id });
          const createdFish = created[0];
          if (!createdFish)
            throw new AppError(500, 'FISH_CREATE_FAILED', 'Fish tidak dapat dibuat');
          await event(createdFish.id, 'fish.created', payload);
        } else if (!syncFish.isActive && syncFish.deactivatedReason === 'endowment_below_common') {
          // Only undo deactivations that sync itself made; admin/refund deactivations stand.
          await tx
            .update(schema.fish)
            .set({
              isActive: true,
              deactivatedReason: null,
              tierCode: tier.code,
              speciesCode: species.code,
              updatedAt: now,
            })
            .where(eq(schema.fish.id, syncFish.id));
          await event(syncFish.id, 'fish.created', { ...payload, reactivated: true });
        } else if (syncFish.isActive && tierChanged && syncFish.tierCode !== tier.code) {
          await tx
            .update(schema.fish)
            .set({ tierCode: tier.code, speciesCode: species.code, updatedAt: now })
            .where(eq(schema.fish.id, syncFish.id));
          await event(syncFish.id, 'fish.tier_changed', payload);
        }
      } else if (syncFish?.isActive) {
        await tx
          .update(schema.fish)
          .set({ isActive: false, deactivatedReason: 'endowment_below_common', updatedAt: now })
          .where(eq(schema.fish.id, syncFish.id));
        await event(syncFish.id, 'fish.deactivated', { reason: 'endowment.total_below_common' });
      }

      return {
        donorId,
        nik: input.nik,
        name: input.name,
        tierCode: tier ? tierCodeSchema.parse(tier.code) : null,
        totalDonation: input.totalDonation,
        publicSlug: aquarium.publicSlug,
      };
    });
  }

  public async getStats(now: Date): Promise<StoreStats> {
    const sqlClient = this.connection.sql;
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const windowStart = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const [donorRows, tierRows, donationRows, webhookRows, pointRows, hourlyRows, recentRows] =
      await Promise.all([
        sqlClient<{ total: number; nik_synced: number; synced_24h: number }[]>`
          select count(*)::int as total,
                 count(nik)::int as nik_synced,
                 count(*) filter (where last_synced_at >= ${dayAgo}::timestamptz)::int as synced_24h
          from donors`,
        sqlClient<{ code: string; count: number }[]>`
          select t.code, count(f.id)::int as count
          from fish_tiers t
          left join fish f on f.tier_code = t.code and f.is_active
          group by t.code, t.rarity_order
          order by t.rarity_order`,
        sqlClient<{ status: string; count: number }[]>`
          select status::text as status, count(*)::int as count from donations group by status`,
        sqlClient<{ status: string; count: number; last_24h: number }[]>`
          select status::text as status, count(*)::int as count,
                 count(*) filter (where received_at >= ${dayAgo}::timestamptz)::int as last_24h
          from webhook_events group by status`,
        sqlClient<{ points: string }[]>`
          select coalesce(sum(points), 0)::text as points from player_inventory`,
        sqlClient<{ created_at: Date | string }[]>`
          select created_at from game_events
          where created_at >= ${windowStart}::timestamptz`,
        sqlClient<
          {
            id: number;
            event_type: string;
            tier_code: string | null;
            public_slug: string;
            created_at: Date | string;
          }[]
        >`
          select e.id::int as id, e.event_type, f.tier_code, a.public_slug, e.created_at
          from game_events e
          join aquariums a on a.id = e.aquarium_id
          left join fish f on f.id = e.fish_id
          order by e.id desc
          limit 12`,
      ]);

    const donors = donorRows[0];
    const countFor = (rows: { status: string; count: number }[], status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;
    return {
      donors: {
        total: donors?.total ?? 0,
        nikSynced: donors?.nik_synced ?? 0,
        syncedLast24h: donors?.synced_24h ?? 0,
      },
      fishByTier: tierRows.map((row) => ({
        tierCode: tierCodeSchema.parse(row.code),
        count: row.count,
      })),
      donations: {
        confirmed: countFor(donationRows, 'confirmed'),
        refunded: countFor(donationRows, 'refunded'),
      },
      webhooks: {
        received: countFor(webhookRows, 'received'),
        processed: countFor(webhookRows, 'processed'),
        duplicate: countFor(webhookRows, 'duplicate'),
        failed: countFor(webhookRows, 'failed'),
        last24h: webhookRows.reduce((sum, row) => sum + row.last_24h, 0),
      },
      inventoryPoints: Number(pointRows[0]?.points ?? 0),
      hourlyEvents: hourlyBuckets(
        now,
        hourlyRows.map((row) => new Date(row.created_at)),
      ),
      recentEvents: recentRows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        tierCode: row.tier_code,
        publicSlug: row.public_slug,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  }

  public async getInventory(donorId: string): Promise<Inventory> {
    await this.db
      .insert(schema.playerInventory)
      .values({ donorId })
      .onConflictDoNothing({ target: schema.playerInventory.donorId });
    const rows = await this.db
      .select({
        points: schema.playerInventory.points,
        ownedAccessories: schema.playerInventory.ownedAccessories,
      })
      .from(schema.playerInventory)
      .where(eq(schema.playerInventory.donorId, donorId))
      .limit(1);
    const inventory = rows[0];
    if (!inventory)
      throw new AppError(500, 'INVENTORY_UNAVAILABLE', 'Inventory tidak dapat dibaca');
    return inventory;
  }

  public async feedFish(donorId: string, fishId: string, now: Date): Promise<FeedFishResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: schema.fish.id,
          aquariumId: schema.fish.aquariumId,
          speciesCode: schema.fishSpecies.code,
          assetCode: schema.fishSpecies.unityAssetCode,
          tierCode: schema.fish.tierCode,
          displayName: schema.fish.displayName,
          colorCode: schema.fish.colorCode,
          accessoryCode: schema.fish.accessoryCode,
          hunger: schema.fish.hunger,
          mood: schema.fish.mood,
          lastFedAt: schema.fish.lastFedAt,
          isActive: schema.fish.isActive,
          createdAt: schema.fish.createdAt,
          donorId: schema.aquariums.donorId,
        })
        .from(schema.fish)
        .innerJoin(schema.aquariums, eq(schema.aquariums.id, schema.fish.aquariumId))
        .innerJoin(schema.fishSpecies, eq(schema.fishSpecies.code, schema.fish.speciesCode))
        .where(and(eq(schema.fish.id, fishId), eq(schema.aquariums.donorId, donorId)))
        .limit(1);
      const fishRow = rows[0];
      if (!fishRow) throw new AppError(404, 'FISH_NOT_FOUND', 'Fish tidak ditemukan');
      if (!fishRow.isActive) throw new AppError(409, 'FISH_INACTIVE', 'Fish sudah tidak aktif');
      if (fishRow.lastFedAt && now.getTime() - fishRow.lastFedAt.getTime() < FEED_COOLDOWN_MS) {
        const nextFeedAt = new Date(fishRow.lastFedAt.getTime() + FEED_COOLDOWN_MS);
        throw new AppError(409, 'FEEDING_COOLDOWN_ACTIVE', 'Feeding masih dalam cooldown', {
          nextFeedAt: nextFeedAt.toISOString(),
        });
      }

      await tx
        .update(schema.fish)
        .set({ hunger: 100, mood: 'happy', lastFedAt: now, updatedAt: now })
        .where(eq(schema.fish.id, fishId));
      await tx.insert(schema.gameEvents).values({
        aquariumId: fishRow.aquariumId,
        fishId,
        eventType: 'fish.fed',
        payload: { hunger: 100, mood: 'happy', lastFedAt: now.toISOString() },
      });

      const personalFish = toPersonalFish(
        {
          ...fishRow,
          mood: 'happy',
          hunger: 100,
          lastFedAt: now,
        },
        now,
      );
      return {
        fish: personalFish,
        nextFeedAt: new Date(now.getTime() + FEED_COOLDOWN_MS).toISOString(),
      };
    });
  }

  public async updateAppearance(
    donorId: string,
    fishId: string,
    appearance: AppearanceInput,
    now: Date,
  ): Promise<AppearanceResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: schema.fish.id,
          aquariumId: schema.fish.aquariumId,
          speciesCode: schema.fishSpecies.code,
          assetCode: schema.fishSpecies.unityAssetCode,
          tierCode: schema.fish.tierCode,
          displayName: schema.fish.displayName,
          colorCode: schema.fish.colorCode,
          accessoryCode: schema.fish.accessoryCode,
          hunger: schema.fish.hunger,
          mood: schema.fish.mood,
          lastFedAt: schema.fish.lastFedAt,
          isActive: schema.fish.isActive,
          createdAt: schema.fish.createdAt,
        })
        .from(schema.fish)
        .innerJoin(schema.aquariums, eq(schema.aquariums.id, schema.fish.aquariumId))
        .innerJoin(schema.fishSpecies, eq(schema.fishSpecies.code, schema.fish.speciesCode))
        .where(and(eq(schema.fish.id, fishId), eq(schema.aquariums.donorId, donorId)))
        .limit(1);
      const fishRow = rows[0];
      if (!fishRow) throw new AppError(404, 'FISH_NOT_FOUND', 'Fish tidak ditemukan');
      if (!fishRow.isActive) throw new AppError(409, 'FISH_INACTIVE', 'Fish sudah tidak aktif');

      await tx
        .update(schema.fish)
        .set({
          colorCode: appearance.colorCode,
          accessoryCode: appearance.accessoryCode,
          updatedAt: now,
        })
        .where(eq(schema.fish.id, fishId));
      await tx.insert(schema.gameEvents).values({
        aquariumId: fishRow.aquariumId,
        fishId,
        eventType: 'fish.customized',
        payload: { colorCode: appearance.colorCode, accessoryCode: appearance.accessoryCode },
      });
      return {
        fish: toPersonalFish(
          { ...fishRow, colorCode: appearance.colorCode, accessoryCode: appearance.accessoryCode },
          now,
        ),
      };
    });
  }

  public async getEvents(
    publicSlug: string,
    after: number,
    limit: number,
  ): Promise<GameEventsPage> {
    const aquarium = await this.aquariumBySlug(publicSlug);
    if (!aquarium) throw new AppError(404, 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan');

    const rows = await this.db
      .select({
        id: schema.gameEvents.id,
        fishId: schema.gameEvents.fishId,
        eventType: schema.gameEvents.eventType,
        payload: schema.gameEvents.payload,
        createdAt: schema.gameEvents.createdAt,
      })
      .from(schema.gameEvents)
      .where(
        and(eq(schema.gameEvents.aquariumId, aquarium.id), gt(schema.gameEvents.id, BigInt(after))),
      )
      .orderBy(asc(schema.gameEvents.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      events: pageRows.map((row) => ({
        cursor: safeCursor(row.id),
        eventType: row.eventType,
        fishId: row.fishId,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: pageRows.length ? safeCursor(pageRows[pageRows.length - 1]?.id) : after,
      hasMore,
    };
  }

  public async processWebhook(
    event: EndowmentWebhook,
    rawPayload: Record<string, unknown>,
  ): Promise<WebhookProcessingResult> {
    const now = new Date();
    try {
      return await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.webhookEvents)
          .values({
            source: SOURCE,
            externalEventId: event.eventId,
            eventType: event.eventType,
            payload: rawPayload,
            signatureValid: true,
            status: 'received',
            processingAttempts: 1,
          })
          .onConflictDoNothing({
            target: [schema.webhookEvents.source, schema.webhookEvents.externalEventId],
          })
          .returning({ id: schema.webhookEvents.id });
        const webhook = inserted[0];
        if (!webhook) return { duplicate: true };

        if (event.eventType === 'donation.confirmed') {
          const existingDonation = await tx
            .select({ id: schema.donations.id })
            .from(schema.donations)
            .where(
              and(
                eq(schema.donations.source, SOURCE),
                eq(schema.donations.externalDonationId, event.data.donationId),
              ),
            )
            .limit(1);
          if (existingDonation[0]) {
            await tx
              .update(schema.webhookEvents)
              .set({ status: 'duplicate', processedAt: now })
              .where(eq(schema.webhookEvents.id, webhook.id));
            return { duplicate: true };
          }

          const donorRows = await tx
            .insert(schema.donors)
            .values({
              externalId: event.data.donor.externalId,
              displayName: event.data.donor.name,
              email: event.data.donor.email,
              showNamePublicly: event.data.donor.showName,
            })
            .onConflictDoUpdate({
              target: schema.donors.externalId,
              set: {
                displayName: event.data.donor.name,
                email: event.data.donor.email,
                showNamePublicly: event.data.donor.showName,
                updatedAt: now,
              },
            })
            .returning({ id: schema.donors.id });
          const donor = donorRows[0];
          if (!donor) throw new AppError(500, 'DONOR_UPSERT_FAILED', 'Donor tidak dapat disimpan');

          const aquariumSlug = `aqr-${randomBytes(9).toString('base64url')}`;
          await tx
            .insert(schema.aquariums)
            .values({ donorId: donor.id, publicSlug: aquariumSlug })
            .onConflictDoNothing({ target: schema.aquariums.donorId });
          const aquariumRows = await tx
            .select({ id: schema.aquariums.id })
            .from(schema.aquariums)
            .where(eq(schema.aquariums.donorId, donor.id))
            .limit(1);
          const aquarium = aquariumRows[0];
          if (!aquarium)
            throw new AppError(500, 'AQUARIUM_CREATE_FAILED', 'Aquarium tidak dapat dibuat');

          const donationRows = await tx
            .insert(schema.donations)
            .values({
              donorId: donor.id,
              webhookEventId: webhook.id,
              source: SOURCE,
              externalDonationId: event.data.donationId,
              amount: BigInt(event.data.amount),
              currency: event.data.currency,
              status: 'confirmed',
              donatedAt: new Date(event.data.donatedAt),
            })
            .returning({ id: schema.donations.id });
          const donation = donationRows[0];
          if (!donation)
            throw new AppError(500, 'DONATION_CREATE_FAILED', 'Donasi tidak dapat disimpan');

          const tierRows = await tx
            .select({
              code: schema.fishTiers.code,
              minAmount: schema.fishTiers.minAmount,
              maxAmount: schema.fishTiers.maxAmount,
              rarityOrder: schema.fishTiers.rarityOrder,
            })
            .from(schema.fishTiers)
            .orderBy(asc(schema.fishTiers.rarityOrder));
          const tier = resolveTier(
            BigInt(event.data.amount),
            tierRows.map((row) => ({ ...row, code: tierCodeSchema.parse(row.code) })),
          );
          if (!tier) {
            throw new AppError(422, 'NO_MATCHING_TIER', 'Nominal donasi tidak memiliki tier ikan');
          }

          const speciesRows = await tx
            .select({ code: schema.fishSpecies.code })
            .from(schema.fishSpecies)
            .where(
              and(
                eq(schema.fishSpecies.defaultTierCode, tier.code),
                eq(schema.fishSpecies.active, true),
              ),
            )
            .orderBy(asc(schema.fishSpecies.code))
            .limit(1);
          const species = speciesRows[0];
          if (!species)
            throw new AppError(500, 'SPECIES_NOT_CONFIGURED', 'Species untuk tier belum tersedia');

          const fishRows = await tx
            .insert(schema.fish)
            .values({
              aquariumId: aquarium.id,
              donationId: donation.id,
              tierCode: tier.code,
              speciesCode: species.code,
            })
            .returning({ id: schema.fish.id });
          const createdFish = fishRows[0];
          if (!createdFish)
            throw new AppError(500, 'FISH_CREATE_FAILED', 'Fish tidak dapat dibuat');

          await tx.insert(schema.gameEvents).values({
            aquariumId: aquarium.id,
            fishId: createdFish.id,
            eventType: 'fish.created',
            payload: { tierCode: tier.code, speciesCode: species.code },
          });
          await tx
            .update(schema.webhookEvents)
            .set({ status: 'processed', processedAt: now })
            .where(eq(schema.webhookEvents.id, webhook.id));
          return { duplicate: false };
        }

        const donationRows = await tx
          .select({
            id: schema.donations.id,
            status: schema.donations.status,
          })
          .from(schema.donations)
          .where(
            and(
              eq(schema.donations.source, SOURCE),
              eq(schema.donations.externalDonationId, event.data.donationId),
            ),
          )
          .limit(1);
        const donation = donationRows[0];
        if (!donation) throw new AppError(404, 'DONATION_NOT_FOUND', 'Donasi tidak ditemukan');
        if (donation.status === 'refunded') {
          await tx
            .update(schema.webhookEvents)
            .set({ status: 'duplicate', processedAt: now })
            .where(eq(schema.webhookEvents.id, webhook.id));
          return { duplicate: true };
        }

        await tx
          .update(schema.donations)
          .set({ status: 'refunded', updatedAt: now })
          .where(eq(schema.donations.id, donation.id));
        const fishRows = await tx
          .select({
            id: schema.fish.id,
            aquariumId: schema.fish.aquariumId,
            isActive: schema.fish.isActive,
          })
          .from(schema.fish)
          .where(eq(schema.fish.donationId, donation.id))
          .limit(1);
        const refundedFish = fishRows[0];
        if (!refundedFish)
          throw new AppError(404, 'FISH_NOT_FOUND', 'Fish terkait donasi tidak ditemukan');
        if (refundedFish.isActive) {
          await tx
            .update(schema.fish)
            .set({ isActive: false, deactivatedReason: 'refund', updatedAt: now })
            .where(eq(schema.fish.id, refundedFish.id));
          await tx.insert(schema.gameEvents).values({
            aquariumId: refundedFish.aquariumId,
            fishId: refundedFish.id,
            eventType: 'fish.deactivated',
            payload: { reason: 'donation.refunded' },
          });
        }
        await tx
          .update(schema.webhookEvents)
          .set({ status: 'processed', processedAt: now })
          .where(eq(schema.webhookEvents.id, webhook.id));
        return { duplicate: false };
      });
    } catch (error) {
      await this.recordWebhookFailure(event, rawPayload, error);
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'Webhook gagal diproses');
    }
  }

  private async recordWebhookFailure(
    event: EndowmentWebhook,
    rawPayload: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    const errorMessage =
      error instanceof AppError ? `${error.code}: ${error.message}` : 'Internal processing error';
    await this.db
      .insert(schema.webhookEvents)
      .values({
        source: SOURCE,
        externalEventId: event.eventId,
        eventType: event.eventType,
        payload: rawPayload,
        signatureValid: true,
        status: 'failed',
        processingAttempts: 1,
        errorMessage,
      })
      .onConflictDoUpdate({
        target: [schema.webhookEvents.source, schema.webhookEvents.externalEventId],
        set: {
          status: 'failed',
          signatureValid: true,
          processingAttempts: sql`${schema.webhookEvents.processingAttempts} + 1`,
          errorMessage,
        },
      });
  }
}
