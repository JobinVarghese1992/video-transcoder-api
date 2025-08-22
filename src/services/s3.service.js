// src/services/s3.service.js
import {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    GetBucketTaggingCommand,
    PutBucketTaggingCommand,
    PutObjectCommand,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    UploadPartCommand,
    HeadObjectCommand,
    GetObjectCommand
  } from '@aws-sdk/client-s3';
  import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
  import { basename } from 'node:path';
  import { createWriteStream, mkdirSync } from 'node:fs';
  import { pipeline } from 'node:stream/promises';
  
  const region = process.env.AWS_REGION || 'ap-southeast-2';
  export const BUCKET = process.env.VIDEO_BUCKET;
  
  if (!BUCKET) {
    // eslint-disable-next-line no-console
    console.error('VIDEO_BUCKET env var is required');
  }
  
  export const s3 = new S3Client({ region });
  
  // ---- helper: retry with exponential backoff + jitter
async function retry(fn, { retries = 5, baseMs = 200 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.$metadata?.httpStatusCode;
      const code = err?.name || err?.Code;
      const retryable =
        status === 409 || code === "OperationAborted" || code === "SlowDown";
      if (!retryable || i === retries) throw err;
      const delay = baseMs * 2 ** i + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
// ---- single-flight guard so we don't create twice
let ensureOnce;
export async function ensureBucketAndTags() {
  if (ensureOnce) return ensureOnce;
  ensureOnce = (async () => {
    if (!BUCKET) throw new Error("VIDEO_BUCKET env var is required");

    // 1) HEAD the bucket; if missing, create it (with retry for 409 races)
    let exists = true;
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
      console.log(`✅ Bucket "${BUCKET}" exists`);
    } catch (_e) {
      exists = false;
      console.log(`⚠️ Bucket "${BUCKET}" not found. Will create...`);
    }

    if (!exists) {
      await retry(async () => {
        if (region === "us-east-1") {
          await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
        } else {
          await s3.send(
            new CreateBucketCommand({
              Bucket: BUCKET,
              CreateBucketConfiguration: { LocationConstraint: region },
            })
          );
        }
      });
      console.log(`📦 Created bucket "${BUCKET}" in region "${region}"`);
    }

    // 2) Ensure required tags
    const required = [
      { Key: "qut-username", Value: process.env.QUT_USERNAME || "" },
      { Key: "purpose", Value: process.env.PURPOSE || "" },
    ];
    let current = [];
    try {
      const resp = await s3.send(new GetBucketTaggingCommand({ Bucket: BUCKET }));
      current = resp.TagSet || [];
    } catch {
      console.log("ℹ️ No tags yet, applying defaults...");
    }
    const merged = Object.values(
      [...current, ...required].reduce((acc, t) => {
        acc[t.Key] = t; return acc;
      }, {})
    );
    await s3.send(
      new PutBucketTaggingCommand({ Bucket: BUCKET, Tagging: { TagSet: merged } })
    );
    console.log(`🏷️ Tags applied to bucket "${BUCKET}"`);
  })();

  return ensureOnce;
}
  
  export function objectKeyOriginal(videoId, fileName) {
    return `original/${videoId}/${fileName}`;
  }
  export function objectKeyVariant(videoId, variantId) {
    return `variants/${videoId}/${variantId}.mkv`;
  }
  
  export async function presignPutObject({ key, contentType, expiresSeconds }) {
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
    return getSignedUrl(s3, command, { expiresIn: expiresSeconds });
  }
  
  export async function initiateMultipart({ key, contentType }) {
    const cmd = new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType
    });
    const resp = await s3.send(cmd);
    return { uploadId: resp.UploadId };
  }
  
  export async function presignUploadPartUrls({ key, uploadId, totalSizeBytes, partSizeBytes }) {
    const parts = [];
    const partCount = Math.ceil(totalSizeBytes / partSizeBytes);
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const cmd = new UploadPartCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: Number(process.env.PRESIGNED_TTL_SECONDS) || 3600 });
      parts.push({ partNumber, url });
    }
    return { parts, partCount };
  }
  
  export async function completeMultipart({ key, uploadId, parts }) {
    const cmd = new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ ETag: p.eTag || p.ETag || p.etag, PartNumber: p.partNumber }))
      }
    });
    return s3.send(cmd);
  }
  
  export async function abortMultipart({ key, uploadId }) {
    const cmd = new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId });
    return s3.send(cmd);
  }
  
  export async function headObject({ key }) {
    const cmd = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
    return s3.send(cmd);
  }
  
  export async function presignGetObject({ key, expiresSeconds }) {
    const cmd = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
    await s3.send(cmd); // ensure exists
    const get = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(s3, get, { expiresIn: expiresSeconds });
  }
  
  export async function downloadToFile({ key, destPath }) {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const resp = await s3.send(cmd);
    mkdirSync(basename(destPath, '/file'), { recursive: true });
    const ws = createWriteStream(destPath);
    await pipeline(resp.Body, ws);
  }
  
  export async function uploadFromFile({ key, filePath, contentType }) {
    // For simplicity, stream via fs to PutObject
    const { createReadStream } = await import('node:fs');
    const Body = createReadStream(filePath);
    const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, Body, ContentType: contentType });
    await s3.send(cmd);
  }
  