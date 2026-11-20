import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { AppError } from '../../shared/errors.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time check of the `X-Admin-Token` header against ADMIN_DASHBOARD_TOKEN. */
export function requireAdmin(request: FastifyRequest, adminToken: string | undefined): void {
  if (!adminToken) {
    throw new AppError(503, 'DASHBOARD_DISABLED', 'ADMIN_DASHBOARD_TOKEN belum dikonfigurasi');
  }
  const supplied = request.headers['x-admin-token'];
  if (typeof supplied !== 'string' || !timingSafeEqual(digest(supplied), digest(adminToken))) {
    throw new AppError(401, 'INVALID_ADMIN_TOKEN', 'Admin token tidak valid');
  }
}
