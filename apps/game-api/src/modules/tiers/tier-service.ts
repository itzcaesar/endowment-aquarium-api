import type { TierCode } from '@telu/contracts';

export interface TierDefinition {
  code: TierCode;
  minAmount: bigint;
  maxAmount: bigint | null;
  rarityOrder: number;
}

export function resolveTier(
  amount: bigint,
  tiers: readonly TierDefinition[],
): TierDefinition | null {
  return (
    [...tiers]
      .sort((left, right) => left.rarityOrder - right.rarityOrder)
      .find(
        (tier) => amount >= tier.minAmount && (tier.maxAmount === null || amount <= tier.maxAmount),
      ) ?? null
  );
}
