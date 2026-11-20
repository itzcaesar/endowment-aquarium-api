import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { InstrumentedDonorDirectory } from '../endowment/donor-directory.js';
import { requireAdmin } from '../admin/admin-auth.js';
import { successEnvelope } from '../../shared/envelope.js';
import type { AppStore } from '../../store/types.js';

// Resolves to apps/game-api/public/dashboard from both src/ (tsx) and dist/ (node).
const assetDirectory = fileURLToPath(new URL('../../../public/dashboard/', import.meta.url));

const assets = {
  'index.html': 'text/html; charset=utf-8',
  'dashboard.css': 'text/css; charset=utf-8',
  'dashboard.js': 'text/javascript; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
} as const;

const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface DashboardOptions {
  store: AppStore;
  donorDirectory: InstrumentedDonorDirectory;
  adminToken: string | undefined;
}

export async function registerDashboard(
  app: FastifyInstance,
  options: DashboardOptions,
): Promise<void> {
  const files = new Map<string, string>();
  for (const name of Object.keys(assets)) {
    files.set(name, await readFile(`${assetDirectory}${name}`, 'utf8'));
  }
  const startedAt = Date.now();

  const sendAsset = (reply: FastifyReply, name: keyof typeof assets) =>
    reply
      .header('content-type', assets[name])
      .header('content-security-policy', contentSecurityPolicy)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', name === 'index.html' ? 'no-store' : 'public, max-age=300')
      .send(files.get(name));

  app.get('/dashboard', { schema: { hide: true } }, (_request, reply) =>
    reply.redirect('/dashboard/', 301),
  );
  app.get('/dashboard/', { schema: { hide: true } }, (_request, reply) =>
    sendAsset(reply, 'index.html'),
  );
  app.get('/dashboard/dashboard.css', { schema: { hide: true } }, (_request, reply) =>
    sendAsset(reply, 'dashboard.css'),
  );
  app.get('/dashboard/admin.js', { schema: { hide: true } }, (_request, reply) =>
    sendAsset(reply, 'admin.js'),
  );
  app.get('/dashboard/dashboard.js', { schema: { hide: true } }, (_request, reply) =>
    sendAsset(reply, 'dashboard.js'),
  );

  app.get('/api/v1/admin/stats', { schema: { hide: true } }, async (request, reply) => {
    requireAdmin(request, options.adminToken);

    const now = new Date();
    const queryStarted = performance.now();
    let stats = null;
    let databaseOk = true;
    try {
      stats = await options.store.getStats(now);
    } catch (error) {
      databaseOk = false;
      request.log.error({ err: error }, 'Dashboard stats query failed');
    }
    reply.header('cache-control', 'no-store');
    return successEnvelope(request.id, {
      generatedAt: now.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      service: { name: 'tel-u-endowment-aquarium', apiVersion: '1.0', node: process.version },
      database: {
        status: databaseOk ? 'good' : 'critical',
        queryMs: Math.round(performance.now() - queryStarted),
      },
      endowment: options.donorDirectory.health(),
      stats,
    });
  });
}
