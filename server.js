// server.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import pino from 'pino';
import { router as apiRouter } from './src/routes/index.js';
import { errorHandler, notFoundHandler } from './src/middleware/error.js';
import { ensureBucketAndTags } from './src/services/s3.service.js';
import { ensureTableAndGSI } from './src/models/dynamo.js';

const logger = pino({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined
});

async function main() {
  // 1) Build the app first
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.set('logger', logger);
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('combined'));

  // Health
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // 2) Infra checks (run ONCE)
  try {
    await ensureBucketAndTags();
  } catch (e) {
    logger.error({ err: e }, 'Failed to ensure S3 bucket/tags');
    // Exit early so you don't run a half‑configured server
    process.exit(1);
  }

  try {
    await ensureTableAndGSI();
  } catch (e) {
    logger.error({ err: e }, 'Failed to ensure DynamoDB table/GSI (requires permissions)');
    process.exit(1);
  }

  // 3) API v1 router
  app.use('/api/v1', apiRouter);

  // 4) 404 + Error handler
  app.use(notFoundHandler);
  app.use(errorHandler);

  // 5) Listen
  app.listen(PORT, () => logger.info({ port: PORT }, `Server listening on ${PORT}`));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
