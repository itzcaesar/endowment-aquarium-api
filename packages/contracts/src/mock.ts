import { z } from 'zod';

export const createMockDonationSchema = z
  .object({
    donorExternalId: z.string().min(1).max(255),
    donorName: z.string().min(1).max(150),
    donorEmail: z.email().max(255),
    showName: z.boolean(),
    amount: z.number().int().positive().safe(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('IDR'),
  })
  .strict();

export type CreateMockDonationInput = z.infer<typeof createMockDonationSchema>;
