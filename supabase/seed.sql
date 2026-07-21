insert into fish_tiers (code, name, min_amount, max_amount, rarity_order)
values
  ('COMMON', 'Common', 50000, 500000, 1),
  ('RARE', 'Rare', 500001, 5000000, 2),
  ('EPIC', 'Epic', 5000001, 25000000, 3),
  ('LEGENDARY', 'Legendary', 25000001, null, 4)
on conflict (code) do update set
  name = excluded.name,
  min_amount = excluded.min_amount,
  max_amount = excluded.max_amount,
  rarity_order = excluded.rarity_order,
  updated_at = now();

insert into fish_species (code, name, default_tier_code, unity_asset_code, active)
values
  ('GUPPY', 'Guppy', 'COMMON', 'FISH_COMMON_GUPPY', true),
  ('CLOWNFISH', 'Clownfish', 'RARE', 'FISH_RARE_CLOWNFISH', true),
  ('ANGELFISH', 'Angelfish', 'EPIC', 'FISH_EPIC_ANGELFISH', true),
  ('GOLDEN_WHALE', 'Golden Whale', 'LEGENDARY', 'FISH_LEGENDARY_GOLDEN_WHALE', true)
on conflict (code) do update set
  name = excluded.name,
  default_tier_code = excluded.default_tier_code,
  unity_asset_code = excluded.unity_asset_code,
  active = excluded.active,
  updated_at = now();

