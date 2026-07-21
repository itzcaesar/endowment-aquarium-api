import { createHmac, timingSafeEqual } from 'node:crypto';

export function createWebhookSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

export interface VerifyWebhookSignatureInput {
  rawBody: string;
  timestamp: string;
  signature: string;
  secret: string;
  toleranceSeconds: number;
  now?: Date;
}

export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  if (!/^\d+$/.test(input.timestamp) || !/^[a-fA-F0-9]+$/.test(input.signature)) {
    return false;
  }

  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return false;

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > input.toleranceSeconds) return false;

  const expected = createWebhookSignature(input.rawBody, input.timestamp, input.secret);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(input.signature, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}
