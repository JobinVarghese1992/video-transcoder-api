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
    GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { dirname } from 'node:path';
import { createWriteStream, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { getParams } from './parameters.service.js';

let credentialsOpt = undefined;
if (process.env.FORCE_IMDS === 'true') {
    const { fromInstanceMetadata } = await import('@aws-sdk/credential-provider-imds');
    credentialsOpt = { credentials: fromInstanceMetadata() };
}

const region = process.env.AWS_REGION || 'ap-southeast-2';
const PRESIGNED_TTL_SECONDS = process.env.PRESIGNED_TTL_SECONDS || 3600;
const params = await getParams(["VIDEO_BUCKET"]);
export const BUCKET = params.VIDEO_BUCKET;
const DEFAULT_TTL = Number(PRESIGNED_TTL_SECONDS || 3600);

if (!BUCKET) {
    console.error('VIDEO_BUCKET env var is required');
}

export const s3 = new S3Client({ region, ...(credentialsOpt || {}) });

async function retry(fn, { retries = 5, baseMs = 200 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const status = err?.$metadata?.httpStatusCode;
            const code = err?.name || err?.Code;
            const retryable = status === 409 || code === 'OperationAborted' || code === 'SlowDown';
            if (!retryable || i === retries) throw err;
            const delay = baseMs * 2 ** i + Math.floor(Math.random() * 100);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

let ensureOnce;
export async function ensureBucketAndTags() {
    if (ensureOnce) return ensureOnce;
    ensureOnce = (async () => {
        if (!BUCKET) throw new Error('VIDEO_BUCKET env var is required');

        let exists = true;
        try {
            await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
            console.log(`Bucket "${BUCKET}" exists`);
        } catch (_e) {
            exists = false;
            console.log(`Bucket "${BUCKET}" not found. Will create...`);
        }

        if (!exists) {
            await retry(async () => {
                if (region === 'us-east-1') {
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
            console.log(`Created bucket "${BUCKET}" in region "${region}"`);
        }

        const required = [
            { Key: 'qut-username', Value: process.env.QUT_USERNAME || process.env.QUT_USERNAME_TAG || '' },
            { Key: 'purpose', Value: process.env.PURPOSE || '' },
        ];
        let current = [];
        try {
            const resp = await s3.send(new GetBucketTaggingCommand({ Bucket: BUCKET }));
            current = resp.TagSet || [];
        } catch {
            console.log('No tags yet, applying defaults...');
        }
        const merged = Object.values(
            [...current, ...required].reduce((acc, t) => {
                acc[t.Key] = t;
                return acc;
            }, {})
        );
        await s3.send(new PutBucketTaggingCommand({ Bucket: BUCKET, Tagging: { TagSet: merged } }));
        console.log(`🏷️ Tags applied to bucket "${BUCKET}"`);
    })();

    return ensureOnce;
}

// ---- S3 key helpers
function sanitizeFileName(name) {
    return String(name).replace(/[^\w.\-]/g, '_');
}
export function objectKeyOriginal(videoId, fileName) {
    return `original/${videoId}/${sanitizeFileName(fileName)}`;
}
export function objectKeyVariant(videoId, variantId) {
    return `variants/${videoId}/${sanitizeFileName(variantId)}.mkv`;
}

// ---- Presigners & operations
export async function presignPutObject({ key, contentType, expiresSeconds }) {
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
    return getSignedUrl(s3, command, { expiresIn: Number(expiresSeconds || DEFAULT_TTL) });
}

export async function initiateMultipart({ key, contentType }) {
    const cmd = new CreateMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
    });
    const resp = await s3.send(cmd);
    return { uploadId: resp.UploadId };
}

/**
 * Presign UploadPart URLs.
 * Accepts either:
 *  - { sizeBytes, partSizeMb }  OR
 *  - { totalSizeBytes, partSizeBytes }
 */
export async function presignUploadPartUrls({
    key,
    uploadId,
    sizeBytes,
    partSizeMb,
    totalSizeBytes,
    partSizeBytes,
}) {
    const ttl = DEFAULT_TTL;

    const total = Number(totalSizeBytes ?? sizeBytes);
    if (!Number.isFinite(total) || total <= 0) throw new Error('total size is required');

    let partSize = Number(partSizeBytes);
    if (!Number.isFinite(partSize) || partSize <= 0) {
        const mb = Math.max(5, Number(partSizeMb || 10)); // S3 min part size = 5MB (except final)
        partSize = mb * 1024 * 1024;
    }

    const partCount = Math.ceil(total / partSize);
    const entries = Array.from({ length: partCount }, (_, i) => i + 1);

    const urls = await Promise.all(
        entries.map(async (partNumber) => {
            const cmd = new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber });
            const url = await getSignedUrl(s3, cmd, { expiresIn: ttl });
            return { partNumber, url };
        })
    );

    return { parts: urls, partCount, partSizeBytes: partSize };
}

export async function completeMultipart({ key, uploadId, parts }) {
    const cmd = new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
            Parts: parts
                .slice()
                .sort((a, b) => a.partNumber - b.partNumber)
                .map((p) => ({ ETag: p.eTag || p.ETag || p.etag, PartNumber: p.partNumber })),
        },
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
    try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch {
    }
    const get = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(s3, get, { expiresIn: Number(expiresSeconds || DEFAULT_TTL) });
}

export async function downloadToFile({ key, destPath }) {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const resp = await s3.send(cmd);
    mkdirSync(dirname(destPath), { recursive: true });
    const ws = createWriteStream(destPath);
    await pipeline(resp.Body, ws);
}

export async function uploadFromFile({ key, filePath, contentType }) {
    const { createReadStream } = await import('node:fs');
    const Body = createReadStream(filePath);
    const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, Body, ContentType: contentType });
    await s3.send(cmd);
}


