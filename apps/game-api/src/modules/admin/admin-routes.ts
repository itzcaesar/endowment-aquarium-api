import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from 'postgres';
import { z } from 'zod';

import type { DonorDirectory } from '../endowment/donor-directory.js';
import { AppError } from '../../shared/errors.js';
import { successEnvelope } from '../../shared/envelope.js';
import { parseInput } from '../../shared/validation.js';
import type { AppStore } from '../../store/types.js';
import { requireAdmin } from './admin-auth.js';
import {
  auditQuerySchema,
  donorListQuerySchema,
  donorUpdateSchema,
  fishCreateSchema,
  fishListQuerySchema,
  fishUpdateSchema,
  inventoryUpdateSchema,
  resyncSchema,
} from './admin-schemas.js';
import { AdminService } from './admin-service.js';

interface AdminRouteOptions {
  sql: Sql | null;
  store: AppStore;
  donorDirectory: DonorDirectory;
  adminToken: string | undefined;
}

const idParams = z.object({ id: z.uuid() });
const hidden = { schema: { hide: true } };
// Writes get a tighter per-IP budget than the dashboard's read polling.
const writeLimit = { ...hidden, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRouteOptions,
): Promise<void> {
  const service = options.sql ? new AdminService(options.sql) : null;

  const guard = (request: FastifyRequest): AdminService => {
    requireAdmin(request, options.adminToken);
    if (!service) {
      throw new AppError(503, 'ADMIN_REQUIRES_DATABASE', 'Admin hanya tersedia dengan PostgreSQL');
    }
    return service;
  };
  const actor = (request: FastifyRequest) => ({ ip: request.ip ?? null });
  const id = (request: FastifyRequest) => parseInput(idParams, request.params).id;

  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/v1/admin/')) reply.header('cache-control', 'no-store');
  });

  app.get('/api/v1/admin/catalog', hidden, async (request) =>
    successEnvelope(request.id, await guard(request).catalog()),
  );

  app.get('/api/v1/admin/fish', hidden, async (request) => {
    const admin = guard(request);
    const query = parseInput(fishListQuerySchema, request.query);
    return successEnvelope(request.id, await admin.listFish(query, new Date()));
  });

  app.get('/api/v1/admin/fish/:id', hidden, async (request) => {
    const admin = guard(request);
    return successEnvelope(request.id, await admin.getFish(id(request), new Date()));
  });

  app.post('/api/v1/admin/fish', writeLimit, async (request, reply) => {
    const admin = guard(request);
    const input = parseInput(fishCreateSchema, request.body);
    reply.code(201);
    return successEnvelope(request.id, await admin.createFish(input, actor(request), new Date()));
  });

  app.patch('/api/v1/admin/fish/:id', writeLimit, async (request) => {
    const admin = guard(request);
    const input = parseInput(fishUpdateSchema, request.body);
    return successEnvelope(
      request.id,
      await admin.updateFish(id(request), input, actor(request), new Date()),
    );
  });

  app.get('/api/v1/admin/donors', hidden, async (request) => {
    const admin = guard(request);
    return successEnvelope(
      request.id,
      await admin.listDonors(parseInput(donorListQuerySchema, request.query)),
    );
  });

  app.get('/api/v1/admin/donors/:id', hidden, async (request) => {
    const admin = guard(request);
    return successEnvelope(request.id, await admin.getDonor(id(request), new Date()));
  });

  app.patch('/api/v1/admin/donors/:id', writeLimit, async (request) => {
    const admin = guard(request);
    const input = parseInput(donorUpdateSchema, request.body);
    return successEnvelope(
      request.id,
      await admin.updateDonor(id(request), input, actor(request), new Date()),
    );
  });

  app.patch('/api/v1/admin/donors/:id/inventory', writeLimit, async (request) => {
    const admin = guard(request);
    const input = parseInput(inventoryUpdateSchema, request.body);
    return successEnvelope(
      request.id,
      await admin.updateInventory(id(request), input, actor(request), new Date()),
    );
  });

  app.post('/api/v1/admin/donors/:id/resync', writeLimit, async (request) => {
    const admin = guard(request);
    const { reason } = parseInput(resyncSchema, request.body ?? {});
    const donorId = id(request);
    const nik = await admin.donorNik(donorId);
    const endowment = await options.donorDirectory.findByNik(nik);
    const synced = await options.store.syncDonor(endowment, new Date());
    await admin.recordAudit(
      actor(request),
      'donor.resync',
      'donor',
      donorId,
      { totalDonation: synced.totalDonation, tierCode: synced.tierCode },
      reason,
    );
    return successEnvelope(request.id, await admin.getDonor(donorId, new Date()));
  });

  app.get('/api/v1/admin/audit', hidden, async (request) => {
    const admin = guard(request);
    return successEnvelope(
      request.id,
      await admin.listAudit(parseInput(auditQuerySchema, request.query)),
    );
  });
}
