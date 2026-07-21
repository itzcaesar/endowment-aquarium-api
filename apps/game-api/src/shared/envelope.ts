import { SCHEMA_VERSION } from '@telu/contracts';

export function successEnvelope<T>(requestId: string, data: T) {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    data,
  };
}

export function errorEnvelope(
  requestId: string,
  code: string,
  message: string,
  details: unknown = null,
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    error: {
      code,
      message,
      details,
    },
  };
}
