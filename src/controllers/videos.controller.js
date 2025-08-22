// src/controllers/videos.controller.js
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

// Resolve "who is the user" for the partition key (CAB432 rule)
function resolveQutUsername(req) {
  // Always prefer env to satisfy IAM condition on partition key
  return process.env.QUT_USERNAME || req.user?.username;
}

/* ------------------------------ Upload URLs ------------------------------ */
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

    // Thresholds via env; default to single if small
    const thresholdMb = Number(process.env.MULTIPART_THRESHOLD_MB || 100);
    const partSizeMb = Math.max(5, Number(process.env.MULTIPART_PART_SIZE_MB || 10));
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

/* ------------------------------ Complete Upload ------------------------------ */
export async function completeUpload(req, res, next) {
  try {
    const { videoId, key, uploadId, parts, title, description } = req.body || {};
    if (!videoId || !key) {
      return res.status(400).json({ error: { code: 'BadRequest', message: 'videoId and key required' } });
    }

    // If multipart, finalize
    if (uploadId) {
      if (!Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: { code: 'BadRequest', message: 'parts required for multipart completion' } });
      }
      await completeMultipart({ key, uploadId, parts });
    }

    // Verify object and size
    const head = await headObject({ key });
    const size = head.ContentLength ?? 0;

    // Write META + original VARIANT using CAB432-compliant keys
    const qutUsername = resolveQutUsername(req);
    const now = new Date().toISOString();

    await putMeta({
      qutUsername,
      video: {
        videoId,
        fileName: key.split('/').pop(),
        title: title ?? null,
        description: description ?? null,
        createdAt: now,
        createdBy: qutUsername,
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
        url: getUrl,
        createdAt: now,
      },
    });

    return res.json({
      videoId,
      createdAt: now,
      createdBy: qutUsername,
      title: title ?? null,
      description: description ?? null,
      fileName: key.split('/').pop(),
    });
  } catch (e) {
    next(e);
  }
}

/* --------------------------------- Get One -------------------------------- */
export async function getVideo(req, res, next) {
  try {
    const { videoId } = req.params;
    const qutUsername = resolveQutUsername(req);

    const { meta, variants } = await getVideoWithVariants({ qutUsername, videoId });
    if (!meta) return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });

    return res.json({
      videoId: meta.videoId,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      fileName: meta.fileName,
      title: meta.title,
      description: meta.description,
      variants: (variants || []).map((v) => ({
        variantId: v.variantId,
        format: v.format,
        resolution: v.resolution,
        url: v.url ?? '',
        transcode_status: v.transcode_status,
        size: v.size ?? 0,
      })),
    });
  } catch (e) {
    next(e);
  }
}

/* ---------------------------------- List ---------------------------------- */
export async function listVideos(req, res, next) {
  try {
    const qutUsername = resolveQutUsername(req);
    const limit = Math.min(100, Number(req.query.limit) || 10);
    const descending = (req.query.sort ?? 'createdAt:desc').endsWith(':desc');

    const { items, cursor } = await listVideosByUser({ qutUsername, limit, descending });

    return res.json({
      videos: items.map((m) => ({
        videoId: m.videoId,
        createdAt: m.createdAt,
        createdBy: m.createdBy,
        fileName: m.fileName,
        title: m.title,
        description: m.description,
      })),
      pagination: { cursor },
    });
  } catch (e) {
    next(e);
  }
}

/* --------------------------------- Delete --------------------------------- */
export async function deleteVideo(req, res, next) {
  try {
    const { videoId } = req.params;
    const qutUsername = resolveQutUsername(req);

    const rks = await listAllRksForVideo({ qutUsername, videoId });
    if (!rks.length) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }
    // Delete META + variants
    for (const rk of rks) {
      await deleteByRk({ qutUsername, rk });
    }
    return res.json({ videoId });
  } catch (e) {
    next(e);
  }
}

/* ------------------------------- Transcoding ------------------------------- */
/**
 * Start async transcode of original MP4 → MKV (H.264 + AAC)
 * POST /api/v1/videos/:videoId/transcode
 * Body: {}   // resolution ignored for v1
 * Response: { videoId, variantId, status: 'processing' | 'already_exists' }
 */
export async function startTranscode(req, res, next) {
  try {
    const { videoId } = req.params;
    const { force } = req.body || {};
    const qutUsername = resolveQutUsername(req);

    // Load META + variants
    const { meta, variants } = await getVideoWithVariants({ qutUsername, videoId });
    if (!meta) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }

    // Only support mp4 -> mkv right now; ignore resolution
    const existingMkv = (variants || []).find((v) => v.format === 'mkv');

    if (existingMkv && existingMkv.transcode_status === 'completed' && existingMkv.url) {
      // Already available — return it
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

    // Create or reuse a variantId
    const variantId = existingMkv?.variantId || `${videoId}_${randomUUID().slice(0, 8)}`;

    // Insert or mark processing
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

    // Respond immediately (async job continues in background)
    res.json({ videoId, variantId, status: 'processing' });

    // --- Background job ---
    ;(async () => {
      const logger = req.app?.get('logger') || console;

      try {
        // Build paths & keys
        const originalKey = objectKeyOriginal(videoId, meta.fileName);
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `${videoId}-input.mp4`);
        const outputPath = path.join(tmpDir, `${videoId}-${variantId}.mkv`);
        const variantKey = objectKeyVariant(videoId, variantId);

        // Download original MP4
        await downloadToFile({ key: originalKey, destPath: inputPath });

        // Transcode locally (H.264 + AAC inside MKV)
        await transcodeMp4ToMkvH264Aac(inputPath, outputPath);

        // Upload MKV back to S3
        await uploadFromFile({ key: variantKey, filePath: outputPath, contentType: 'video/x-matroska' });

        // Head to get size and presign a GET URL
        const head = await headObject({ key: variantKey });
        const size = head?.ContentLength ?? 0;
        const url = await presignGetObject({ key: variantKey });

        // Update variant as completed
        await updateVariant({
          qutUsername,
          videoId,
          variantId,
          patch: { transcode_status: 'completed', url, size },
        });

        logger.info?.({ videoId, variantId }, 'Transcode completed');
      } catch (err) {
        const logger = req.app?.get('logger') || console;
        logger.error?.({ err, videoId, variantId }, 'Transcode failed');
        try {
          await updateVariant({
            qutUsername,
            videoId,
            variantId,
            patch: { transcode_status: 'failed' },
          });
        } catch (_) { /* ignore */ }
      }
    })();
  } catch (e) {
    next(e);
  }
}
