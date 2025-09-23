// src/services/ffmpeg.service.js
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { getParams } from './parameters.service.js';

let resolvedFfmpeg = null;

async function resolveFfmpegPath() {
  if (resolvedFfmpeg) return resolvedFfmpeg;
  const params = await getParams(["FFMPEG_PATH"]);
  const fromEnv = params.FFMPEG_PATH?.trim();
  if (fromEnv) {
    // Ensure file exists and is executable
    await access(fromEnv, fsConstants.X_OK);
    resolvedFfmpeg = fromEnv;
    return resolvedFfmpeg;
  }

  // Fallback: rely on PATH. We can't reliably probe PATH on all shells here,
  // so we assume 'ffmpeg' is resolvable by the OS if installed.
  resolvedFfmpeg = 'ffmpeg';
  return resolvedFfmpeg;
}

export async function transcodeMp4ToMkvH264Aac(inputPath, outputPath) {
  const ffmpegBin = await resolveFfmpegPath();
  const params = await getParams(["FFMPEG_PATH"]);
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', params.FFMPEG_PRESET || 'medium',
      outputPath,
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => {
      // If ENOENT, give a nicer hint
      if (err?.code === 'ENOENT') {
        err.message =
          `ffmpeg not found. Install ffmpeg or set FFMPEG_PATH to the binary.\n` +
          `Tried: ${ffmpegBin}\n` +
          `macOS: brew install ffmpeg | Ubuntu: sudo apt install ffmpeg`;
      }
      reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve({ code });
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 800)}`));
    });
  });
}
