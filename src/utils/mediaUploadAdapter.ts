import type { CatalogModel, ModelInputField } from '../types';

export type MediaFieldKind = 'image' | 'video' | 'audio' | 'none';

export interface ImageFieldConstraints {
  acceptedMimeTypes: string[];
  acceptAttr: string;
  formatLabel: string;
  maxSizeBytes: number;
  maxSizeMbLabel: string;
  maxCount: number;
  allowsAssetUri: boolean;
}

const MIME_TO_EXT: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/bmp': ['.bmp'],
  'image/tiff': ['.tif', '.tiff'],
  'image/gif': ['.gif'],
};

const MIME_LABEL: Record<string, string> = {
  'image/jpeg': 'JPG/JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/gif': 'GIF',
};

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
};

export function getFieldMediaKind(field: ModelInputField): MediaFieldKind {
  if (field.type !== 'string' && field.type !== 'array') return 'none';
  if (field.enumValues && field.enumValues.length > 0) return 'none';

  const n = field.name.toLowerCase();
  if (
    n === 'callbackurl' ||
    n === 'callback_url' ||
    n === 'reference_link_urls' ||
    n === 'omni_reference_task_type' ||
    n === 'num_frames' ||
    n === 'frames_per_second' ||
    n === 'aspect_ratio' ||
    n === 'resolution' ||
    n === 'duration' ||
    n === 'prompt' ||
    n === 'negative_prompt'
  ) {
    return 'none';
  }

  if (n.includes('audio') || n.includes('voice')) return 'audio';
  if (n.includes('video') || n.includes('clip')) return 'video';

  if (
    n.includes('image') ||
    n.includes('frame') ||
    n === 'loop_url' ||
    n === 'keyframes' ||
    n === 'keyframe_urls' ||
    n === 'input_urls' ||
    n === 'mask_url'
  ) {
    return 'image';
  }

  return 'none';
}

export function hasImageInputSupport(model: CatalogModel | null | undefined): boolean {
  if (!model) return false;
  const hasImageField = model.fields.some((f) => getFieldMediaKind(f) === 'image');
  if (hasImageField) return true;
  return model.modes.some((m) =>
    /image-to-video|reference-to-video|image-to-image|image-edit|inpaint|upscale/i.test(m)
  );
}

export function parseImageFieldConstraints(field: ModelInputField): ImageFieldConstraints {
  const desc = field.description || '';
  const descLower = desc.toLowerCase();

  // Extract accepted image formats explicitly stated in Kie.ai docs
  const detectedMimes: string[] = [];
  const hasExplicitMimeOrFmt =
    /accepted types:|supported formats:|formats:|image\/|must be in jpg|png\s*\/\s*jpeg/i.test(desc);

  if (hasExplicitMimeOrFmt) {
    if (/jpeg|jpg/i.test(desc)) detectedMimes.push('image/jpeg');
    if (/png/i.test(desc)) detectedMimes.push('image/png');
    if (/webp/i.test(desc)) detectedMimes.push('image/webp');
    if (/\bbmp\b|image\/bmp/i.test(desc)) detectedMimes.push('image/bmp');
    if (/\btiff?\b|image\/tiff/i.test(desc)) detectedMimes.push('image/tiff');
    if (/\bgif\b|image\/gif/i.test(desc)) detectedMimes.push('image/gif');
  }

  const acceptedMimeTypes =
    detectedMimes.length > 0 ? detectedMimes : ['image/jpeg', 'image/png', 'image/webp'];

  const exts = acceptedMimeTypes.flatMap((m) => MIME_TO_EXT[m] || []);
  const acceptAttr = exts.join(',') || '.jpg,.jpeg,.png,.webp';
  const formatLabel = acceptedMimeTypes.map((m) => MIME_LABEL[m] || m).join(', ');

  // Extract max size in MB from docs (e.g. "Max size: 10.0MB", "less than 30 MB", "20MB", "5.0MB")
  let maxMb = 10;
  const sizeMatch =
    desc.match(/(?:max(?:imum)?\s*(?:file\s*)?size|no larger than|not exceed|less than)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*MB/i) ||
    desc.match(/(\d+(?:\.\d+)?)\s*MB/i);
  if (sizeMatch) {
    const parsed = Number(sizeMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 50) {
      maxMb = parsed;
    }
  }
  const maxSizeBytes = Math.round(maxMb * 1024 * 1024);
  const maxSizeMbLabel = `${Number.isInteger(maxMb) ? maxMb : maxMb.toFixed(1)} MB`;

  // Extract max array item count
  let maxCount = field.type === 'array' ? 10 : 1;
  if (field.type === 'array') {
    const singleCheck =
      /single image url|up to 1 file|at most one image/i.test(descLower);
    const numMatch =
      desc.match(/(?:up to|max(?:imum)?(?:\s+of)?)\s+\*{0,2}(\d+)\*{0,2}\s*(?:images?|files?|urls?|items?)/i) ||
      desc.match(/(?:provide|0|1)[–-](\d+)\s*(?:images?|reference images?)/i);
    if (singleCheck) {
      maxCount = 1;
    } else if (numMatch) {
      const n = Number(numMatch[1]);
      if (Number.isFinite(n) && n > 0) maxCount = n;
    }
  }

  return {
    acceptedMimeTypes,
    acceptAttr,
    formatLabel,
    maxSizeBytes,
    maxSizeMbLabel,
    maxCount,
    allowsAssetUri: descLower.includes('asset://'),
  };
}

function detectBrowserImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WEBP (RIFF....WEBP)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  // TIFF
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return 'image/tiff';
  }
  return null;
}

export async function validateImageFileForField(
  file: File,
  constraints: ImageFieldConstraints
): Promise<
  | { ok: true; mimeType: string }
  | { ok: false; code: 'INVALID_FORMAT' | 'IMAGE_TOO_LARGE' | 'FILE_UNREADABLE'; error: string }
> {
  if (!file || file.size <= 0) {
    return {
      ok: false,
      code: 'FILE_UNREADABLE',
      error: 'Selected image file is empty (0 bytes) or unreadable.',
    };
  }

  if (file.size > constraints.maxSizeBytes) {
    return {
      ok: false,
      code: 'IMAGE_TOO_LARGE',
      error: `Image Too Large: "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds the ${constraints.maxSizeMbLabel} limit for this model.`,
    };
  }

  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  const extMime = EXT_TO_MIME[ext] || null;

  let headerBytes: Uint8Array;
  try {
    const slice = await file.slice(0, 16).arrayBuffer();
    headerBytes = new Uint8Array(slice);
  } catch {
    return {
      ok: false,
      code: 'FILE_UNREADABLE',
      error: `Unable to read file "${file.name}" from device.`,
    };
  }

  const realMime = detectBrowserImageMime(headerBytes);
  if (!realMime) {
    return {
      ok: false,
      code: 'INVALID_FORMAT',
      error: `Invalid Image Format: "${file.name}" does not have a valid image header. Accepted formats: ${constraints.formatLabel}.`,
    };
  }

  if (extMime && extMime !== realMime) {
    return {
      ok: false,
      code: 'INVALID_FORMAT',
      error: `Invalid Image Format: File extension "${ext}" does not match actual image encoding (${MIME_LABEL[realMime] || realMime}).`,
    };
  }

  if (!constraints.acceptedMimeTypes.includes(realMime)) {
    return {
      ok: false,
      code: 'INVALID_FORMAT',
      error: `Invalid Image Format: ${MIME_LABEL[realMime] || realMime} is not accepted by this model. Accepted formats: ${constraints.formatLabel}.`,
    };
  }

  return { ok: true, mimeType: realMime };
}
