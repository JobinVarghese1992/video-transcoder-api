import express from "express";
import morgan from "morgan";
import axios from "axios";
import { file as tmpFile } from "tmp-promise";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import ffmpegPath from "which";

// ---- Config ----
const PORT = process.env.PORT || 8080;

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

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

/**
 * POST /thumbnail
 * Body: {
 *   videoUrl: string (presigned GET),
 *   thumbnailUrl: string (presigned PUT),
 *   at?: number (seconds, default 1),
 *   width?: number (default 512),
 *   format?: 'jpg' | 'png' (default 'jpg'),
 *   headers?: Record<string,string> (optional extra headers to include in the PUT)
 * }
 */
app.post("/thumbnail", async (req, res) => {
  const { videoUrl, thumbnailUrl } = req.body ?? {};
  const at = Number(req.body?.at ?? 1);
  const width = Number(req.body?.width ?? 512);
  const format = (req.body?.format ?? "jpg").toLowerCase();
  const extraHeaders = req.body?.headers ?? {};

  console.log(`Thumbnail request: videoUrl=${videoUrl?.slice(0,50)}..., thumbnailUrl=${thumbnailUrl?.slice(0,50)}..., at=${at}, width=${width}, format=${format}`);

  if (!videoUrl || !thumbnailUrl) {
    return res.status(400).json({ error: "Missing required fields: videoUrl, thumbnailUrl" });
  }

  let tmpThumb, tmpVideo;
  try {
    // 1) Download video to a local temp file (avoid ffmpeg→S3 403s)
    tmpVideo = await tmpFile({ postfix: ".mp4", keep: true, detachDescriptor: true });
    const vidStream = await axios.get(videoUrl, { responseType: "stream", validateStatus: s => s < 400 });
    const writeStream = fs.createWriteStream(tmpVideo.path);
    await new Promise((resolve, reject) => {
      vidStream.data.pipe(writeStream);
      vidStream.data.on("error", reject);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    console.log(`Downloaded video to ${tmpVideo.path}`);

    // 2) Prepare temp output for thumbnail
    tmpThumb = await tmpFile({ postfix: `.${format}`, keep: true, detachDescriptor: true });
    const outPath = tmpThumb.path;

    console.log(`Generating thumbnail at ${at}s, width=${width}, format=${format}`);

    // 3) Run ffmpeg on the local file (no network)
    const args = [
      "-ss", at.toString(),
      "-i", tmpVideo.path,
      "-frames:v", "1",
      "-vf", `scale=${width}:-1`,
      "-y",
      outPath,
    ];

    await new Promise((resolve, reject) => {
      const child = execFile(ffmpegBinary, args, (error, _stdout, stderr) => {
        if (error) {
          error.stderr = stderr?.toString();
          return reject(error);
        }
        resolve();
      });
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("ffmpeg timed out")); }, 120000);
    });

    console.log(`Thumbnail generated at ${outPath}`);

    // 4) Upload thumbnail via presigned PUT
    const data = await fs.promises.readFile(outPath);
    const contentType = format === "png" ? "image/png" : "image/jpeg";

    console.log(`Uploading thumbnail to ${thumbnailUrl} (${data.length} bytes, ${contentType})`);

    // Only send headers that were signed (if any)
    const urlObj = new URL(thumbnailUrl);
    const signedHeaders = (urlObj.searchParams.get("X-Amz-SignedHeaders") || "host")
      .split(";").map(h => h.trim().toLowerCase());

    const headers = { "Content-Length": data.length };
    if (signedHeaders.includes("content-type")) headers["Content-Type"] = contentType;
    // pass through any required amz headers provided by client
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (k.toLowerCase().startsWith("x-amz-")) headers[k] = v;
    }

    console.log("PUT headers:", headers);

    const putResp = await axios.put(thumbnailUrl, data, { headers, maxBodyLength: Infinity, validateStatus: () => true });
    if (putResp.status < 200 || putResp.status >= 300) {
      throw new Error(`Upload failed with status ${putResp.status}: ${putResp.data || ""}`);
    }

    console.log("Thumbnail upload complete.");

    // cleanup
    try { if (tmpVideo?.path) await fs.promises.unlink(tmpVideo.path); } catch {}
    try { if (tmpThumb?.path) await fs.promises.unlink(tmpThumb.path); } catch {}

    console.log("Thumbnail process completed successfully.");

    return res.status(200).json({
      ok: true,
      message: "Thumbnail generated and uploaded.",
      meta: { at, width, format, contentType }
    });
  } catch (err) {
    // cleanup on error
    try { if (tmpVideo?.path) await fs.promises.unlink(tmpVideo.path); } catch {}
    try { if (tmpThumb?.path) await fs.promises.unlink(tmpThumb.path); } catch {}

    console.error("Thumbnail error:", err?.message, err?.stderr || "");
    return res.status(500).json({
      error: "Thumbnail generation/upload failed",
      detail: err?.message || String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`thumb-service listening on :${PORT}`);
});
