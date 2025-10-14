import express from "express";
import morgan from "morgan";
import axios from "axios";
import { file as tmpFile } from "tmp-promise";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import ffmpegPath from "which";

// ---- Config ----
const PORT = process.env.PORT || 8081;

// Try to find ffmpeg in PATH (Dockerfile installs it). If you prefer a JS binary,
// you could use @ffmpeg-installer/ffmpeg; update ffmpegBinary accordingly.
let ffmpegBinary = "ffmpeg";
try {
  ffmpegBinary = ffmpegPath.sync("ffmpeg");
} catch (e) {
  console.error("ffmpeg not found in PATH. Make sure it's installed.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

app.get("/api/health", (_req, res) => res.status(200).send("ok"));

// --- helpers ---
function keyFromS3Url(u) {
  const url = new URL(u);
  // e.g. /thumbnail/vid_123.jpg  ->  thumbnail/vid_123.jpg
  return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
}

function presignedIsExpired(u) {
  try {
    const url = new URL(u);
    const amzDate = url.searchParams.get("X-Amz-Date");       // 20251014T051321Z
    const expires = parseInt(url.searchParams.get("X-Amz-Expires") || "0", 10);
    if (!amzDate || !expires) return false;
    const y = +amzDate.slice(0, 4), m = +amzDate.slice(4, 6) - 1, d = +amzDate.slice(6, 8);
    const H = +amzDate.slice(9, 11), M = +amzDate.slice(11, 13), S = +amzDate.slice(13, 15);
    const signedAt = Date.UTC(y, m, d, H, M, S);
    return Date.now() > signedAt + expires * 1000 - 5000; // treat as expired if within 5s
  } catch { return false; }
}

// --- route ---
app.post("/api/thumbnail", async (req, res) => {
  const { videoUrl, thumbnailUrl, id } = req.body ?? {};
  const at = Number(req.body?.at ?? 1);
  const width = Number(req.body?.width ?? 512);
  const extraHeaders = req.body?.headers ?? {}; // ONLY ones that were signed

  if (!videoUrl || !thumbnailUrl || !id) {
    return res.status(400).json({ error: "Missing required fields: videoUrl, thumbnailUrl, id" });
  }

  // Enforce exact key: thumbnail/<id>.jpg
  const expectedKey = `thumbnail/${id}.jpg`;
  const actualKey = keyFromS3Url(thumbnailUrl);
  if (actualKey !== expectedKey) {
    return res.status(400).json({ error: `thumbnailUrl must target key ${expectedKey}`, actualKey });
  }

  if (presignedIsExpired(thumbnailUrl)) {
    return res.status(400).json({ error: "thumbnailUrl expired; please provide a fresh URL" });
  }

  let tmpVideo, tmpThumb;
  try {
    // 1) Download video locally
    tmpVideo = await tmpFile({ postfix: ".mp4", keep: true, detachDescriptor: true });
    const resp = await axios.get(videoUrl, { responseType: "stream", validateStatus: s => s < 400 });
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpVideo.path);
      resp.data.pipe(ws);
      resp.data.on("error", reject);
      ws.on("finish", resolve);
      ws.on("error", reject);
    });

    // 2) Generate a Finder/Preview-friendly JPEG
    tmpThumb = await tmpFile({ postfix: ".jpg", keep: true, detachDescriptor: true });
    const outPath = tmpThumb.path;

    const args = [
      "-ss", String(at),
      "-i", tmpVideo.path,
      "-frames:v", "1",
      "-vf", `scale=${width}:-1`,
      "-q:v", "2",
      "-pix_fmt", "yuvj420p",
      "-f", "image2",
      "-y",
      outPath,
    ];
    await new Promise((resolve, reject) => {
      const child = execFile(ffmpegBinary, args, (error, _stdout, stderr) => {
        if (error) { error.stderr = stderr?.toString(); return reject(error); }
        resolve();
      });
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { } reject(new Error("ffmpeg timed out")); }, 120000);
    });

    // 3) PUT to presigned URL with ONLY signed headers
    const data = await fs.promises.readFile(outPath);
    const urlObj = new URL(thumbnailUrl);
    const signedHeaders = (urlObj.searchParams.get("X-Amz-SignedHeaders") || "host")
      .split(";").map(h => h.trim().toLowerCase());

    const headers = { "Content-Length": data.length };
    if (signedHeaders.includes("content-type")) headers["Content-Type"] = "image/jpeg";

    // only forward x-amz-* that were signed
    for (const [k, v] of Object.entries(extraHeaders || {})) {
      const kl = k.toLowerCase();
      if (kl.startsWith("x-amz-") && signedHeaders.includes(kl)) headers[k] = v;
    }

    const putResp = await axios.put(thumbnailUrl, data, {
      headers,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
    if (putResp.status < 200 || putResp.status >= 300) {
      throw new Error(`Upload failed with status ${putResp.status}: ${putResp.data || ""}`);
    }

    // cleanup
    try { if (tmpVideo?.path) await fs.promises.unlink(tmpVideo.path); } catch { }
    try { if (tmpThumb?.path) await fs.promises.unlink(tmpThumb.path); } catch { }

    return res.status(200).json({
      ok: true,
      key: expectedKey,
      message: "Thumbnail generated and uploaded.",
      meta: { id, at, width, format: "jpg", contentType: "image/jpeg" },
    });
  } catch (err) {
    try { if (tmpVideo?.path) await fs.promises.unlink(tmpVideo.path); } catch { }
    try { if (tmpThumb?.path) await fs.promises.unlink(tmpThumb.path); } catch { }
    return res.status(500).json({ error: "Thumbnail generation/upload failed", detail: err?.message || String(err) });
  }
});


app.listen(PORT, () => {
  console.log(`thumb-service listening on :${PORT}`);
});
