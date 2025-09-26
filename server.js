// server.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import pino from 'pino';
import cors from 'cors';
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
  app.disable('x-powered-by');

  // // --- CORS (allow your web client(s)) ----------------------------------------
  // // Prefer WEB_ORIGINS (comma-separated), fallback to WEB_ORIGIN, then localhost:5173
  // const WEB_ORIGINS = (process.env.WEB_ORIGINS ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173')
  //   .split(',')
  //   .map((s) => s.trim())
  //   .filter(Boolean);

  // const corsOptions = {
  //   origin: (origin, cb) => {
  //     // allow same-origin/no-origin (curl/Postman) and listed web origins
  //     if (!origin || WEB_ORIGINS.includes(origin)) return cb(null, true);
  //     return cb(new Error(`Not allowed by CORS: ${origin}`));
  //   },
  //   methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  //   allowedHeaders: ['Content-Type', 'Authorization'],
  //   exposedHeaders: ['ETag'],
  //   credentials: false, // using bearer tokens, not cookies
  //   maxAge: 600, // cache preflight for 10 minutes
  // };

  // app.use(cors(corsOptions));
  // // IMPORTANT: use the SAME options for preflight too
  // app.options('*', cors(corsOptions));
  // ---------------------------------------------------------------------------
  app.use(cors());        // allow all origins
  app.options('*', cors());
  const PORT = Number(process.env.PORT || 3000);

  app.set('logger', logger);
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('combined'));

  // health
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Log the AWS identity the server is using (helps ensure SSO vs EC2 role)
  await logAwsIdentity(logger);

  // Infra checks
  await ensureBucketAndTags().catch((e) => {
    logger.error({ err: e }, 'Failed to ensure S3 bucket/tags');
    process.exit(1);
  });
  await ensureTableAndGSI().catch((e) => {
    logger.error({ err: e }, 'Failed to ensure DynamoDB table/GSI');
    process.exit(1);
  });

  // API v1
  app.use('/api/v1', apiRouter);

  // 404 + error
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Bind to 0.0.0.0 so it is reachable externally (EC2 SG must allow the port)
  app.listen(PORT, '0.0.0.0', () => {
    logger.info({
      port: PORT
      // , WEB_ORIGINS 
    }, `Server listening on 0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
