import { z } from 'zod';

export const colorCodes = ['DEFAULT', 'OCEAN_BLUE', 'CORAL_PINK', 'GOLDEN'] as const;
export const accessoryCodes = ['NONE', 'TELU_CAP', 'GRADUATION_HAT'] as const;
export const fishMoodCodes = ['happy', 'neutral', 'hungry'] as const;
export const tierCodes = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Warna harus berformat HEX, contoh #00E5FF')
  .transform((value) => value.toUpperCase());

export const colorCodeSchema = z.union([z.enum(colorCodes), hexColorSchema]);
export const accessoryCodeSchema = z.enum(accessoryCodes);
export const fishMoodSchema = z.enum(fishMoodCodes);
export const tierCodeSchema = z.enum(tierCodes);

export const appearanceInputSchema = z
  .object({
    colorCode: colorCodeSchema,
    accessoryCode: accessoryCodeSchema,
  })
  .strict();

export const fishAppearanceSchema = z.object({
  colorCode: colorCodeSchema,
  accessoryCode: accessoryCodeSchema,
});

export const fishStateSchema = z.object({
  hunger: z.number().int().min(0).max(100),
  mood: fishMoodSchema,
  isActive: z.boolean(),
  lastFedAt: z.iso.datetime().nullable(),
});

export const personalFishSchema = z.object({
  id: z.uuid(),
  speciesCode: z.string(),
  assetCode: z.string(),
  tierCode: tierCodeSchema,
  displayName: z.string().nullable(),
  appearance: fishAppearanceSchema,
  state: fishStateSchema,
  createdAt: z.iso.datetime(),
});

export const publicFishSchema = z.object({
  id: z.uuid(),
  speciesCode: z.string(),
  assetCode: z.string(),
  tierCode: tierCodeSchema,
  donorDisplayName: z.string(),
  appearance: fishAppearanceSchema,
});

export type AppearanceInput = z.infer<typeof appearanceInputSchema>;
export type ColorCode = z.infer<typeof colorCodeSchema>;
export type AccessoryCode = z.infer<typeof accessoryCodeSchema>;
export type FishMood = z.infer<typeof fishMoodSchema>;
export type TierCode = z.infer<typeof tierCodeSchema>;
export type PersonalFish = z.infer<typeof personalFishSchema>;
export type PublicFish = z.infer<typeof publicFishSchema>;
