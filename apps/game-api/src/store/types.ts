import type {
  AppearanceInput,
  BigAquarium,
  EndowmentWebhook,
  GameEventsPage,
  PersonalAquarium,
  PersonalFish,
  PublicAquarium,
} from '@telu/contracts';

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
}
