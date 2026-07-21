import { z } from 'zod';

export const SCHEMA_VERSION = '1.0' as const;
export const API_VERSION = '1.0' as const;

export const requestIdSchema = z.string().min(1).max(200);

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().nullable(),
});

export const errorEnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: requestIdSchema,
  error: apiErrorSchema,
});

export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    requestId: requestIdSchema,
    data,
  });
}

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
