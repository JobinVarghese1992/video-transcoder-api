// client-upload.js
// Node 18+ (built-in fetch). Uploads a .mp4 file (or all .mp4 files in a folder) using your API's presigned flow.
// Usage:
//   node client-upload.js ./lecture.mp4
//   node client-upload.js ./folder-with-mp4s

import { readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL
  || 'http://ec2-3-27-12-198.ap-southeast-2.compute.amazonaws.com:3000';
//  || 'http://localhost:3000';
const USERNAME = process.env.USERNAME || 'user2@example.com';
const PASSWORD = process.env.PASSWORD || 'User2@123';

async function login() {
  const r = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD })
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.token;
}

async function createUploadUrl(jwt, fileName, sizeBytes) {
  const r = await fetch(`${BASE_URL}/api/v1/videos/upload-url`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      fileName,
      sizeBytes,
      contentType: 'video/mp4'
    })
  });
  if (!r.ok) throw new Error(`createUploadUrl failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function uploadSingle(putUrl, fileBuffer) {
  const r = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4' },
    body: fileBuffer
  });
  if (!r.ok) throw new Error(`single PUT failed: ${r.status} ${await r.text()}`);
  // no ETag needed for single
}

function sliceBuffer(buf, start, end) {
  return buf.subarray(start, end);
}

async function uploadMultipart(parts, fileBuffer, partSize) {
  // Upload each part sequentially (simple & safe). You can parallelize later if you want.
  const results = [];
  for (const p of parts) {
    const start = (p.partNumber - 1) * partSize;
    const end = Math.min(start + partSize, fileBuffer.length);
    const chunk = sliceBuffer(fileBuffer, start, end);
    const r = await fetch(p.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk
    });
    if (!r.ok) {
      const msg = await r.text();
      throw new Error(`Upload part ${p.partNumber} failed: ${r.status} ${msg}`);
    }
    let etag = r.headers.get('etag') || r.headers.get('ETag');
    if (!etag) throw new Error(`Missing ETag for part ${p.partNumber}`);
    results.push({ partNumber: p.partNumber, eTag: etag });
    console.log(`Uploaded part ${p.partNumber}, ETag: ${etag}`);
  }
  return results;
}

async function completeUpload(jwt, body) {
  const r = await fetch(`${BASE_URL}/api/v1/videos/complete-upload`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`complete-upload failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// NEW: helper to process one file (keeps old logic intact)
async function processOne(jwt, filePath) {
  if (!filePath.toLowerCase().endsWith('.mp4')) {
    throw new Error(`Only .mp4 files allowed: ${filePath}`);
  }
  const fileName = path.basename(filePath);
  const sizeBytes = statSync(filePath).size;
  const fileBuffer = await readFile(filePath);

  console.log(`[${fileName}] Requesting upload URL(s)…`);
  const presign = await createUploadUrl(jwt, fileName, sizeBytes);
  console.log(`[${fileName}] Strategy: ${presign.strategy}`);

  if (presign.strategy === 'single') {
    console.log(`[${fileName}] Uploading single PUT…`);
    await uploadSingle(presign.url, fileBuffer);

    console.log(`[${fileName}] Completing upload…`);
    const resp = await completeUpload(jwt, { videoId: presign.videoId, key: presign.key });
    console.log(`[${fileName}] Completed:`, resp);
  } else if (presign.strategy === 'multipart') {
    const partSize = presign.partSizeBytes;
    console.log(`[${fileName}] Uploading ${presign.parts.length} parts, partSize=${partSize}…`);
    const partsWithEtags = await uploadMultipart(presign.parts, fileBuffer, partSize);

    console.log(`[${fileName}] Completing multipart…`);
    const resp = await completeUpload(jwt, {
      videoId: presign.videoId,
      key: presign.key,
      uploadId: presign.uploadId,
      parts: partsWithEtags
    });
    console.log(`[${fileName}] Completed:`, resp);
  } else {
    throw new Error(`Unknown strategy: ${presign.strategy}`);
  }
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node client-upload.js <path-to-mp4-or-folder>');
    process.exit(1);
  }

  console.log('Logging in…');
  const jwt = await login();

  const st = statSync(inputPath);
  if (st.isDirectory()) {
    // NEW: upload all .mp4 files in the folder (sequentially)
    const entries = await readdir(inputPath);
    const files = entries
      .filter((f) => f.toLowerCase().endsWith('.mp4'))
      .map((f) => path.join(inputPath, f));

    if (!files.length) {
      console.log('No .mp4 files found in the folder.');
      return;
    }

    console.log(`Found ${files.length} .mp4 file(s). Starting uploads…`);
    for (const f of files) {
      try {
        await processOne(jwt, f);
      } catch (e) {
        console.error(`[${path.basename(f)}] Error:`, e.message);
      }
    }
    console.log('All done.');
    return;
  }

  // Original single-file behavior (unchanged)
  await processOne(jwt, inputPath);
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
