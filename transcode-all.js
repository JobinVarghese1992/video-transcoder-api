// scripts/transcode-all.js
// Usage:
//   BASE_URL=http://<EC2>:3000 USERNAME=user1 PASSWORD=password123 node scripts/transcode-all.js
// Optional env:
//   LIMIT=100 BATCH=6 DRY_RUN=true PAUSE_MS=0

/* 
** Video delete script - all
aws s3 rm s3://n11901152-videos/original/  --recursive --region ap-southeast-2
aws s3 rm s3://n11901152-videos/variants/  --recursive --region ap-southeast-2

** Video delete script - single
VID=vid_XXXXXXXX
aws s3 rm s3://n11901152-videos/original/$VID/  --recursive --region ap-southeast-2
aws s3 rm s3://n11901152-videos/variants/$VID/  --recursive --region ap-southeast-2
*/

const BASE_URL = process.env.BASE_URL 
  // || 'http://127.0.0.1:3000';
  || 'http://ec2-3-27-12-198.ap-southeast-2.compute.amazonaws.com:3000';
const USERNAME = process.env.USERNAME || 'user2@example.com';
const PASSWORD = process.env.PASSWORD || 'User2@123';
const LIMIT = Number(process.env.LIMIT || 100);

// NEW: BATCH is how many videos we process **in parallel per round**
const BATCH = Math.max(1, Number(process.env.BATCH || 6));

// NEW: optional pause between batches (ms)
const PAUSE_MS = Math.max(0, Number(process.env.PAUSE_MS || 0));

const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

async function sleep(ms) {
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
}

async function login() {
  const r = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!j?.token) throw new Error('no token in login response');
  return j.token;
}

async function listVideos(token) {
  const url = `${BASE_URL}/api/v1/videos?limit=${LIMIT}&sort=createdAt:desc`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`listVideos failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j?.videos || [];
}

async function startTranscode(token, videoId) {
  const r = await fetch(`${BASE_URL}/api/v1/videos/${encodeURIComponent(videoId)}/transcode`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ force: true }),
  });
  if (!r.ok) throw new Error(`transcode ${videoId} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  console.log(`Base: ${BASE_URL}`);
  const token = await login();
  console.log('Logged in.');

  const videos = await listVideos(token);
  if (!videos.length) {
    console.log('No videos found.');
    return;
  }

  console.log(`Found ${videos.length} video(s). BATCH=${BATCH} DRY_RUN=${DRY_RUN} PAUSE_MS=${PAUSE_MS}`);

  const ids = videos.map(v => v.videoId).filter(Boolean);
  let ok = 0, failed = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);

    console.log(`\nStarting batch ${Math.floor(i / BATCH) + 1} (${batch.length} jobs)…`);

    const batchPromises = batch.map(async (videoId, idx) => {
      // idx is 0..batch-1 (just for prettier logs)
      const tag = `[B${Math.floor(i / BATCH) + 1}:#${idx + 1}]`;
      try {
        if (DRY_RUN) {
          console.log(`${tag} would transcode ${videoId}`);
          ok++;
          return;
        }
        const res = await startTranscode(token, videoId);
        console.log(`${tag} ${videoId}: ${res.status}${res.url ? ' (url)' : ''}`);
        ok++;
      } catch (e) {
        failed++;
        console.error(`${tag} ${videoId}: ERROR ${e.message}`);
      }
    });

    // Wait for *this* batch to complete before continuing
    await Promise.allSettled(batchPromises);

    if (i + BATCH < ids.length && PAUSE_MS > 0) {
      console.log(`Batch done. Pausing ${PAUSE_MS}ms…`);
      await sleep(PAUSE_MS);
    }
  }

  console.log(`\nAll batches dispatched. ok=${ok} failed=${failed}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
