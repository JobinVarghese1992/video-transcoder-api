import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAdmin } from '../middleware/auth.js';

import {
  presignPutObject,
  initiateMultipart,
  presignUploadPartUrls,
  completeMultipart,
  headObject,
  presignGetObject,
  objectKeyOriginal,
  objectKeyVariant,
  downloadToFile,
  uploadFromFile,
  presignPutThumbnail,
  presignGetThumbnailJpg
} from '../services/s3.service.js';

import {
  putMeta,
  putVariant,
  getVideoWithVariants,
  listVideosByUser,
  listAllRksForVideo,
  deleteByRk,
  updateVariant,
} from '../models/videos.repo.js';

import { transcodeMp4ToMkvH264Aac } from '../services/ffmpeg.service.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

async function resolveQutUsername() {
  const params = process.env.QUT_USERNAME;
  return params;
}

function requesterUsername(req) {
  return req.user?.username;
}

export async function createUploadUrl(req, res, next) {
  try {
    const { fileName, sizeBytes, contentType } = req.body || {};
    if (!fileName || !sizeBytes || !contentType) {
      return res.status(400).json({ error: { code: 'BadRequest', message: 'fileName, sizeBytes, contentType required' } });
    }
    if (contentType !== 'video/mp4') {
      return res.status(400).json({ error: { code: 'UnsupportedType', message: 'Only video/mp4 allowed for originals' } });
    }

    const videoId = 'vid_' + randomUUID();
    const key = objectKeyOriginal(videoId, fileName);

    const MULTIPART_THRESHOLD_MB = process.env.MULTIPART_THRESHOLD_MB;
    const MULTIPART_PART_SIZE_MB = process.env.MULTIPART_PART_SIZE_MB;
    const thresholdMb = Number(MULTIPART_THRESHOLD_MB || 100);
    const partSizeMb = Math.max(5, Number(MULTIPART_PART_SIZE_MB || 10));
    const isMultipart = Number(sizeBytes) >= thresholdMb * 1024 * 1024;

    if (!isMultipart) {
      const url = await presignPutObject({ key, contentType });
      return res.json({ strategy: 'single', videoId, key, url });
    }

    const { uploadId } = await initiateMultipart({ key, contentType });
    const { partSizeBytes, parts } = await presignUploadPartUrls({
      key, uploadId, sizeBytes: Number(sizeBytes), partSizeMb
    });
    return res.json({ strategy: 'multipart', videoId, key, uploadId, partSizeBytes, parts });
  } catch (e) {
    next(e);
  }
}

export async function completeUpload(req, res, next) {
  try {
    const { videoId, key, uploadId, parts, title, description } = req.body || {};
    if (!videoId || !key) {
      return res.status(400).json({ error: { code: 'BadRequest', message: 'videoId and key required' } });
    }

    if (uploadId) {
      if (!Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: { code: 'BadRequest', message: 'parts required for multipart completion' } });
      }
      await completeMultipart({ key, uploadId, parts });
    }

    const head = await headObject({ key });
    const size = head.ContentLength ?? 0;

    const qutUsername = await resolveQutUsername();
    const createdBy = requesterUsername(req);
    const now = new Date().toISOString();

    await putMeta({
      qutUsername,
      video: {
        videoId,
        fileName: key.split('/').pop(),
        title: title ?? null,
        description: description ?? null,
        createdAt: now,
        createdBy,
      },
    });


    const originalVariantId = `${videoId}_1`;
    const getUrl = await presignGetObject({ key });

    await putVariant({
      qutUsername,
      videoId,
      variant: {
        variantId: originalVariantId,
        format: 'mp4',
        resolution: 'original',
        size,
        transcode_status: 'completed',
        // url: getUrl,
        createdAt: now,
      },
    });

    // Create thumbnail
    try {
      const { meta } = await getVideoWithVariants({ qutUsername, videoId });
      const originalKey = objectKeyOriginal(videoId, meta.fileName);
      const originalUrl = await presignGetObject({ key: originalKey, expiresSeconds: 3600 });
      const { thumbnail_url } = await presignPutThumbnail({ id: videoId });
      const result = await generateThumbnail({
        videoUrl: originalUrl,
        thumbnailUrl: thumbnail_url
      });

      console.log("Thumbnail OK:", result);
      // result.meta contains { at, width, format, contentType }
    } catch (err) {
      console.error("Thumbnail failed:", err);
      // show toast/snackbar to the user
    }

    return res.json({
      videoId,
      createdAt: now,
      createdBy,
      title: title ?? null,
      description: description ?? null,
      fileName: key.split('/').pop(),
    });
  } catch (e) {
    next(e);
  }
}

export async function getVideo(req, res, next) {
  try {
    const { videoId } = req.params;

    const qutUsername = await resolveQutUsername();
    const me = requesterUsername(req);

    const ttl = Math.max(3600, Math.min(604800, Number(req.query.ttl) || 900));

    const { meta, variants } = await getVideoWithVariants({ qutUsername, videoId });
    if (!meta) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }

    if (!isAdmin(req) && (meta.createdBy || '').toLowerCase() !== (me || '').toLowerCase()) {
      return res.status(403).json({ error: { code: 'Forbidden', message: 'Not your video' } });
    }

    const originalKey = objectKeyOriginal(videoId, meta.fileName);
    const originalUrl = await presignGetObject({ key: originalKey, expiresSeconds: ttl });

    const s3KeyForVariant = (v) => {
      if ((v.format || '').toLowerCase() === 'mp4') {
        return objectKeyOriginal(videoId, meta.fileName);
      }
      return objectKeyVariant(videoId, v.variantId);
    };

    const variantViews = await Promise.all(
      (variants || []).map(async (v) => {
        let freshUrl = '';
        try {
          if (v.transcode_status === 'completed') {
            const key = s3KeyForVariant(v);
            freshUrl = await presignGetObject({ key, expiresSeconds: ttl });
          }
        } catch (_) {
          freshUrl = '';
        }
        return {
          variantId: v.variantId,
          format: v.format,
          resolution: v.resolution,
          transcode_status: v.transcode_status,
          size: v.size ?? 0,
          url: freshUrl,
        };
      })
    );

    return res.json({
      videoId: meta.videoId,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      fileName: meta.fileName,
      title: meta.title,
      description: meta.description,
      original: { url: originalUrl, contentType: 'video/mp4' },
      variants: variantViews,
    });
  } catch (e) {
    next(e);
  }
}

export async function listVideos(req, res, next) {
  try {
    const qutUsername = await resolveQutUsername();
    const me = requesterUsername(req);

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
    const descending = (req.query.sort ?? 'createdAt:desc').endsWith(':desc');

    const ownerFilter = (req.query.owner || '').trim().toLowerCase();
    const isAdminUser = isAdmin(req);

    const belongsToRequester = (m) =>
      (m.createdBy || '').toLowerCase() === (me || '').toLowerCase();

    const matchesOwner = (m) => {
      if (!isAdminUser) return belongsToRequester(m);
      if (!ownerFilter || ownerFilter === 'all') return true;
      return (m.createdBy || '').toLowerCase() === ownerFilter;
    };

    let cursor = null;
    if (req.query.cursor) {
      try {
        cursor = typeof req.query.cursor === 'string'
          ? JSON.parse(req.query.cursor)
          : req.query.cursor;
      } catch {
        return res
          .status(400)
          .json({ error: { code: 'BadCursor', message: 'cursor must be JSON-encoded LastEvaluatedKey' } });
      }
    }

    const collected = [];
    let nextCursor = null;

    while (collected.length < limit) {
      const { items, cursor: c } = await listVideosByUser({
        qutUsername,
        limit,
        descending,
        cursor
      });

      const filtered = (items || []).filter(matchesOwner);
      for (const m of filtered) {
        if (collected.length < limit) collected.push(m);
        else break;
      }

      nextCursor = c || null;

      if (!nextCursor || collected.length >= limit) break;

      cursor = nextCursor;
    }

    // return res.json({
    //   videos: collected.map((m) => ({
    //     videoId: m.videoId,
    //     createdAt: m.createdAt,
    //     createdBy: m.createdBy,
    //     fileName: m.fileName,
    //     title: m.title,
    //     description: m.description,
    //   })),
    //   pagination: { cursor: nextCursor },
    // });

    // Build response items and attach img_url in parallel
    const videosWithThumbs = await Promise.all(
      collected.map(async (m) => {
        const presigned = await presignGetThumbnailJpg(m.videoId, 90000).catch(() => ({ url: null }));
        return {
          videoId: m.videoId,
          createdAt: m.createdAt,
          createdBy: m.createdBy,
          fileName: m.fileName,
          title: m.title,
          description: m.description,
          img_url: presigned?.url || null,   // null if thumbnail not present
        };
      })
    );

    return res.json({
      videos: videosWithThumbs,
      pagination: { cursor: nextCursor },
    });

  } catch (e) {
    next(e);
  }
}

export async function deleteVideo(req, res, next) {
  try {
    const { videoId } = req.params;
    const qutUsername = await resolveQutUsername();
    const me = requesterUsername(req);

    const { meta } = await getVideoWithVariants({ qutUsername, videoId });
    if (!meta) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }
    if (!isAdmin(req) && (meta.createdBy || '').toLowerCase() !== (me || '').toLowerCase()) {
      return res.status(403).json({ error: { code: 'Forbidden', message: 'Not your video' } });
    }

    const rks = await listAllRksForVideo({ qutUsername, videoId });
    for (const rk of rks) {
      await deleteByRk({ qutUsername, rk });
    }
    return res.json({ videoId });
  } catch (e) {
    next(e);
  }
}

/* ------------------------------- Transcoding ------------------------------- */
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const QUEUE_URL = process.env.JOBS_QUEUE_URL;

export async function startTranscode(req, res, next) {
  try {
    const { videoId } = req.params;
    const { force } = req.body || {};
    const qutUsername = await resolveQutUsername();
    const me = requesterUsername(req);

    const { meta, variants } = await getVideoWithVariants({ qutUsername, videoId });
    if (!meta) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }
    if (!isAdmin(req) && (meta.createdBy || '').toLowerCase() !== (me || '').toLowerCase()) {
      return res.status(403).json({ error: { code: 'Forbidden', message: 'Not your video' } });
    }

    const existingMkv = (variants || []).find((v) => v.format === 'mkv');

    if (existingMkv && existingMkv.transcode_status === 'completed' && existingMkv.url) {
      return res.json({
        videoId,
        variantId: existingMkv.variantId,
        status: 'already_exists',
        url: existingMkv.url,
      });
    }

    if (!force && existingMkv && existingMkv.transcode_status === 'processing') {
      return res.json({
        videoId,
        variantId: existingMkv.variantId,
        status: 'processing',
      });
    }

    const variantId = existingMkv?.variantId || `${videoId}_${randomUUID().slice(0, 8)}`;

    if (!existingMkv) {
      await putVariant({
        qutUsername,
        videoId,
        variant: {
          variantId,
          format: 'mkv',
          resolution: 'original',
          size: 0,
          transcode_status: 'processing',
          url: '',
          createdAt: new Date().toISOString(),
        },
      });
    } else {
      await updateVariant({
        qutUsername,
        videoId,
        variantId,
        patch: { transcode_status: 'processing' },
      });
    }

    // --- NEW: enqueue a job to SQS for the worker service ---
    if (!QUEUE_URL) {
      // If enqueue fails due to bad config, revert state to avoid “stuck processing”
      await updateVariant({
        qutUsername,
        videoId,
        variantId,
        patch: { transcode_status: 'failed' },
      });
      return res.status(500).json({ error: { code: 'Config', message: 'JOBS_QUEUE_URL is not set' } });
    }

    const originalKey = objectKeyOriginal(videoId, meta.fileName);
    const variantKey = objectKeyVariant(videoId, variantId);

    const message = {
      videoId,
      variantId,
      qutUsername,                 // DDB partition key
      createdBy: me,               // optional auditing
      fileName: meta.fileName,
      originalKey,                 // s3 key to download
      variantKey,                  // s3 key to upload
      // Optional knobs:
      // preset: 'medium',
      // expiresSeconds: 3600,
      // attempt: 1
    };

    // Tip: for idempotency, send a MessageGroupId/MessageDeduplicationId if FIFO,
    // but we’re using Standard SQS so we rely on your worker to be idempotent.
    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(message),
      // Optional attributes for filtering/ops:
      MessageAttributes: {
        type: { DataType: 'String', StringValue: 'transcode' },
        format: { DataType: 'String', StringValue: 'mkv' },
      },
    }));

    // Respond immediately; worker will update the variant later
    return res.json({ videoId, variantId, status: 'queued' });
  } catch (e) {
    return next(e);
  }
}

// thumbnail api invocation function
export async function generateThumbnail({
  apiBase = process.env.THUMBNAIL_SERVICE_URL, // e.g., http://localhost:8080
  videoUrl,
  thumbnailUrl,
  at = 2.5,           // seconds into the video
  width = 640,        // output width
  format = "jpg",     // "jpg" | "png"
  amzHeaders = {},    // optional: only include if they were signed (e.g., {"x-amz-acl":"bucket-owner-full-control"})
  authToken,          // optional: if your API needs JWT
  timeoutMs = 300000   // cancel if it takes too long
}) {
  if (!videoUrl || !thumbnailUrl) {
    throw new Error("videoUrl and thumbnailUrl are required");
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${apiBase}/thumbnail`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify({
        videoUrl,
        thumbnailUrl,
        at,
        width,
        format,
        headers: amzHeaders
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // surface server error details if provided
      const text = await res.text().catch(() => "");
      throw new Error(`Thumbnail API ${res.status}: ${text || res.statusText}`);
    }

    return await res.json(); // { ok: true, message, meta: {...} }
  } finally {
    clearTimeout(t);
  }
}
