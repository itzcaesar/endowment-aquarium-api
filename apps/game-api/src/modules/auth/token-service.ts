import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '../../shared/errors.js';

export function hashAccessToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Bearer token diperlukan');
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Bearer token diperlukan');
  }
  return token;
}
