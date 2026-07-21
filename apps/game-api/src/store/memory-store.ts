import { randomUUID } from 'node:crypto';

import type {
  AppearanceInput,
  BigAquarium,
  EndowmentWebhook,
  GameEventsPage,
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
  FeedFishResult,
  IssuedAccessToken,
  WebhookProcessingResult,
} from './types.js';

interface MemoryDonor {
  id: string;
  externalId: string;
  displayName: string | null;
  email: string | null;
  showNamePublicly: boolean;
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
  donationId: string;
  tierCode: string;
  speciesCode: string;
  colorCode: string;
  accessoryCode: string;
  hunger: number;
  lastFedAt: Date | null;
  isActive: boolean;
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
  private readonly webhooks = new Set<string>();
  private readonly tokens = new Map<string, { donorId: string; expiresAt: Date | null }>();
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
    this.webhooks.add(event.eventId);
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
          displayName: event.data.donor.name,
          email: event.data.donor.email,
          showNamePublicly: event.data.donor.showName,
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
    this.tokens.set(tokenHash, { donorId: donor.id, expiresAt });
    return { donorId: donor.id, expiresAt };
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
