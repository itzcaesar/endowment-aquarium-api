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

export interface DonorSyncInput {
  nik: string;
  name: string;
  totalDonation: number;
}

export interface SyncedDonor {
  donorId: string;
  nik: string;
  name: string;
  tierCode: TierCode | null;
  totalDonation: number;
  publicSlug: string;
}

export interface StoreStats {
  donors: { total: number; nikSynced: number; syncedLast24h: number };
  fishByTier: Array<{ tierCode: TierCode; count: number }>;
  donations: { confirmed: number; refunded: number };
  webhooks: {
    received: number;
    processed: number;
    duplicate: number;
    failed: number;
    last24h: number;
  };
  inventoryPoints: number;
  /** 24 hourly buckets, oldest first; `hour` is the bucket start (ISO). */
  hourlyEvents: Array<{ hour: string; count: number }>;
  recentEvents: Array<{
    id: number;
    eventType: string;
    tierCode: string | null;
    publicSlug: string;
    createdAt: string;
  }>;
}

export interface WebhookProcessingResult {
  duplicate: boolean;
}

export interface AuthenticatedToken {
  donorId: string;
  expiresAt: Date | null;
}

export interface FeedFishResult {
  fish: PersonalFish;
  nextFeedAt: string;
}

export interface AppearanceResult {
  fish: PersonalFish;
}

export interface IssuedAccessToken {
  donorId: string;
  expiresAt: Date | null;
}

export interface AppStore {
  processWebhook(
    event: EndowmentWebhook,
    rawPayload: Record<string, unknown>,
  ): Promise<WebhookProcessingResult>;
  getBigAquarium(limit: number, now: Date): Promise<BigAquarium>;
  getPublicAquarium(publicSlug: string, now: Date): Promise<PublicAquarium>;
  getPersonalAquarium(donorId: string, now: Date): Promise<PersonalAquarium>;
  authenticateToken(tokenHash: string, now: Date): Promise<AuthenticatedToken | null>;
  feedFish(donorId: string, fishId: string, now: Date): Promise<FeedFishResult>;
  updateAppearance(
    donorId: string,
    fishId: string,
    appearance: AppearanceInput,
    now: Date,
  ): Promise<AppearanceResult>;
  getEvents(publicSlug: string, after: number, limit: number): Promise<GameEventsPage>;
  issueAccessToken(
    donorExternalId: string,
    tokenHash: string,
    expiresAt: Date | null,
  ): Promise<IssuedAccessToken>;
  issueAccessTokenForDonor(
    donorId: string,
    tokenHash: string,
    expiresAt: Date | null,
  ): Promise<IssuedAccessToken>;
  syncDonor(input: DonorSyncInput, now: Date): Promise<SyncedDonor>;
  getInventory(donorId: string): Promise<Inventory>;
  getStats(now: Date): Promise<StoreStats>;
}
