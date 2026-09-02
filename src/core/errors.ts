import type { ErrorRequestHandler } from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
    public details?: unknown
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = (req as { id?: string }).id;

  if (error instanceof HttpError) {
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      details: error.details,
      requestId
    });
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({
      code: 'INVALID_JSON',
      message: 'Request body contains invalid JSON',
      requestId
    });
    return;
  }

  (req as { log?: { error: (payload: unknown, message: string) => void } }).log?.error(
    { err: error },
    'Unhandled request error'
  );
  res.status(500).json({ code: 'SERVER_ERROR', message: 'Internal server error', requestId });
};
