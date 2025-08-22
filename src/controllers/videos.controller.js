// src/controllers/videos.controller.js
import { randomUUID } from 'node:crypto';
import {
  presignPutObject,
  initiateMultipart,
  presignUploadPartUrls,
  completeMultipart,
  headObject,
  presignGetObject,
  objectKeyOriginal,
} from '../services/s3.service.js';
import {
  putMeta,
  putVariant,
  getVideoWithVariants,
  listVideosByUser,
  listAllRksForVideo,
  deleteByRk,
} from '../models/videos.repo.js';

// Resolve "who is the user" for the partition key
function resolveQutUsername(req) {
  return req.user?.username || process.env.QUT_USERNAME;
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

    // Thresholds via env; default to single if small
    const thresholdMb = Number(process.env.MULTIPART_THRESHOLD_MB || 100);
    const partSizeMb = Math.max(5, Number(process.env.MULTIPART_PART_SIZE_MB || 10));
    const isMultipart = sizeBytes >= thresholdMb * 1024 * 1024;

    if (!isMultipart) {
      const url = await presignPutObject({ key, contentType });
      return res.json({ strategy: 'single', videoId, key, url });
    }

    const { uploadId } = await initiateMultipart({ key, contentType });
    const { partSizeBytes, parts } = presignUploadPartUrls({ key, uploadId, sizeBytes, partSizeMb });
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
      })),
    });
  } catch (e) {
    next(e);
  }
}

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
