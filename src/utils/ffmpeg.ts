import { spawn } from 'child_process';
import { PassThrough } from 'stream';

export async function extractFirstFrame(videoUrl: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn('ffmpeg', [
      '-i', videoUrl,
      '-vframes', '1',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ]);

    const buffers: Buffer[] = [];
    ffmpegProcess.stdout.on('data', (chunk) => buffers.push(chunk));

    ffmpegProcess.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(buffers));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    ffmpegProcess.on('error', reject);
  });
}

export function streamMux(videoUrl: string, audioUrl?: string): PassThrough {
  const stream = new PassThrough();

  const args = ['-i', videoUrl];
  if (audioUrl) {
    args.push('-i', audioUrl);
    args.push('-c:v', 'copy', '-c:a', 'aac', '-strict', 'experimental', '-movflags', 'faststart+frag_keyframe+empty_moov');
  } else {
    args.push('-c:v', 'copy', '-c:a', 'copy', '-movflags', 'faststart+frag_keyframe+empty_moov');
  }
  args.push('-f', 'mp4', 'pipe:1');

  const ffmpegProcess = spawn('ffmpeg', args);

  ffmpegProcess.stdout.pipe(stream);

  ffmpegProcess.on('error', (err: any) => {
    console.error('ffmpeg mux error:', err);
  });

  return stream;
}
