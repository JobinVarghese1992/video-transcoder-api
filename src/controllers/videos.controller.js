// src/controllers/videos.controller.js
import { z } from 'zod';
import {
  BUCKET,
  objectKeyOriginal,
  presignPutObject,
  initiateMultipart,
  presignUploadPartUrls,
  completeMultipart,
  headObject,
  presignGetObject,
  objectKeyVariant
} from '../services/s3.service.js';
import {
  createMeta,
  createVariant,
  deleteVideoRecords,
  findExistingVariant,
  getAllByVideo,
  getMeta,
  getNextVariantSeq,
  listMetasByCreator,
  newVideoId,
  newVariantId,
  updateMeta,
  updateVariant
} from '../services/videos.service.js';
import { startTranscodeJob } from '../services/transcoder.service.js';

const ONE_HOUR = Number(process.env.PRESIGNED_TTL_SECONDS || 3600);
const MULTIPART_THRESHOLD = Number(process.env.MULTIPART_THRESHOLD_MB || 100) * 1024 * 1024;
const PART_SIZE = Math.max(5 * 1024 * 1024, Number(process.env.MULTIPART_PART_SIZE_MB || 10) * 1024 * 1024);
const MAX_OBJECT_SIZE = Number(process.env.MAX_OBJECT_SIZE_BYTES || 20 * 1024 * 1024 * 1024);

function sanitizeFileName(name = 'file.mp4') {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.toLowerCase();
}

export const CreateUploadUrlSchema = z.object({
  fileName: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().regex(/^video\/mp4$/)
});

export const CompleteUploadSchema = z.union([
  z.object({
    videoId: z.string().min(1),
    key: z.string().min(1)
  }),
  z.object({
    videoId: z.string().min(1),
    key: z.string().min(1),
    uploadId: z.string().min(1),
    parts: z.array(
      z.object({
        partNumber: z.number().int().positive(),
        eTag: z.string().min(1).optional(),
        ETag: z.string().min(1).optional(),
        etag: z.string().min(1).optional()
      })
    )
  })
]);

export const ListVideosSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(10),
  page: z.coerce.number().int().positive().default(1),
  createdBy: z.string().optional(), // 'me' or email
  sort: z.string().regex(/^createdAt:(asc|desc)$/).default('createdAt:desc'),
  filter: z.string().optional() // "transcode_status:completed"
});

export const UpdateVideoSchema = z.object({
  fileName: z.string().min(1).optional(),
  title: z.string().max(500).optional(),
  description: z.string().max(2000).optional()
});

export const StartTranscodeSchema = z.object({
  format: z.literal('mkv')
});

export const ReplaceUploadUrlSchema = z.object({
  fileName: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().regex(/^video\/mp4$/)
});

export const CompleteReplaceSchema = z.union([
  z.object({
    videoId: z.string().min(1),
    key: z.string().min(1)
  }),
  z.object({
    videoId: z.string().min(1),
    key: z.string().min(1),
    uploadId: z.string().min(1),
    parts: z.array(
      z.object({
        partNumber: z.number().int().positive(),
        eTag: z.string().min(1).optional(),
        ETag: z.string().min(1).optional(),
        etag: z.string().min(1).optional()
      })
    )
  })
]);

export async function createUploadUrl(req, res, next) {
  try {
    const { fileName, sizeBytes, contentType } = req.body;
    if (sizeBytes > MAX_OBJECT_SIZE) {
      return res.status(400).json({
        error: { code: 'BadRequest', message: `File too large. Max ${MAX_OBJECT_SIZE} bytes.` }
      });
    }
    const extOk = fileName.toLowerCase().endsWith('.mp4');
    if (!extOk) {
      return res.status(400).json({
        error: { code: 'BadRequest', message: 'Only .mp4 files are accepted' }
      });
    }

    const clean = sanitizeFileName(fileName);
    const videoId = newVideoId();
    const key = objectKeyOriginal(videoId, clean);

    if (sizeBytes >= MULTIPART_THRESHOLD) {
      const { uploadId } = await initiateMultipart({ key, contentType });
      const { parts } = await presignUploadPartUrls({
        key,
        uploadId,
        totalSizeBytes: sizeBytes,
        partSizeBytes: PART_SIZE
      });
      return res.json({
        strategy: 'multipart',
        videoId,
        bucket: BUCKET,
        key,
        uploadId,
        partSizeBytes: PART_SIZE,
        parts
      });
    } else {
      const url = await presignPutObject({ key, contentType, expiresSeconds: ONE_HOUR });
      return res.json({ strategy: 'single', videoId, bucket: BUCKET, key, url });
    }
  } catch (e) {
    next(e);
  }
}

export async function completeUpload(req, res, next) {
  try {
    const body = req.body;
    const { videoId, key } = body;

    if ('uploadId' in body && body.uploadId) {
      await completeMultipart({ key, uploadId: body.uploadId, parts: body.parts || [] });
    }
    // HEAD to ensure it exists
    await headObject({ key });

    // Create META + original VARIANT
    const fileName = key.split('/').pop();
    const owner = req.user.username;
    const meta = await createMeta({ videoId, fileName, createdBy: owner });

    // Create original variant (completed)
    const url = await presignGetObject({ key, expiresSeconds: ONE_HOUR });
    const seq = await getNextVariantSeq(videoId);
    const variantId = newVariantId(videoId, seq);
    await createVariant({
      videoId,
      variantId,
      format: 'mp4',
      resolution: 'source',
      size: 0,
      transcode_status: 'completed',
      url
    });

    res.json({
      videoId: meta.videoId,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      fileName: meta.fileName,
      title: meta.title,
      description: meta.description
    });
  } catch (e) {
    next(e);
  }
}

function computePaginationCursor(page, lastEvaluatedKey) {
  // Simple passthrough (clients can ignore)
  return { page, lastEvaluatedKey: lastEvaluatedKey || null };
}

export async function listVideos(req, res, next) {
  try {
    const { limit, page, createdBy, sort, filter } = req.query;
    const [_f, order] = sort.split(':');

    // For demo simplicity, we only support listing "my uploads" or by email using GSI1
    const creator = createdBy === 'me' || !createdBy ? req.user.username : createdBy;

    // Simulate page via iterating ExclusiveStartKey "page-1" times
    let eks = null;
    let set = null;
    for (let p = 1; p <= page; p++) {
      // eslint-disable-next-line no-await-in-loop
      set = await listMetasByCreator({
        creator,
        limit,
        exclusiveStartKey: eks,
        sort: order
      });
      eks = set.lastEvaluatedKey || null;
      if (!eks) break;
    }

    const metas = set?.items || [];

    // If filter provided, attach only matching variants
    let videos = [];
    if (filter && filter.startsWith('transcode_status:')) {
      const status = filter.split(':')[1];
      for (const m of metas) {
        // eslint-disable-next-line no-await-in-loop
        const items = await getAllByVideo(m.videoId);
        const variants = items.filter(
          (i) => i.SK !== 'META' && i.transcode_status === status
        );
        if (variants.length > 0) {
          // Generate fresh presigned GETs
          const withUrls = await Promise.all(
            variants.map(async (v) => {
              const key =
                v.format === 'mp4'
                  ? objectKeyOriginal(m.videoId, m.fileName)
                  : objectKeyVariant(m.videoId, v.variantId);
              const url = await presignGetObject({ key, expiresSeconds: ONE_HOUR });
              return { ...v, url };
            })
          );
          videos.push({
            videoId: m.videoId,
            createdAt: m.createdAt,
            createdBy: m.createdBy,
            fileName: m.fileName,
            title: m.title,
            description: m.description,
            variants: withUrls.map((v) => ({
              variantId: v.variantId,
              format: v.format,
              resolution: v.resolution,
              url: v.url,
              transcode_status: v.transcode_status
            }))
          });
        }
      }
    } else {
      videos = metas.map((m) => ({
        videoId: m.videoId,
        createdAt: m.createdAt,
        createdBy: m.createdBy,
        fileName: m.fileName,
        title: m.title,
        description: m.description
      }));
    }

    res.json({
      videos,
      pagination: { page, limit, total: null } // best-effort unknown
    });
  } catch (e) {
    next(e);
  }
}

export async function getVideo(req, res, next) {
  try {
    const { videoId } = req.params;
    const items = await getAllByVideo(videoId);
    if (!items.length) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }
    const meta = items.find((i) => i.SK === 'META');
    const variants = await Promise.all(
      items
        .filter((i) => i.SK !== 'META')
        .map(async (v) => {
          const key =
            v.format === 'mp4'
              ? objectKeyOriginal(videoId, meta.fileName)
              : objectKeyVariant(videoId, v.variantId);
          const url = await presignGetObject({ key, expiresSeconds: ONE_HOUR });
          return {
            variantId: v.variantId,
            format: v.format,
            resolution: v.resolution,
            url,
            transcode_status: v.transcode_status
          };
        })
    );
    res.json({
      videoId: meta.videoId,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      fileName: meta.fileName,
      title: meta.title,
      description: meta.description,
      variants
    });
  } catch (e) {
    next(e);
  }
}

export async function updateVideo(req, res, next) {
  try {
    const { videoId } = req.params;
    const allowed = {};
    ['fileName', 'title', 'description'].forEach((k) => {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    });
    await updateMeta(videoId, allowed);
    const meta = await getMeta(videoId);
    if (!meta) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }
    res.json({
      videoId: meta.videoId,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      fileName: meta.fileName,
      title: meta.title,
      description: meta.description
    });
  } catch (e) {
    next(e);
  }
}

export async function deleteVideo(req, res, next) {
  try {
    const { videoId } = req.params;
    const items = await getAllByVideo(videoId);
    if (!items.length) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }
    // Permission check: admin or owner
    const meta = items.find((i) => i.SK === 'META');
    const { role, username } = req.user || {};
    if (!(role === 'admin' || username === meta.createdBy)) {
      return res.status(403).json({ error: { code: 'Forbidden', message: 'Requires admin or owner' } });
    }

    // Best-effort S3 deletions
    const { s3 } = await import('../services/s3.service.js');
    const { DeleteObjectsCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const { BUCKET } = await import('../services/s3.service.js');

    const prefixes = [`original/${videoId}/`, `variants/${videoId}/`];
    const failed = [];
    for (const prefix of prefixes) {
      // eslint-disable-next-line no-await-in-loop
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
      const keys = (listed.Contents || []).map((o) => ({ Key: o.Key }));
      if (keys.length) {
        // eslint-disable-next-line no-await-in-loop
        const del = await s3.send(
          new DeleteObjectsCommand({
            Bucket: BUCKET,
            Delete: { Objects: keys, Quiet: true }
          })
        );
        if (del.Errors && del.Errors.length) failed.push(...del.Errors.map((e) => e.Key));
      }
    }

    await deleteVideoRecords(videoId);
    res.json({ videoId, deleted: true, failedObjects: failed.length ? failed : undefined });
  } catch (e) {
    next(e);
  }
}

export async function startTranscoding(req, res, next) {
  try {
    const { videoId } = req.params;
    const { format } = req.body;
    if (format !== 'mkv') {
      return res.status(400).json({ error: { code: 'BadRequest', message: 'format must be "mkv"' } });
    }
    const existing = await findExistingVariant(videoId, { format: 'mkv', resolution: 'source' });
    if (existing) {
      return res.json({ videoId, variantId: existing.variantId, status: 'completed' });
    }
    const job = await startTranscodeJob({ videoId });
    res.json({ videoId, variantId: job.variantId, status: job.status || 'processing' });
  } catch (e) {
    next(e);
  }
}

export async function replaceOriginalPresign(req, res, next) {
  try {
    const { videoId } = req.params;
    const meta = await getMeta(videoId);
    if (!meta) {
      return res.status(404).json({ error: { code: 'NotFound', message: 'Video not found' } });
    }
    // Permission: admin or owner
    const { role, username } = req.user || {};
    if (!(role === 'admin' || username === meta.createdBy)) {
      return res.status(403).json({ error: { code: 'Forbidden', message: 'Requires admin or owner' } });
    }
    const { fileName, sizeBytes, contentType } = req.body;
    if (sizeBytes > MAX_OBJECT_SIZE) {
      return res.status(400).json({
        error: { code: 'BadRequest', message: `File too large. Max ${MAX_OBJECT_SIZE} bytes.` }
      });
    }
    if (!fileName.toLowerCase().endsWith('.mp4')) {
      return res.status(400).json({ error: { code: 'BadRequest', message: 'Only .mp4 files are accepted' } });
    }
    const clean = sanitizeFileName(fileName);
    const key = objectKeyOriginal(videoId, clean);

    if (sizeBytes >= MULTIPART_THRESHOLD) {
      const { uploadId } = await initiateMultipart({ key, contentType });
      const { parts } = await presignUploadPartUrls({
        key,
        uploadId,
        totalSizeBytes: sizeBytes,
        partSizeBytes: PART_SIZE
      });
      return res.json({
        strategy: 'multipart',
        videoId,
        bucket: BUCKET,
        key,
        uploadId,
        partSizeBytes: PART_SIZE,
        parts
      });
    } else {
      const url = await presignPutObject({ key, contentType, expiresSeconds: ONE_HOUR });
      return res.json({ strategy: 'single', videoId, bucket: BUCKET, key, url });
    }
  } catch (e) {
    next(e);
  }
}

export async function completeReplaceOriginal(req, res, next) {
  try {
    const body = req.body;
    const { videoId, key } = body;

    if ('uploadId' in body && body.uploadId) {
      await completeMultipart({ key, uploadId: body.uploadId, parts: body.parts || [] });
    }
    await headObject({ key });

    // Update META filename
    const newFileName = key.split('/').pop();
    await updateMeta(videoId, { fileName: newFileName });

    // Replace: mark existing variants as 'replaced'
    const items = await getAllByVideo(videoId);
    const variants = items.filter((i) => i.SK !== 'META');
    for (const v of variants) {
      // eslint-disable-next-line no-await-in-loop
      await updateVariant({ videoId, variantId: v.variantId, values: { transcode_status: 'replaced' } });
    }

    // Create fresh original variant (mp4 completed)
    const url = await presignGetObject({ key, expiresSeconds: ONE_HOUR });
    const seq = await getNextVariantSeq(videoId);
    const variantId = newVariantId(videoId, seq);
    await createVariant({
      videoId,
      variantId,
      format: 'mp4',
      resolution: 'source',
      size: 0,
      transcode_status: 'completed',
      url
    });

    // Start new mkv transcode automatically
    await startTranscodeJob({ videoId });

    const meta = await getMeta(videoId);
    res.json({
      videoId: meta.videoId,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      fileName: meta.fileName,
      title: meta.title,
      description: meta.description
    });
  } catch (e) {
    next(e);
  }
}
