export const tierSeed = [
  {
    code: 'COMMON',
    name: 'Common',
    minAmount: 50_000n,
    maxAmount: 500_000n,
    rarityOrder: 1,
  },
  {
    code: 'RARE',
    name: 'Rare',
    minAmount: 500_001n,
    maxAmount: 5_000_000n,
    rarityOrder: 2,
  },
  {
    code: 'EPIC',
    name: 'Epic',
    minAmount: 5_000_001n,
    maxAmount: 25_000_000n,
    rarityOrder: 3,
  },
  {
    code: 'LEGENDARY',
    name: 'Legendary',
    minAmount: 25_000_001n,
    maxAmount: null,
    rarityOrder: 4,
  },
] as const;

export const speciesSeed = [
  {
    code: 'GUPPY',
    name: 'Guppy',
    defaultTierCode: 'COMMON',
    unityAssetCode: 'FISH_COMMON_GUPPY',
  },
  {
    code: 'CLOWNFISH',
    name: 'Clownfish',
    defaultTierCode: 'RARE',
    unityAssetCode: 'FISH_RARE_CLOWNFISH',
  },
  {
    code: 'ANGELFISH',
    name: 'Angelfish',
    defaultTierCode: 'EPIC',
    unityAssetCode: 'FISH_EPIC_ANGELFISH',
  },
  {
    code: 'GOLDEN_WHALE',
    name: 'Golden Whale',
    defaultTierCode: 'LEGENDARY',
    unityAssetCode: 'FISH_LEGENDARY_GOLDEN_WHALE',
  },
] as const;
