import { randomUUID } from 'node:crypto';

import type {
  AppearanceInput,
  BigAquarium,
  EndowmentWebhook,
  GameEventsPage,
  Inventory,
  PersonalAquarium,
  PersonalFish,
  PublicAquarium,
} from '@telu/contracts';
import {
  accessoryCodeSchema,
  colorCodeSchema,
  tierCodeSchema,
  type TierCode,
} from '@telu/contracts';

import { speciesSeed, tierSeed } from '../db/seed-data.js';
import { calculateHunger, moodForHunger } from '../modules/fish/hunger-service.js';
import { resolveTier } from '../modules/tiers/tier-service.js';
import { publicDonorName } from '../modules/donors/privacy-service.js';
import { AppError } from '../shared/errors.js';
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

interface MemoryDonor {
  id: string;
  externalId: string | null;
  nik: string | null;
  displayName: string | null;
  email: string | null;
  showNamePublicly: boolean;
  totalDonation: bigint;
  tierCode: string | null;
  lastSyncedAt: Date | null;
}

interface MemoryAquarium {
  id: string;
  donorId: string;
  publicSlug: string;
  name: string | null;
}

interface MemoryDonation {
  id: string;
  donorId: string;
  externalDonationId: string;
  amount: bigint;
  status: 'confirmed' | 'refunded';
}

interface MemoryFish {
  id: string;
  aquariumId: string;
  donationId: string | null;
  tierCode: string;
  speciesCode: string;
  colorCode: string;
  accessoryCode: string;
  hunger: number;
  lastFedAt: Date | null;
  isActive: boolean;
  source?: 'donation' | 'endowment_sync' | 'admin';
  deactivatedReason?: string | null;
  createdAt: Date;
}

interface MemoryEvent {
  id: number;
  aquariumId: string;
  fishId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export class MemoryStore implements AppStore {
  private readonly donors = new Map<string, MemoryDonor>();
  private readonly aquariums = new Map<string, MemoryAquarium>();
  private readonly donations = new Map<string, MemoryDonation>();
  private readonly fish = new Map<string, MemoryFish>();
  private readonly events: MemoryEvent[] = [];
  private readonly webhooks = new Map<string, Date>();
  private readonly tokens = new Map<string, { donorId: string; expiresAt: Date | null }>();
  private readonly inventories = new Map<
    string,
    { points: number; ownedAccessories: string[]; granted?: number }
  >();
  private nextEventId = 1;

  public async close(): Promise<void> {}

  private donorById(id: string): MemoryDonor {
    const donor = [...this.donors.values()].find((item) => item.id === id);
    if (!donor) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan');
    return donor;
  }

  private aquariumById(id: string): MemoryAquarium {
    const aquarium = [...this.aquariums.values()].find((item) => item.id === id);
    if (!aquarium) throw new AppError(404, 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan');
    return aquarium;
  }

  private fishDto(fish: MemoryFish, now: Date): PersonalFish {
    const hunger = calculateHunger(fish.hunger, fish.lastFedAt ?? fish.createdAt, now);
    const species = speciesSeed.find((item) => item.code === fish.speciesCode);
    if (!species) throw new AppError(500, 'SPECIES_NOT_CONFIGURED', 'Species belum tersedia');
    return {
      id: fish.id,
      speciesCode: fish.speciesCode,
      assetCode: species.unityAssetCode,
      tierCode: tierCodeSchema.parse(fish.tierCode),
      displayName: null,
      appearance: {
        colorCode: colorCodeSchema.parse(fish.colorCode),
        accessoryCode: accessoryCodeSchema.parse(fish.accessoryCode),
      },
      state: {
        hunger,
        mood: moodForHunger(hunger),
        isActive: fish.isActive,
        lastFedAt: fish.lastFedAt?.toISOString() ?? null,
      },
      createdAt: fish.createdAt.toISOString(),
    };
  }

  private addEvent(
    aquariumId: string,
    fishId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    this.events.push({
      id: this.nextEventId++,
      aquariumId,
      fishId,
      eventType,
      payload,
      createdAt: new Date(),
    });
  }

  private aquariumFish(aquariumId: string, includeInactive: boolean): MemoryFish[] {
    return [...this.fish.values()]
      .filter((item) => item.aquariumId === aquariumId && (includeInactive || item.isActive))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  private aquariumCursor(aquariumId: string): number {
    return this.events.filter((event) => event.aquariumId === aquariumId).at(-1)?.id ?? 0;
  }

  public async processWebhook(event: EndowmentWebhook): Promise<WebhookProcessingResult> {
    if (this.webhooks.has(event.eventId)) return { duplicate: true };
    this.webhooks.set(event.eventId, new Date());
    if (event.eventType === 'donation.confirmed') {
      const donationKey = event.data.donationId;
      if (this.donations.has(donationKey)) return { duplicate: true };
      const tier = resolveTier(
        BigInt(event.data.amount),
        tierSeed.map((item) => ({ ...item })),
      );
      if (!tier)
        throw new AppError(422, 'NO_MATCHING_TIER', 'Nominal donasi tidak memiliki tier ikan');
      const species = speciesSeed.find((item) => item.defaultTierCode === tier.code);
      if (!species) throw new AppError(500, 'SPECIES_NOT_CONFIGURED', 'Species belum tersedia');
      let donor = [...this.donors.values()].find(
        (item) => item.externalId === event.data.donor.externalId,
      );
      if (!donor) {
        donor = {
          id: randomUUID(),
          externalId: event.data.donor.externalId,
          nik: null,
          displayName: event.data.donor.name,
          email: event.data.donor.email,
          showNamePublicly: event.data.donor.showName,
          totalDonation: 0n,
          tierCode: null,
          lastSyncedAt: null,
        };
        this.donors.set(donor.id, donor);
      } else {
        Object.assign(donor, {
          displayName: event.data.donor.name,
          email: event.data.donor.email,
          showNamePublicly: event.data.donor.showName,
        });
      }
      let aquarium = this.aquariums.get(donor.id);
      if (!aquarium) {
        aquarium = {
          id: randomUUID(),
          donorId: donor.id,
          publicSlug: `aqr-${randomUUID().slice(0, 8)}`,
          name: null,
        };
        this.aquariums.set(donor.id, aquarium);
      }
      const donation: MemoryDonation = {
        id: randomUUID(),
        donorId: donor.id,
        externalDonationId: event.data.donationId,
        amount: BigInt(event.data.amount),
        status: 'confirmed',
      };
      this.donations.set(donationKey, donation);
      const fish: MemoryFish = {
        id: randomUUID(),
        aquariumId: aquarium.id,
        donationId: donation.id,
        tierCode: tier.code,
        speciesCode: species.code,
        colorCode: 'DEFAULT',
        accessoryCode: 'NONE',
        hunger: 100,
        lastFedAt: null,
        isActive: true,
        createdAt: new Date(event.data.donatedAt),
      };
      this.fish.set(fish.id, fish);
      this.addEvent(aquarium.id, fish.id, 'fish.created', {
        tierCode: tier.code,
        speciesCode: species.code,
      });
      return { duplicate: false };
    }

    const donation = this.donations.get(event.data.donationId);
    if (!donation) throw new AppError(404, 'DONATION_NOT_FOUND', 'Donasi tidak ditemukan');
    if (donation.status === 'refunded') return { duplicate: true };
    donation.status = 'refunded';
    const fish = [...this.fish.values()].find((item) => item.donationId === donation.id);
    if (fish?.isActive) {
      fish.isActive = false;
      fish.deactivatedReason = 'refund';
      this.addEvent(fish.aquariumId, fish.id, 'fish.deactivated', { reason: 'donation.refunded' });
    }
    return { duplicate: false };
  }

  public async getPersonalAquarium(donorId: string, now: Date): Promise<PersonalAquarium> {
    const donor = this.donorById(donorId);
    const aquarium = this.aquariums.get(donor.id);
    if (!aquarium) throw new AppError(404, 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan');
    const rows = this.aquariumFish(aquarium.id, true);
    const active = rows.filter((item) => item.isActive);
    const rarity = new Map<TierCode, number>(
      tierSeed.map((item) => [item.code as TierCode, item.rarityOrder]),
    );
    const highest = active.sort(
      (left, right) =>
        (rarity.get(tierCodeSchema.parse(right.tierCode)) ?? 0) -
        (rarity.get(tierCodeSchema.parse(left.tierCode)) ?? 0),
    )[0];
    return {
      aquariumId: aquarium.id,
      publicSlug: aquarium.publicSlug,
      name: aquarium.name,
      owner: { displayName: donor.displayName },
      statistics: {
        fishCount: active.length,
        highestTier: highest ? tierCodeSchema.parse(highest.tierCode) : null,
      },
      fish: rows.map((item) => this.fishDto(item, now)),
      syncCursor: this.aquariumCursor(aquarium.id),
    };
  }

  public async getPublicAquarium(publicSlug: string, now: Date): Promise<PublicAquarium> {
    const aquarium = [...this.aquariums.values()].find((item) => item.publicSlug === publicSlug);
    if (!aquarium) throw new AppError(404, 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan');
    const donor = this.donorById(aquarium.donorId);
    const rows = this.aquariumFish(aquarium.id, false);
    const rarity = new Map<TierCode, number>(
      tierSeed.map((item) => [item.code as TierCode, item.rarityOrder]),
    );
    const highest = rows.sort(
      (left, right) =>
        (rarity.get(tierCodeSchema.parse(right.tierCode)) ?? 0) -
        (rarity.get(tierCodeSchema.parse(left.tierCode)) ?? 0),
    )[0];
    return {
      aquariumId: aquarium.id,
      publicSlug: aquarium.publicSlug,
      name: aquarium.name,
      owner: { displayName: publicDonorName(donor.displayName, donor.showNamePublicly) },
      statistics: {
        fishCount: rows.length,
        highestTier: highest ? tierCodeSchema.parse(highest.tierCode) : null,
      },
      fish: rows.map((item) => this.fishDto(item, now)),
      syncCursor: this.aquariumCursor(aquarium.id),
    };
  }

  public async getBigAquarium(limit: number): Promise<BigAquarium> {
    const selected = new Map<string, MemoryFish>();
    for (const fish of [...this.fish.values()].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    )) {
      if (!fish.isActive) continue;
      const aquarium = this.aquariumById(fish.aquariumId);
      if (!selected.has(aquarium.donorId)) selected.set(aquarium.donorId, fish);
      if (selected.size >= limit) break;
    }
    const rows = [...selected.values()].map((fish) => {
      const aquarium = this.aquariumById(fish.aquariumId);
      const donor = this.donorById(aquarium.donorId);
      const species = speciesSeed.find((item) => item.code === fish.speciesCode);
      if (!species) throw new AppError(500, 'SPECIES_NOT_CONFIGURED', 'Species belum tersedia');
      return {
        id: fish.id,
        speciesCode: fish.speciesCode,
        assetCode: species.unityAssetCode,
        tierCode: tierCodeSchema.parse(fish.tierCode),
        donorDisplayName: publicDonorName(donor.displayName, donor.showNamePublicly),
        appearance: {
          colorCode: colorCodeSchema.parse(fish.colorCode),
          accessoryCode: accessoryCodeSchema.parse(fish.accessoryCode),
        },
      };
    });
    return {
      mode: 'EXHIBITION',
      refreshAfterSeconds: 60,
      syncCursor: this.events.at(-1)?.id ?? 0,
      fish: rows,
    };
  }

  public async authenticateToken(tokenHash: string, now: Date): Promise<AuthenticatedToken | null> {
    const token = this.tokens.get(tokenHash);
    if (!token || (token.expiresAt && token.expiresAt <= now)) return null;
    return token;
  }

  public async issueAccessToken(
    donorExternalId: string,
    tokenHash: string,
    expiresAt: Date | null,
  ): Promise<IssuedAccessToken> {
    const donor = [...this.donors.values()].find((item) => item.externalId === donorExternalId);
    if (!donor) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan');
    return this.issueAccessTokenForDonor(donor.id, tokenHash, expiresAt);
  }

  public async issueAccessTokenForDonor(
    donorId: string,
    tokenHash: string,
    expiresAt: Date | null,
  ): Promise<IssuedAccessToken> {
    this.tokens.set(tokenHash, { donorId, expiresAt });
    return { donorId, expiresAt };
  }

  public async syncDonor(input: DonorSyncInput, now: Date): Promise<SyncedDonor> {
    const tier = resolveTier(
      BigInt(input.totalDonation),
      tierSeed.map((item) => ({ ...item })),
    );
    let donor = [...this.donors.values()].find(
      (item) => item.nik === input.nik || item.externalId === input.nik,
    );
    const previousTier = donor ? donor.tierCode : null;
    if (donor) {
      donor.nik = input.nik;
      donor.displayName = input.name;
      donor.totalDonation = BigInt(input.totalDonation);
      donor.tierCode = tier?.code ?? null;
      donor.lastSyncedAt = now;
    } else {
      donor = {
        id: randomUUID(),
        externalId: input.nik,
        nik: input.nik,
        displayName: input.name,
        email: null,
        showNamePublicly: true,
        totalDonation: BigInt(input.totalDonation),
        tierCode: tier?.code ?? null,
        lastSyncedAt: now,
      };
      this.donors.set(donor.id, donor);
    }

    let aquarium = this.aquariums.get(donor.id);
    if (!aquarium) {
      aquarium = {
        id: randomUUID(),
        donorId: donor.id,
        publicSlug: `aqr-${randomUUID().slice(0, 8)}`,
        name: null,
      };
      this.aquariums.set(donor.id, aquarium);
    }

    // Mirrors PostgresStore.syncDonor: add only newly earned points; manage only sync fish.
    const inventory = this.inventories.get(donor.id) ?? { points: 0, ownedAccessories: [] };
    const earned = Math.min(2_147_483_647, Math.floor(input.totalDonation / 10_000));
    const granted = inventory.granted ?? 0;
    if (earned > granted) {
      inventory.points = Math.min(2_147_483_647, inventory.points + (earned - granted));
      inventory.granted = earned;
    }
    this.inventories.set(donor.id, inventory);

    const syncFish = this.aquariumFish(aquarium.id, true).find(
      (item) => item.source === 'endowment_sync',
    );
    const tierChanged = (tier?.code ?? null) !== previousTier;
    if (tier) {
      const species = speciesSeed.find((item) => item.defaultTierCode === tier.code);
      if (!species) throw new AppError(500, 'SPECIES_NOT_CONFIGURED', 'Species belum tersedia');
      const payload = { tierCode: tier.code, speciesCode: species.code, source: 'endowment.sync' };
      if (!syncFish) {
        const fish: MemoryFish = {
          id: randomUUID(),
          aquariumId: aquarium.id,
          donationId: null,
          tierCode: tier.code,
          speciesCode: species.code,
          colorCode: 'DEFAULT',
          accessoryCode: 'NONE',
          hunger: 100,
          lastFedAt: null,
          isActive: true,
          source: 'endowment_sync',
          deactivatedReason: null,
          createdAt: now,
        };
        this.fish.set(fish.id, fish);
        this.addEvent(aquarium.id, fish.id, 'fish.created', payload);
      } else if (!syncFish.isActive && syncFish.deactivatedReason === 'endowment_below_common') {
        syncFish.isActive = true;
        syncFish.deactivatedReason = null;
        syncFish.tierCode = tier.code;
        syncFish.speciesCode = species.code;
        this.addEvent(aquarium.id, syncFish.id, 'fish.created', { ...payload, reactivated: true });
      } else if (syncFish.isActive && tierChanged && syncFish.tierCode !== tier.code) {
        syncFish.tierCode = tier.code;
        syncFish.speciesCode = species.code;
        this.addEvent(aquarium.id, syncFish.id, 'fish.tier_changed', payload);
      }
    } else if (syncFish?.isActive) {
      syncFish.isActive = false;
      syncFish.deactivatedReason = 'endowment_below_common';
      this.addEvent(aquarium.id, syncFish.id, 'fish.deactivated', {
        reason: 'endowment.total_below_common',
      });
    }

    return {
      donorId: donor.id,
      nik: input.nik,
      name: input.name,
      tierCode: tier ? tierCodeSchema.parse(tier.code) : null,
      totalDonation: input.totalDonation,
      publicSlug: aquarium.publicSlug,
    };
  }

  public async getStats(now: Date): Promise<StoreStats> {
    const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
    const donors = [...this.donors.values()];
    const activeFish = [...this.fish.values()].filter((item) => item.isActive);
    const donations = [...this.donations.values()];
    const webhookTimes = [...this.webhooks.values()];
    const slugByAquarium = new Map(
      [...this.aquariums.values()].map((item) => [item.id, item.publicSlug]),
    );
    const tierByFish = new Map([...this.fish.values()].map((item) => [item.id, item.tierCode]));
    return {
      donors: {
        total: donors.length,
        nikSynced: donors.filter((item) => item.nik !== null).length,
        syncedLast24h: donors.filter(
          (item) => item.lastSyncedAt !== null && item.lastSyncedAt.getTime() >= dayAgo,
        ).length,
      },
      fishByTier: tierSeed.map((tier) => ({
        tierCode: tierCodeSchema.parse(tier.code),
        count: activeFish.filter((item) => item.tierCode === tier.code).length,
      })),
      donations: {
        confirmed: donations.filter((item) => item.status === 'confirmed').length,
        refunded: donations.filter((item) => item.status === 'refunded').length,
      },
      webhooks: {
        received: 0,
        processed: webhookTimes.length,
        duplicate: 0,
        failed: 0,
        last24h: webhookTimes.filter((time) => time.getTime() >= dayAgo).length,
      },
      inventoryPoints: [...this.inventories.values()].reduce((sum, item) => sum + item.points, 0),
      hourlyEvents: hourlyBuckets(
        now,
        this.events.map((event) => event.createdAt),
      ),
      recentEvents: this.events
        .slice(-12)
        .reverse()
        .map((event) => ({
          id: event.id,
          eventType: event.eventType,
          tierCode: event.fishId ? (tierByFish.get(event.fishId) ?? null) : null,
          publicSlug: slugByAquarium.get(event.aquariumId) ?? '',
          createdAt: event.createdAt.toISOString(),
        })),
    };
  }

  public async getInventory(donorId: string): Promise<Inventory> {
    const inventory = this.inventories.get(donorId) ?? { points: 0, ownedAccessories: [] };
    this.inventories.set(donorId, inventory);
    return { points: inventory.points, ownedAccessories: [...inventory.ownedAccessories] };
  }

  public async feedFish(donorId: string, fishId: string, now: Date): Promise<FeedFishResult> {
    const fish = this.fish.get(fishId);
    if (!fish || this.aquariumById(fish.aquariumId).donorId !== donorId)
      throw new AppError(404, 'FISH_NOT_FOUND', 'Fish tidak ditemukan');
    if (!fish.isActive) throw new AppError(409, 'FISH_INACTIVE', 'Fish sudah tidak aktif');
    if (fish.lastFedAt && now.getTime() - fish.lastFedAt.getTime() < 4 * 60 * 60 * 1000) {
      throw new AppError(409, 'FEEDING_COOLDOWN_ACTIVE', 'Feeding masih dalam cooldown', {
        nextFeedAt: new Date(fish.lastFedAt.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      });
    }
    fish.hunger = 100;
    fish.lastFedAt = now;
    this.addEvent(fish.aquariumId, fish.id, 'fish.fed', {
      hunger: 100,
      mood: 'happy',
      lastFedAt: now.toISOString(),
    });
    return {
      fish: this.fishDto(fish, now),
      nextFeedAt: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    };
  }

  public async updateAppearance(
    donorId: string,
    fishId: string,
    appearance: AppearanceInput,
    now: Date,
  ): Promise<AppearanceResult> {
    const fish = this.fish.get(fishId);
    if (!fish || this.aquariumById(fish.aquariumId).donorId !== donorId)
      throw new AppError(404, 'FISH_NOT_FOUND', 'Fish tidak ditemukan');
    if (!fish.isActive) throw new AppError(409, 'FISH_INACTIVE', 'Fish sudah tidak aktif');
    fish.colorCode = appearance.colorCode;
    fish.accessoryCode = appearance.accessoryCode;
    this.addEvent(fish.aquariumId, fish.id, 'fish.customized', { ...appearance });
    return { fish: this.fishDto(fish, now) };
  }

  public async getEvents(
    publicSlug: string,
    after: number,
    limit: number,
  ): Promise<GameEventsPage> {
    const aquarium = [...this.aquariums.values()].find((item) => item.publicSlug === publicSlug);
    if (!aquarium) throw new AppError(404, 'AQUARIUM_NOT_FOUND', 'Aquarium tidak ditemukan');
    const rows = this.events.filter(
      (event) => event.aquariumId === aquarium.id && event.id > after,
    );
    const page = rows.slice(0, limit);
    return {
      events: page.map((event) => ({
        cursor: event.id,
        eventType: event.eventType,
        fishId: event.fishId,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      })),
      nextCursor: page.at(-1)?.id ?? after,
      hasMore: rows.length > limit,
    };
  }
}
