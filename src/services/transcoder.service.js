import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  objectKeyOriginal,
  objectKeyVariant,
  downloadToFile,
  uploadFromFile,
  presignGetObject
} from './s3.service.js';
import {
  createVariant,
  findExistingVariant,
  getMeta,
  getNextVariantSeq,
  newVariantId,
  updateVariant
} from './videos.service.js';
import { getParams } from './parameters.service.js';

const params = await getParams(["MAX_CONCURRENT_JOBS", "TEMP_DIR", "PRESIGNED_TTL_SECONDS", "TRANSCODE_MAX_RETRIES"]);

const MAX_CONCURRENCY = Number(params.MAX_CONCURRENT_JOBS || 0);
const TEMP_DIR = params.TEMP_DIR || '/tmp/video-jobs';
const GET_TTL = Number(params.PRESIGNED_TTL_SECONDS || 3600);
const MAX_RETRIES = Number(params.TRANSCODE_MAX_RETRIES || 2);

let active = 0;
const queue = [];

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

function drain() {
  if (queue.length === 0) return;
  if (MAX_CONCURRENCY > 0 && active >= MAX_CONCURRENCY) return;
  const { task, resolve, reject } = queue.shift();
  active++;
  task()
    .then(resolve)
    .catch(reject)
    .finally(() => {
      active--;
      drain();
    });
}

async function runFfmpeg(src, out) {
  const args = ['-y', '-i', src, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', out];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split('\n').slice(-5).join('\n')}`));
    });
  });
}

export async function startTranscodeJob({ videoId }) {
  return enqueue(async () => {
    const existing = await findExistingVariant(videoId, { format: 'mkv', resolution: 'source' });
    if (existing) {
      return { variantId: existing.variantId, status: 'completed', url: existing.url };
    }

    const meta = await getMeta(videoId);
    if (!meta) {
      const err = new Error('Video not found');
      err.statusCode = 404;
      err.code = 'NotFound';
      throw err;
    }

    const seq = await getNextVariantSeq(videoId);
    const variantId = newVariantId(videoId, seq);
    await createVariant({
      videoId,
      variantId,
      format: 'mkv',
      resolution: 'source',
      transcode_status: 'processing',
      url: ''
    });

    const jobDir = join(TEMP_DIR, videoId, variantId);
    const srcPath = join(jobDir, 'src.mp4');
    const outPath = join(jobDir, 'out.mkv');
    mkdirSync(jobDir, { recursive: true });

    const srcKey = objectKeyOriginal(videoId, meta.fileName);
    const variantKey = objectKeyVariant(videoId, variantId);

    let attempt = 0;
    while (true) {
      try {
        await downloadToFile({ key: srcKey, destPath: srcPath });
        await runFfmpeg(srcPath, outPath);
        await uploadFromFile({
          key: variantKey,
          filePath: outPath,
          contentType: 'video/x-matroska'
        });
        const url = await presignGetObject({ key: variantKey, expiresSeconds: GET_TTL });
        await updateVariant({
          videoId,
          variantId,
          values: { transcode_status: 'completed', url }
        });
        break;
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          await updateVariant({
            videoId,
            variantId,
            values: { transcode_status: 'failed', error_message: err.message }
          });
          rmSync(jobDir, { recursive: true, force: true });
          throw err;
        } else {
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        }
      }
    }

    rmSync(jobDir, { recursive: true, force: true });
    return { variantId, status: 'completed' };
  });
}
