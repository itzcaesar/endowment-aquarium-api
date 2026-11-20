import { z } from 'zod';

import { tierCodeSchema } from './fish.js';

/** NIK is the 16-digit national identity number used as the Endowment donor key. */
export const nikSchema = z
  .string()
  .regex(/^\d{16}$/, 'NIK harus terdiri dari tepat 16 digit angka');

export const authNikInputSchema = z.object({ nik: nikSchema }).strict();

export const donorProfileSchema = z.object({
  nik: nikSchema,
  name: z.string().min(1).max(150),
  tierCode: tierCodeSchema.nullable(),
  totalDonation: z.number().int().nonnegative(),
});

export const authNikDataSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresAt: z.iso.datetime().nullable(),
  donor: donorProfileSchema,
});

export const inventorySchema = z.object({
  points: z.number().int().min(0),
  ownedAccessories: z.array(z.string().min(1).max(50)),
});

export type Nik = z.infer<typeof nikSchema>;
export type AuthNikInput = z.infer<typeof authNikInputSchema>;
export type DonorProfile = z.infer<typeof donorProfileSchema>;
export type AuthNikData = z.infer<typeof authNikDataSchema>;
export type Inventory = z.infer<typeof inventorySchema>;
