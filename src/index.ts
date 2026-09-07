import { createHttpServer } from './core/http.js';
import { logger } from './core/logger.js';
import { env } from './core/env.js';

const app = createHttpServer();
const port = env.PORT;

const server = app.listen(port, '0.0.0.0', () => {
  logger.info({ port }, 'SHC backend started');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'Shutting down SHC backend');
    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'HTTP server shutdown failed');
        process.exitCode = 1;
      }
    });
  });
}
