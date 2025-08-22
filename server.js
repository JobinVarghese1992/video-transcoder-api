// server.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import pino from 'pino';
import { router as apiRouter } from './src/routes/index.js';
import { errorHandler, notFoundHandler } from './src/middleware/error.js';
import { ensureBucketAndTags } from './src/services/s3.service.js';
import { ensureTableAndGSI, logAwsIdentity } from './src/models/dynamo.js';

const logger = pino({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});

async function main() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.set('logger', logger);
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('combined'));

  // health
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Log the AWS identity the server is using (helps ensure SSO vs EC2 role)
  await logAwsIdentity(logger);

  // Infra checks
  await ensureBucketAndTags().catch((e) => {
    logger.error({ err: e }, 'Failed to ensure S3 bucket/tags'); process.exit(1);
  });
  await ensureTableAndGSI().catch((e) => {
    logger.error({ err: e }, 'Failed to ensure DynamoDB table/GSI'); process.exit(1);
  });

  // API v1
  app.use('/api/v1', apiRouter);

  // 404 + error
  app.use(notFoundHandler);
  app.use(errorHandler);

  app.listen(PORT, () => logger.info({ port: PORT }, `Server listening on ${PORT}`));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
