export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function safeErrorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_PROCESSING_ERROR';
}
