import { accessoryCodes, colorCodeSchema, nikSchema, tierCodeSchema } from '@telu/contracts';
import { z } from 'zod';

const reason = z.string().trim().max(500).optional();
const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const accessoryCodeAdminSchema = z.enum(accessoryCodes);

export const fishListQuerySchema = z.object({
  ...pageQuery,
  search: z.string().trim().max(100).optional(),
  tier: tierCodeSchema.optional(),
  species: z.string().trim().max(50).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  donorId: z.uuid().optional(),
});

export const fishCreateSchema = z
  .object({
    donorId: z.uuid(),
    speciesCode: z.string().trim().min(1).max(50),
    tierCode: tierCodeSchema.optional(),
    displayName: z.string().trim().min(1).max(100).nullable().optional(),
    colorCode: colorCodeSchema.default('DEFAULT'),
    accessoryCode: accessoryCodeAdminSchema.default('NONE'),
    reason,
  })
  .strict();

export const fishUpdateSchema = z
  .object({
    displayName: z.string().trim().max(100).nullable().optional(),
    tierCode: tierCodeSchema.optional(),
    speciesCode: z.string().trim().min(1).max(50).optional(),
    colorCode: colorCodeSchema.optional(),
    accessoryCode: accessoryCodeAdminSchema.optional(),
    /** Sets hunger now; decay (and the donor's 4-hour feed cooldown) restarts from this moment. */
    hunger: z.number().int().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'reason'),
    'Minimal satu field harus diubah',
  );

export const donorListQuerySchema = z.object({
  ...pageQuery,
  search: z.string().trim().max(100).optional(),
  source: z.enum(['all', 'nik', 'webhook']).default('all'),
});

export const donorUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(150).optional(),
    showNamePublicly: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine(
    (value) => value.displayName !== undefined || value.showNamePublicly !== undefined,
    'Minimal satu field harus diubah',
  );

export const inventoryUpdateSchema = z
  .object({
    pointsDelta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    grantAccessories: z
      .array(accessoryCodeAdminSchema.exclude(['NONE']))
      .max(20)
      .optional(),
    revokeAccessories: z
      .array(accessoryCodeAdminSchema.exclude(['NONE']))
      .max(20)
      .optional(),
    reason,
  })
  .strict()
  .refine(
    (value) =>
      (value.pointsDelta ?? 0) !== 0 ||
      (value.grantAccessories?.length ?? 0) > 0 ||
      (value.revokeAccessories?.length ?? 0) > 0,
    'Tidak ada perubahan inventory',
  );

export const auditQuerySchema = z.object({
  ...pageQuery,
  targetType: z.enum(['fish', 'donor', 'inventory', 'export']).optional(),
  targetId: z.string().max(64).optional(),
});

export const resyncSchema = z.object({ reason }).strict();

export { nikSchema };

export type FishListQuery = z.infer<typeof fishListQuerySchema>;
export type FishCreateInput = z.infer<typeof fishCreateSchema>;
export type FishUpdateInput = z.infer<typeof fishUpdateSchema>;
export type DonorListQuery = z.infer<typeof donorListQuerySchema>;
export type DonorUpdateInput = z.infer<typeof donorUpdateSchema>;
export type InventoryUpdateInput = z.infer<typeof inventoryUpdateSchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
