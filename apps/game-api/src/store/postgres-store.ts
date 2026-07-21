import { randomBytes } from 'node:crypto';

import type {
  AppearanceInput,
  BigAquarium,
  EndowmentWebhook,
  GameEventsPage,
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
  FeedFishResult,
  IssuedAccessToken,
  WebhookProcessingResult,
} from './types.js';

type AppDatabase = PostgresJsDatabase<typeof schema>;
type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

const SOURCE = 'endowment';
const FEED_COOLDOWN_MS = 4 * 60 * 60 * 1000;

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
    const rows = await this.db
      .insert(schema.accessTokens)
      .values({ donorId: donor.id, tokenHash, expiresAt })
      .returning({
        donorId: schema.accessTokens.donorId,
        expiresAt: schema.accessTokens.expiresAt,
      });
    const issued = rows[0];
    if (!issued) throw new AppError(500, 'TOKEN_ISSUE_FAILED', 'Token tidak dapat dibuat');
    return issued;
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
            .set({ isActive: false, updatedAt: now })
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
