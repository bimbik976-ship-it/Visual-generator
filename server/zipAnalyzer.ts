import JSZip from 'jszip';
import path from 'node:path';

export const ZIP_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 150;
export const ZIP_MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
export const ZIP_MAX_COMPRESSION_RATIO = 100;
export const ZIP_MAX_TEXT_BYTES = 512 * 1024;
export const ZIP_MAX_TOTAL_TEXT_CHARS = 180_000;
export const ZIP_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ZIP_MAX_IMAGES = 8;

export interface ZipManifestEntry {
  path: string;
  size: number;
  kind: 'text' | 'image' | 'video' | 'executable' | 'binary' | 'unsafe';
  status: 'parsed' | 'truncated' | 'skipped' | 'error';
  reason?: string;
}

export interface ZipExtractedImage {
  path: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

export interface ZipExtractedText {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface ZipParseResult {
  ok: boolean;
  fileName: string;
  archiveSize: number;
  totalEntries: number;
  entries: ZipManifestEntry[];
  textFiles: ZipExtractedText[];
  images: ZipExtractedImage[];
  summaryText: string;
  warnings: string[];
  error?: string;
}

const EXECUTABLE_EXTS = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.msi',
  '.app',
  '.dmg',
  '.so',
  '.dylib',
  '.scr',
  '.vbs',
  '.ps1',
  '.jar',
  '.com',
  '.bin',
  '.class',
  '.pyc',
  '.pyo',
  '.wasm',
  '.elf',
]);

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.xml',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.cpp',
  '.cc',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.sql',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.sh',
  '.zsh',
  '.svg',
  '.gitignore',
  '.dockerignore',
  '.prisma',
  '.graphql',
  '.gql',
]);

const TEXT_BASENAMES = new Set([
  'readme',
  'license',
  'makefile',
  'dockerfile',
  'procfile',
  '.gitignore',
  '.env.example',
]);

const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv']);

function isSafeArchivePath(entryName: string): boolean {
  if (!entryName || entryName.includes('\0')) return false;
  if (entryName.startsWith('/') || entryName.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(entryName)) return false;
  const segments = entryName.split(/[\\/]/);
  if (segments.some((seg) => seg === '..')) return false;
  const normalized = path.posix.normalize(entryName.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return false;
  }
  return true;
}

export function detectImageMimeFromBytes(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function hasBinaryNullBytes(buf: Uint8Array): boolean {
  const checkLen = Math.min(buf.length, 4096);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function parseZipArchiveBuffer(
  buffer: Buffer,
  fileName: string
): Promise<ZipParseResult> {
  const safeName = path.basename(fileName || 'archive.zip');
  if (buffer.length === 0) {
    return {
      ok: false,
      fileName: safeName,
      archiveSize: 0,
      totalEntries: 0,
      entries: [],
      textFiles: [],
      images: [],
      summaryText: '',
      warnings: [],
      error: 'ZIP archive is empty (0 bytes).',
    };
  }
  if (buffer.length > ZIP_MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      fileName: safeName,
      archiveSize: buffer.length,
      totalEntries: 0,
      entries: [],
      textFiles: [],
      images: [],
      summaryText: '',
      warnings: [],
      error: `ZIP file exceeds the ${Math.round(ZIP_MAX_ARCHIVE_BYTES / (1024 * 1024))} MB upload limit.`,
    };
  }

  // Validate PKZIP magic signature (PK\x03\x04 local header or PK\x05\x06 empty end-of-central-directory)
  const isPk =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06));
  if (!isPk) {
    return {
      ok: false,
      fileName: safeName,
      archiveSize: buffer.length,
      totalEntries: 0,
      entries: [],
      textFiles: [],
      images: [],
      summaryText: '',
      warnings: [],
      error: 'Invalid ZIP signature: file does not appear to be a real ZIP archive.',
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return {
      ok: false,
      fileName: safeName,
      archiveSize: buffer.length,
      totalEntries: 0,
      entries: [],
      textFiles: [],
      images: [],
      summaryText: '',
      warnings: [],
      error: `Failed to read ZIP archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const rawFiles = Object.values(zip.files).filter((f) => !f.dir);
  if (rawFiles.length > ZIP_MAX_ENTRIES) {
    return {
      ok: false,
      fileName: safeName,
      archiveSize: buffer.length,
      totalEntries: rawFiles.length,
      entries: [],
      textFiles: [],
      images: [],
      summaryText: '',
      warnings: [],
      error: `ZIP archive contains ${rawFiles.length} files, exceeding the ${ZIP_MAX_ENTRIES}-file security limit.`,
    };
  }

  const entries: ZipManifestEntry[] = [];
  const textFiles: ZipExtractedText[] = [];
  const images: ZipExtractedImage[] = [];
  const warnings: string[] = [];

  let totalUncompressed = 0;
  let totalTextChars = 0;

  for (const zipEntry of rawFiles) {
    const entryPath = zipEntry.name;
    const rawOriginalPath =
      (zipEntry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entryPath;

    // Skip macOS resource fork metadata noise silently or flag clearly
    if (entryPath.startsWith('__MACOSX/') || entryPath.endsWith('/.DS_Store') || entryPath === '.DS_Store') {
      continue;
    }

    if (!isSafeArchivePath(rawOriginalPath) || !isSafeArchivePath(entryPath)) {
      entries.push({
        path: rawOriginalPath,
        size: 0,
        kind: 'unsafe',
        status: 'skipped',
        reason: 'Unsafe archive path (path traversal blocked)',
      });
      warnings.push(`Blocked unsafe path: ${rawOriginalPath}`);
      continue;
    }

    // Check internal JSZip uncompressed size metadata if available before decompression
    const internalData = (zipEntry as unknown as {
      _data?: { uncompressedSize?: number; compressedSize?: number };
    })._data;
    const estUncompressed = internalData?.uncompressedSize ?? 0;
    const estCompressed = internalData?.compressedSize ?? 0;

    if (estUncompressed > 0) {
      if (totalUncompressed + estUncompressed > ZIP_MAX_UNCOMPRESSED_BYTES) {
        warnings.push(`Stopped extraction at "${entryPath}": uncompressed size exceeds 40 MB safety cap.`);
        entries.push({
          path: entryPath,
          size: estUncompressed,
          kind: 'unsafe',
          status: 'skipped',
          reason: 'Total extracted archive size limit (40 MB) reached',
        });
        continue;
      }
      if (estCompressed > 0 && estUncompressed / estCompressed > ZIP_MAX_COMPRESSION_RATIO && estUncompressed > 1024 * 1024) {
        warnings.push(`Blocked suspicious compression ratio in "${entryPath}" (ZIP bomb protection).`);
        entries.push({
          path: entryPath,
          size: estUncompressed,
          kind: 'unsafe',
          status: 'skipped',
          reason: 'Suspicious compression ratio (ZIP bomb protection)',
        });
        continue;
      }
    }

    const baseLower = path.posix.basename(entryPath).toLowerCase();
    const extLower = path.posix.extname(entryPath).toLowerCase();

    if (EXECUTABLE_EXTS.has(extLower)) {
      entries.push({
        path: entryPath,
        size: estUncompressed,
        kind: 'executable',
        status: 'skipped',
        reason: `Executable/binary file (${extLower}) blocked for security`,
      });
      continue;
    }

    if (VIDEO_EXTS.has(extLower)) {
      entries.push({
        path: entryPath,
        size: estUncompressed,
        kind: 'video',
        status: 'skipped',
        reason: 'Video inside ZIP was not extracted; attach the video directly in Chat Generator to analyze it.',
      });
      continue;
    }

    const expectedImageMime = IMAGE_EXTS[extLower];
    const isKnownText = TEXT_EXTS.has(extLower) || TEXT_BASENAMES.has(baseLower);

    if (!expectedImageMime && !isKnownText) {
      entries.push({
        path: entryPath,
        size: estUncompressed,
        kind: 'binary',
        status: 'skipped',
        reason: `Unsupported file format (${extLower || 'binary'})`,
      });
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = await zipEntry.async('uint8array');
    } catch (err) {
      entries.push({
        path: entryPath,
        size: estUncompressed,
        kind: expectedImageMime ? 'image' : 'text',
        status: 'error',
        reason: `Failed to decompress entry: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    totalUncompressed += bytes.byteLength;
    if (totalUncompressed > ZIP_MAX_UNCOMPRESSED_BYTES) {
      entries.push({
        path: entryPath,
        size: bytes.byteLength,
        kind: 'unsafe',
        status: 'skipped',
        reason: 'Total extracted archive size limit (40 MB) exceeded',
      });
      warnings.push(`Stopped further extraction at "${entryPath}": total uncompressed data exceeded 40 MB.`);
      break;
    }

    if (expectedImageMime) {
      if (images.length >= ZIP_MAX_IMAGES) {
        entries.push({
          path: entryPath,
          size: bytes.byteLength,
          kind: 'image',
          status: 'skipped',
          reason: `Image limit reached (max ${ZIP_MAX_IMAGES} images extracted per ZIP)`,
        });
        continue;
      }
      if (bytes.byteLength > ZIP_MAX_IMAGE_BYTES) {
        entries.push({
          path: entryPath,
          size: bytes.byteLength,
          kind: 'image',
          status: 'skipped',
          reason: `Image exceeds ${Math.round(ZIP_MAX_IMAGE_BYTES / (1024 * 1024))} MB limit`,
        });
        continue;
      }
      const detectedMime = detectImageMimeFromBytes(bytes);
      if (!detectedMime) {
        entries.push({
          path: entryPath,
          size: bytes.byteLength,
          kind: 'binary',
          status: 'error',
          reason: 'File extension claims image, but binary header is invalid or corrupted.',
        });
        continue;
      }
      const b64 = Buffer.from(bytes).toString('base64');
      images.push({
        path: entryPath,
        mimeType: detectedMime,
        size: bytes.byteLength,
        dataUrl: `data:${detectedMime};base64,${b64}`,
      });
      entries.push({
        path: entryPath,
        size: bytes.byteLength,
        kind: 'image',
        status: 'parsed',
      });
      continue;
    }

    // Text / code entry
    if (hasBinaryNullBytes(bytes)) {
      entries.push({
        path: entryPath,
        size: bytes.byteLength,
        kind: 'binary',
        status: 'skipped',
        reason: 'Contains binary null bytes; skipped as non-text content',
      });
      continue;
    }

    let truncated = false;
    let slice = bytes;
    if (bytes.byteLength > ZIP_MAX_TEXT_BYTES) {
      slice = bytes.subarray(0, ZIP_MAX_TEXT_BYTES);
      truncated = true;
    }

    let decoded = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    const remainingBudget = ZIP_MAX_TOTAL_TEXT_CHARS - totalTextChars;
    if (remainingBudget <= 0) {
      entries.push({
        path: entryPath,
        size: bytes.byteLength,
        kind: 'text',
        status: 'skipped',
        reason: 'Total text character budget across archive reached',
      });
      continue;
    }
    if (decoded.length > remainingBudget) {
      decoded = decoded.slice(0, remainingBudget);
      truncated = true;
    }

    totalTextChars += decoded.length;
    textFiles.push({
      path: entryPath,
      size: bytes.byteLength,
      content: decoded,
      truncated,
    });
    entries.push({
      path: entryPath,
      size: bytes.byteLength,
      kind: 'text',
      status: truncated ? 'truncated' : 'parsed',
      reason: truncated ? 'Content truncated to fit safe context window' : undefined,
    });
  }

  // Build deterministic manifest + readable text block for model context
  const lines: string[] = [
    `[ZIP ARCHIVE: ${safeName} (${buffer.length.toLocaleString()} bytes, ${entries.length} entries)]`,
    `Manifest:`,
    ...entries.map(
      (e) =>
        `- ${e.path} (${e.size.toLocaleString()} bytes, ${e.kind}, ${e.status}${e.reason ? `: ${e.reason}` : ''})`
    ),
  ];

  if (textFiles.length > 0) {
    lines.push('', 'Extracted Text / Code Contents:');
    for (const tf of textFiles) {
      lines.push(
        `\n--- FILE: ${tf.path} (${tf.size.toLocaleString()} bytes${tf.truncated ? ', TRUNCATED' : ''}) ---`,
        tf.content
      );
    }
  }

  return {
    ok: true,
    fileName: safeName,
    archiveSize: buffer.length,
    totalEntries: entries.length,
    entries,
    textFiles,
    images,
    summaryText: lines.join('\n'),
    warnings,
  };
}
