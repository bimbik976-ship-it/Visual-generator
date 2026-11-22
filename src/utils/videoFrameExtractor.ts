export interface ExtractedVideoFrame {
  label: string;
  timestampSeconds: number;
  mimeType: string;
  dataUrl: string;
}

export interface VideoFrameExtractionResult {
  durationSeconds: number;
  width: number;
  height: number;
  frames: ExtractedVideoFrame[];
}

export async function extractVideoKeyframes(
  file: File,
  maxFrames = 6
): Promise<VideoFrameExtractionResult> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out loading video metadata for frame extraction.'));
      }, 15000);

      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Unable to decode video "${file.name}". Your browser may not support this codec/container.`
          )
        );
      };
    });

    const duration = video.duration;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!Number.isFinite(duration) || duration <= 0 || vw <= 0 || vh <= 0) {
      throw new Error(`Video "${file.name}" has invalid duration or empty visual dimensions.`);
    }

    const targetWidth = Math.min(vw, 960);
    const targetHeight = Math.max(1, Math.round((vh / vw) * targetWidth));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Browser canvas 2D context is unavailable for frame extraction.');
    }

    const frameCount = duration < 1.5 ? 2 : Math.min(maxFrames, Math.max(3, Math.ceil(duration / 3)));
    const frames: ExtractedVideoFrame[] = [];

    for (let i = 0; i < frameCount; i++) {
      const ratio = frameCount === 1 ? 0.5 : i / (frameCount - 1);
      const t = Math.min(Math.max(0.05, ratio * (duration - 0.1)), Math.max(0.05, duration - 0.05));

      await new Promise<void>((resolve, reject) => {
        const seekTimeout = setTimeout(() => {
          reject(new Error(`Timed out seeking to ${t.toFixed(1)}s in "${file.name}".`));
        }, 10000);

        const handleSeeked = () => {
          clearTimeout(seekTimeout);
          video.removeEventListener('seeked', handleSeeked);
          resolve();
        };
        video.addEventListener('seeked', handleSeeked);
        video.currentTime = t;
      });

      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
      frames.push({
        label: `${t.toFixed(1)}s`,
        timestampSeconds: Number(t.toFixed(2)),
        mimeType: 'image/jpeg',
        dataUrl,
      });
    }

    return {
      durationSeconds: Number(duration.toFixed(2)),
      width: vw,
      height: vh,
      frames,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
