import express from 'express';
import { registerRoutes } from '../routes/index.js';
import { errorHandler } from './errors.js';
import { applySecurity } from './security.js';
import { requestLogger } from '../middleware/requestContext.js';
import { openApiDocument } from '../openapi/openapi.js';
import { supabaseAdmin } from '../db/supabaseAdmin.js';
import { HttpError } from './errors.js';

export function createHttpServer() {
  const app = express();

  applySecurity(app);
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/ready', async (_req, res) => {
    const [database, auth] = await Promise.allSettled([
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }),
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 })
    ]);
    const databaseReady = database.status === 'fulfilled' && !database.value.error;
    const authReady = auth.status === 'fulfilled' && !auth.value.error;
    const ready = databaseReady && authReady;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      dependencies: {
        supabaseAuth: authReady,
        supabaseDatabase: databaseReady
      }
    });
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  registerRoutes(app);
  app.use((req) => {
    throw new HttpError(404, `Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND');
  });
  app.use(errorHandler);

  return app;
}
