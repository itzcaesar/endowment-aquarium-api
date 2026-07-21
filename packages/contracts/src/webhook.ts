import { z } from 'zod';

const donorSchema = z
  .object({
    externalId: z.string().min(1).max(255),
    name: z.string().max(150).nullable(),
    email: z.email().max(255).nullable(),
    showName: z.boolean(),
  })
  .strict();

export const confirmedWebhookSchema = z
  .object({
    eventId: z.string().min(1).max(255),
    eventType: z.literal('donation.confirmed'),
    occurredAt: z.iso.datetime(),
    data: z
      .object({
        donationId: z.string().min(1).max(255),
        donor: donorSchema,
        amount: z.number().int().positive().safe(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        status: z.literal('CONFIRMED'),
        donatedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();

export const refundedWebhookSchema = z
  .object({
    eventId: z.string().min(1).max(255),
    eventType: z.literal('donation.refunded'),
    occurredAt: z.iso.datetime(),
    data: z
      .object({
        donationId: z.string().min(1).max(255),
        status: z.literal('REFUNDED'),
      })
      .strict(),
  })
  .strict();

export const endowmentWebhookSchema = z.discriminatedUnion('eventType', [
  confirmedWebhookSchema,
  refundedWebhookSchema,
]);

export type ConfirmedWebhook = z.infer<typeof confirmedWebhookSchema>;
export type RefundedWebhook = z.infer<typeof refundedWebhookSchema>;
export type EndowmentWebhook = z.infer<typeof endowmentWebhookSchema>;
