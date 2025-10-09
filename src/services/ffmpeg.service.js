import { spawn } from 'node:child_process';

let resolvedFfmpeg = null;

async function resolveFfmpegPath() {
  if (resolvedFfmpeg) return resolvedFfmpeg;

  resolvedFfmpeg = 'ffmpeg';
  return resolvedFfmpeg;
}

export async function transcodeMp4ToMkvH264Aac(inputPath, outputPath) {
  const ffmpegBin = await resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'medium',
      outputPath,
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => {
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
