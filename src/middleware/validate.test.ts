import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from './validate.js';

test('query validation supports the getter-only query property used by Express 5', () => {
  const source = { page: '2' };
  const request = {} as Request;
  Object.defineProperty(request, 'query', {
    configurable: true,
    get: () => source
  });
  let nextError: unknown;

  validate({ query: z.object({ page: z.coerce.number().int() }) })(
    request,
    {} as Response,
    ((error?: unknown) => {
      nextError = error;
    }) as NextFunction
  );

  assert.equal(nextError, undefined);
  assert.deepEqual(request.query, { page: 2 });
});
