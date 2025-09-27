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

    return res.json({
      videos: collected.map((m) => ({
        videoId: m.videoId,
        createdAt: m.createdAt,
        createdBy: m.createdBy,
        fileName: m.fileName,
        title: m.title,
        description: m.description,
      })),
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

    res.json({ videoId, variantId, status: 'processing' });

    ; (async () => {
      const logger = req.app?.get('logger') || console;

      try {
        const originalKey = objectKeyOriginal(videoId, meta.fileName);
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `${videoId}-input.mp4`);
        const outputPath = path.join(tmpDir, `${videoId}-${variantId}.mkv`);
        const variantKey = objectKeyVariant(videoId, variantId);

        await downloadToFile({ key: originalKey, destPath: inputPath });

        await transcodeMp4ToMkvH264Aac(inputPath, outputPath);

        await uploadFromFile({ key: variantKey, filePath: outputPath, contentType: 'video/x-matroska' });

        const head = await headObject({ key: variantKey });
        const size = head?.ContentLength ?? 0;
        const url = await presignGetObject({ key: variantKey });

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
