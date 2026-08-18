import express from 'express';
import { registerRoutes } from '../routes/index.js';
import { errorHandler } from './errors.js';
import { applySecurity } from './security.js';
import { requestLogger } from '../middleware/requestContext.js';
import { openApiDocument } from '../openapi/openapi.js';
import { supabaseAdmin } from '../db/supabaseAdmin.js';

export function createHttpServer() {
  const app = express();

  applySecurity(app);
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/ready', async (_req, res) => {
    const { error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
    const ready = !error;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      dependencies: { supabase: ready }
    });
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  registerRoutes(app);
  app.use(errorHandler);

  return app;
}
