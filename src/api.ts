import { getOrCreateDeviceId } from './storage/localVault';
import type {
  AffordabilitySummary,
  CatalogModel,
  ChatAttachmentPayload,
  ChatTokenUsage,
  CostCalculationResult,
  GenerationStatus,
  KeyStatus,
  ModelCategory,
} from './types';

export interface ZipParseResponse {
  ok: boolean;
  fileName: string;
  archiveSize: number;
  totalEntries: number;
  entries: Array<{
    path: string;
    size: number;
    kind: 'text' | 'image' | 'video' | 'executable' | 'binary' | 'unsafe';
    status: 'parsed' | 'truncated' | 'skipped' | 'error';
    reason?: string;
  }>;
  textFiles: Array<{
    path: string;
    size: number;
    content: string;
    truncated: boolean;
  }>;
  images: Array<{
    path: string;
    mimeType: string;
    size: number;
    dataUrl: string;
  }>;
  summaryText: string;
  warnings: string[];
  error?: string;
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const { headers: extraHeaders, ...restOptions } = options || {};
  const res = await fetch(url, {
    ...restOptions,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': getOrCreateDeviceId(),
      ...(extraHeaders || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { error?: string; msg?: string }).error ||
      (data as { msg?: string }).msg ||
      `Request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

const KIE_DIRECT_STREAM_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';
// Safe threshold below Vercel Hobby's 4.5 MB Serverless Function payload limit
const SERVERLESS_SAFE_BINARY_BYTES = 4 * 1024 * 1024;
const SERVERLESS_SAFE_BASE64_CHARS = 3_800_000;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function directUploadToKieStream(
  apiKey: string,
  blob: Blob,
  fileName: string,
  uploadPath = 'kie-studio-inputs'
): Promise<{ ok: boolean; fileUrl: string; fileName: string; mimeType: string; size: number }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey.length < 10) {
    throw new Error('Add and select a valid Kie.ai API key before uploading.');
  }
  const safeName = fileName.replace(/[^\w.\-() ]+/g, '_') || 'upload.bin';
  const cleanUploadPath = uploadPath.replace(/^\/+|\/+$/g, '') || 'kie-studio-inputs';

  const form = new FormData();
  form.append('file', blob, safeName);
  form.append('uploadPath', cleanUploadPath);
  form.append('fileName', safeName);

  const res = await fetch(KIE_DIRECT_STREAM_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cleanKey}`,
    },
    body: form,
  });

  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    code?: number;
    msg?: string;
    message?: string;
    data?: { downloadUrl?: string; fileUrl?: string; mimeType?: string; fileSize?: number };
  };
  const code = json.code ?? res.status;
  const url = json.data?.downloadUrl || json.data?.fileUrl;
  if (
    res.ok &&
    json.success !== false &&
    code === 200 &&
    typeof url === 'string' &&
    /^https?:\/\/\S+/i.test(url)
  ) {
    return {
      ok: true,
      fileUrl: url.trim(),
      fileName: safeName,
      mimeType: json.data?.mimeType || blob.type || 'application/octet-stream',
      size: json.data?.fileSize ?? blob.size,
    };
  }
  const msg = json.msg || json.message || `Direct upload failed (HTTP ${res.status})`;
  throw new Error(msg);
}

function decodeBase64DataUrlToBlob(base64Data: string): Blob {
  const trimmed = base64Data.trim();
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match ? match[1].toLowerCase() : 'application/octet-stream';
  const pure = (match ? match[2] : trimmed).replace(/\s+/g, '');
  const binary = atob(pure);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function parseZipInBrowser(file: File): Promise<ZipParseResponse> {
  const JSZip = (await import('jszip')).default;
  const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
  const MAX_ENTRIES = 150;
  const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
  const MAX_TEXT_BYTES = 512 * 1024;
  const MAX_TOTAL_TEXT_CHARS = 180_000;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGES = 8;

  if (file.size === 0 || file.size > MAX_ARCHIVE_BYTES) {
    throw new Error('ZIP archive must be between 1 byte and 25 MB.');
  }
  const buf = await file.arrayBuffer();
  const sig = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (sig.length < 4 || sig[0] !== 0x50 || sig[1] !== 0x4b) {
    throw new Error('Invalid ZIP file header.');
  }

  const zip = await JSZip.loadAsync(buf);
  const entries: ZipParseResponse['entries'] = [];
  const textFiles: ZipParseResponse['textFiles'] = [];
  const images: ZipParseResponse['images'] = [];
  const warnings: string[] = [];

  const textExts = new Set([
    '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv', '.tsv',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
    '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.cs', '.php', '.html', '.css',
    '.scss', '.sql', '.sh', '.env', '.toml', '.ini', '.conf', '.log',
  ]);
  const imageExts = new Map<string, string>([
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
  ]);
  const execExts = new Set(['.exe', '.dll', '.bat', '.cmd', '.msi', '.app', '.dmg', '.so', '.dylib', '.ps1']);

  let totalUncompressed = 0;
  let totalTextChars = 0;
  let count = 0;

  for (const [rawPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (count >= MAX_ENTRIES) {
      warnings.push(`Archive exceeded ${MAX_ENTRIES} files; remaining entries skipped.`);
      break;
    }
    count++;

    const norm = rawPath.replace(/\\/g, '/');
    if (norm.startsWith('/') || norm.includes('..')) {
      entries.push({ path: rawPath, size: 0, kind: 'unsafe', status: 'skipped', reason: 'Unsafe path' });
      warnings.push(`Skipped unsafe path "${rawPath}".`);
      continue;
    }

    const dot = norm.lastIndexOf('.');
    const ext = dot >= 0 ? norm.slice(dot).toLowerCase() : '';

    if (execExts.has(ext)) {
      entries.push({ path: norm, size: 0, kind: 'executable', status: 'skipped', reason: 'Executable blocked' });
      continue;
    }

    const bytes = await entry.async('uint8array');
    totalUncompressed += bytes.byteLength;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      warnings.push('Uncompressed archive limit (40 MB) reached.');
      break;
    }

    if (imageExts.has(ext)) {
      if (images.length >= MAX_IMAGES || bytes.byteLength > MAX_IMAGE_BYTES) {
        entries.push({ path: norm, size: bytes.byteLength, kind: 'image', status: 'skipped', reason: 'Image limit exceeded' });
        continue;
      }
      const mime = imageExts.get(ext)!;
      images.push({
        path: norm,
        mimeType: mime,
        size: bytes.byteLength,
        dataUrl: `data:${mime};base64,${uint8ArrayToBase64(bytes)}`,
      });
      entries.push({ path: norm, size: bytes.byteLength, kind: 'image', status: 'parsed' });
    } else if (textExts.has(ext) || bytes.byteLength <= 64 * 1024) {
      let hasNull = false;
      for (let i = 0; i < Math.min(bytes.byteLength, 1024); i++) {
        if (bytes[i] === 0) { hasNull = true; break; }
      }
      if (hasNull) {
        entries.push({ path: norm, size: bytes.byteLength, kind: 'binary', status: 'skipped', reason: 'Binary file' });
        continue;
      }
      const slice = bytes.subarray(0, MAX_TEXT_BYTES);
      let text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
      let truncated = bytes.byteLength > MAX_TEXT_BYTES;
      if (totalTextChars + text.length > MAX_TOTAL_TEXT_CHARS) {
        const remain = Math.max(0, MAX_TOTAL_TEXT_CHARS - totalTextChars);
        text = text.slice(0, remain);
        truncated = true;
      }
      totalTextChars += text.length;
      if (text.length > 0) {
        textFiles.push({ path: norm, size: bytes.byteLength, content: text, truncated });
      }
      entries.push({ path: norm, size: bytes.byteLength, kind: 'text', status: truncated ? 'truncated' : 'parsed' });
    } else {
      entries.push({ path: norm, size: bytes.byteLength, kind: 'binary', status: 'skipped', reason: 'Binary file' });
    }
  }

  const summaryText = [
    `ZIP Archive: ${file.name} (${entries.length} entries inspected)`,
    ...textFiles.map((tf) => `\n--- FILE: ${tf.path} (${tf.size} bytes)${tf.truncated ? ' [TRUNCATED]' : ''} ---\n${tf.content}`),
  ].join('\n');

  return {
    ok: true,
    fileName: file.name,
    archiveSize: file.size,
    totalEntries: entries.length,
    entries,
    textFiles,
    images,
    summaryText,
    warnings,
  };
}

export const api = {
  // Public Live Catalog & Pricing
  getCatalog: () =>
    requestJson<{
      syncedAt: number | null;
      syncing: boolean;
      stale: boolean;
      lastError: string | null;
      docsWarning?: string | null;
      models: CatalogModel[];
    }>('/api/catalog'),

  syncCatalog: (force = false) =>
    requestJson<{
      ok: boolean;
      syncedAt: number | null;
      syncing: boolean;
      stale: boolean;
      lastError: string | null;
      docsWarning?: string | null;
      models: CatalogModel[];
    }>('/api/catalog/sync', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  getModelDetail: (id: string, category?: ModelCategory) =>
    requestJson<{ model: CatalogModel }>(
      `/api/catalog/model?id=${encodeURIComponent(id)}${category ? `&category=${encodeURIComponent(category)}` : ''}`
    ),

  calculatePricing: (
    modelId: string,
    category: ModelCategory,
    input: Record<string, unknown>,
    balance: number | null
  ) =>
    requestJson<{ cost: CostCalculationResult; affordability: AffordabilitySummary }>(
      '/api/pricing/calculate',
      {
        method: 'POST',
        body: JSON.stringify({ modelId, category, input, balance }),
      }
    ),

  // Stateless Proxy: Key Balance Verification
  verifyKey: async (
    apiKey: string
  ): Promise<{
    ok: boolean;
    status: KeyStatus;
    balance: number | null;
    error?: string;
    checkedAt: number;
  }> => {
    return requestJson('/api/proxy/verify-key', {
      method: 'POST',
      headers: {
        'X-Kie-Api-Key': apiKey.trim(),
      },
    });
  },

  // Stateless Proxy: File Upload (uses proxy <=3.8MB, direct Kie.ai stream upload >3.8MB / HTTP 413 for Vercel Hobby)
  uploadFile: async (
    apiKey: string,
    base64Data: string,
    fileName: string,
    options?: {
      allowedMimeTypes?: string[];
      maxBytes?: number;
      uploadPath?: string;
    }
  ): Promise<{
    ok: boolean;
    fileUrl: string;
    fileName?: string;
    mimeType?: string;
    size?: number;
  }> => {
    if (base64Data.length > SERVERLESS_SAFE_BASE64_CHARS) {
      const blob = decodeBase64DataUrlToBlob(base64Data);
      if (options?.maxBytes && blob.size > options.maxBytes) {
        throw new Error(
          `Image Too Large: File (${(blob.size / (1024 * 1024)).toFixed(2)} MB) exceeds the ${(options.maxBytes / (1024 * 1024)).toFixed(1)} MB limit.`
        );
      }
      return directUploadToKieStream(apiKey, blob, fileName, options?.uploadPath || 'kie-studio-inputs');
    }

    try {
      return await requestJson<{
        ok: boolean;
        fileUrl: string;
        fileName?: string;
        mimeType?: string;
        size?: number;
      }>('/api/proxy/upload', {
        method: 'POST',
        headers: {
          'X-Kie-Api-Key': apiKey.trim(),
        },
        body: JSON.stringify({
          base64Data,
          fileName,
          allowedMimeTypes: options?.allowedMimeTypes,
          maxBytes: options?.maxBytes,
          uploadPath: options?.uploadPath,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/413|payload too large|entity too large/i.test(msg)) {
        const blob = decodeBase64DataUrlToBlob(base64Data);
        return directUploadToKieStream(apiKey, blob, fileName, options?.uploadPath || 'kie-studio-inputs');
      }
      throw err;
    }
  },

  uploadMediaStreamFile: async (
    apiKey: string,
    file: File,
    options?: {
      allowedMimeTypes?: string[];
      maxBytes?: number;
      uploadPath?: string;
    }
  ): Promise<{
    ok: boolean;
    fileUrl: string;
    fileName?: string;
    mimeType?: string;
    size?: number;
  }> => {
    if (options?.maxBytes && file.size > options.maxBytes) {
      throw new Error(
        `Image Too Large: File (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds the ${(options.maxBytes / (1024 * 1024)).toFixed(1)} MB limit.`
      );
    }

    if (file.size > SERVERLESS_SAFE_BINARY_BYTES) {
      return directUploadToKieStream(apiKey, file, file.name, options?.uploadPath || 'kie-studio-inputs');
    }

    const safeName = file.name.replace(/[^\w.\-() ]+/g, '_') || 'upload.bin';
    const res = await fetch('/api/proxy/media/upload-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Device-Id': getOrCreateDeviceId(),
        'X-Kie-Api-Key': apiKey.trim(),
        'X-File-Name': safeName,
        ...(options?.allowedMimeTypes?.length
          ? { 'X-Allowed-Mimes': options.allowedMimeTypes.join(',') }
          : {}),
        ...(options?.maxBytes ? { 'X-Max-Bytes': String(options.maxBytes) } : {}),
        ...(options?.uploadPath ? { 'X-Upload-Path': options.uploadPath } : {}),
      },
      body: file,
    });
    if (res.status === 413) {
      return directUploadToKieStream(apiKey, file, file.name, options?.uploadPath || 'kie-studio-inputs');
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      fileUrl?: string;
      fileName?: string;
      mimeType?: string;
      size?: number;
      error?: string;
    };
    if (!res.ok || !data.fileUrl) {
      throw new Error(data.error || `Stream file upload failed (HTTP ${res.status})`);
    }
    return {
      ok: true,
      fileUrl: data.fileUrl,
      fileName: data.fileName || safeName,
      mimeType: data.mimeType || file.type,
      size: data.size || file.size,
    };
  },

  // Stateless Proxy: Submit Video / Image Generation
  submitMediaGeneration: async (
    apiKey: string,
    payload: {
      clientRequestId: string;
      modelId: string;
      category: 'video' | 'image';
      generationMode: string;
      input: Record<string, unknown>;
    }
  ): Promise<{
    ok: boolean;
    httpStatus: number;
    duplicate?: boolean;
    ambiguousTimeout?: boolean;
    taskId?: string;
    rawState?: string;
    status?: GenerationStatus;
    verifiedCost?: number;
    verifiedBalance?: number;
    endpointPath?: string;
    sanitizedInput?: Record<string, unknown>;
    insufficientCredits?: boolean;
    invalidKey?: boolean;
    restricted?: boolean;
    rateLimited?: boolean;
    keyStatus?: KeyStatus;
    errorCode?: string;
    error?: string;
  }> => {
    const res = await fetch('/api/proxy/media/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getOrCreateDeviceId(),
        'X-Kie-Api-Key': apiKey.trim(),
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return {
      httpStatus: res.status,
      ...(data as Record<string, unknown>),
    } as Awaited<ReturnType<typeof api.submitMediaGeneration>>;
  },

  // Stateless Proxy: Poll Media Task Status
  pollMediaTask: async (
    apiKey: string,
    taskId: string,
    category: 'video' | 'image'
  ): Promise<{
    ok: boolean;
    status?: GenerationStatus;
    rawState?: string | null;
    resultUrls?: string[];
    mediaVerified?: boolean;
    errorCode?: string | null;
    errorMessage?: string | null;
    creditsConsumed?: number | null;
    updatedBalance?: number | null;
    error?: string;
  }> => {
    const res = await fetch('/api/proxy/media/poll', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getOrCreateDeviceId(),
        'X-Kie-Api-Key': apiKey.trim(),
      },
      body: JSON.stringify({ taskId, category }),
    });
    const data = await res.json().catch(() => ({}));
    return data as Awaited<ReturnType<typeof api.pollMediaTask>>;
  },

  // Stateless Proxy: Download Verified Media (never puts key in URL)
  downloadMediaBlob: async (
    apiKey: string | undefined,
    url: string,
    filename: string
  ): Promise<void> => {
    try {
      const signedRes = await fetch('/api/proxy/media/download-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': getOrCreateDeviceId(),
          ...(apiKey ? { 'X-Kie-Api-Key': apiKey.trim() } : {}),
        },
        body: JSON.stringify({ url }),
      });

      if (signedRes.ok) {
        const signedData = (await signedRes.json().catch(() => ({}))) as {
          ok?: boolean;
          downloadUrl?: string;
        };
        if (signedData.ok && signedData.downloadUrl) {
          try {
            const directMediaRes = await fetch(signedData.downloadUrl);
            if (directMediaRes.ok) {
              const blob = await directMediaRes.blob();
              const objectUrl = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = objectUrl;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
              return;
            }
          } catch {
            // Direct anchor download avoids proxying >4.5MB video bytes when CDN disallows CORS fetch
            const a = document.createElement('a');
            a.href = signedData.downloadUrl;
            a.download = filename;
            a.rel = 'noopener noreferrer';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return;
          }
        }
      }
    } catch {
      // Fallback to proxy download below
    }

    const res = await fetch('/api/proxy/media/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getOrCreateDeviceId(),
        ...(apiKey ? { 'X-Kie-Api-Key': apiKey.trim() } : {}),
      },
      body: JSON.stringify({ url, filename }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || `Download failed (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  },

  // Stateless Proxy: Parse ZIP Archive securely (falls back to client JSZip when >4MB / HTTP 413)
  parseChatZip: async (file: File): Promise<ZipParseResponse> => {
    if (file.size > SERVERLESS_SAFE_BINARY_BYTES) {
      return parseZipInBrowser(file);
    }
    const safeName = file.name.replace(/[^\w.\-() ]+/g, '_') || 'archive.zip';
    const res = await fetch('/api/proxy/chat/parse-zip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Device-Id': getOrCreateDeviceId(),
        'X-File-Name': safeName,
      },
      body: file,
    });
    if (res.status === 413) {
      return parseZipInBrowser(file);
    }
    const data = (await res.json().catch(() => ({}))) as Partial<ZipParseResponse>;
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Failed to inspect ZIP archive (HTTP ${res.status})`);
    }
    return data as ZipParseResponse;
  },

  // Stateless Proxy: Upload Chat Image or Video (direct Kie.ai upload >4MB / HTTP 413 for Vercel Hobby)
  uploadChatMediaFile: async (
    apiKey: string,
    file: File
  ): Promise<{ fileUrl: string; mimeType: string; size: number; fileName: string }> => {
    if (file.size > SERVERLESS_SAFE_BINARY_BYTES) {
      return directUploadToKieStream(apiKey, file, file.name, 'kie-studio-chat');
    }
    const safeName = file.name.replace(/[^\w.\-() ]+/g, '_') || 'upload.bin';
    const res = await fetch('/api/proxy/chat/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Device-Id': getOrCreateDeviceId(),
        'X-Kie-Api-Key': apiKey.trim(),
        'X-File-Name': safeName,
      },
      body: file,
    });
    if (res.status === 413) {
      return directUploadToKieStream(apiKey, file, file.name, 'kie-studio-chat');
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      fileUrl?: string;
      mimeType?: string;
      size?: number;
      fileName?: string;
      error?: string;
    };
    if (!res.ok || !data.ok || !data.fileUrl) {
      throw new Error(data.error || `File upload failed (HTTP ${res.status})`);
    }
    return {
      fileUrl: data.fileUrl,
      mimeType: data.mimeType || file.type,
      size: data.size || file.size,
      fileName: data.fileName || safeName,
    };
  },

  // Stateless Proxy: Chat Send (SSE streaming + non-streaming JSON models + pre-stream balance check)
  sendChatStream: async (params: {
    apiKey: string;
    clientRequestId: string;
    modelId: string;
    messages: Array<{
      role: 'user' | 'assistant';
      content: string;
      attachments?: ChatAttachmentPayload[];
    }>;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onProcessing?: (message: string) => void;
  }): Promise<{
    ok: boolean;
    text: string;
    providerModel?: string;
    usage?: ChatTokenUsage | null;
    updatedBalance?: number | null;
    updatedKeyStatus?: KeyStatus;
    insufficientCredits?: boolean;
    invalidKey?: boolean;
    restricted?: boolean;
    rateLimited?: boolean;
    verifiedBalance?: number | null;
    keyStatus?: KeyStatus;
    error?: string;
  }> => {
    const res = await fetch('/api/proxy/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getOrCreateDeviceId(),
        'X-Kie-Api-Key': params.apiKey.trim(),
      },
      body: JSON.stringify({
        clientRequestId: params.clientRequestId,
        modelId: params.modelId,
        messages: params.messages,
        systemPrompt: params.systemPrompt,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      }),
      signal: params.signal,
    });

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('text/event-stream')) {
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        insufficientCredits?: boolean;
        invalidKey?: boolean;
        restricted?: boolean;
        rateLimited?: boolean;
        verifiedBalance?: number | null;
        keyStatus?: KeyStatus;
      };
      return {
        ok: false,
        text: '',
        insufficientCredits: json.insufficientCredits,
        invalidKey: json.invalidKey,
        restricted: json.restricted,
        rateLimited: json.rateLimited,
        verifiedBalance: json.verifiedBalance,
        keyStatus: json.keyStatus,
        error: json.error || `Chat request failed (HTTP ${res.status})`,
      };
    }

    if (!res.body) {
      return { ok: false, text: '', error: 'Empty SSE response stream.' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let fullText = '';
    interface DonePayload {
      text?: string;
      providerModel?: string;
      usage?: ChatTokenUsage | null;
      updatedBalance?: number | null;
      updatedKeyStatus?: KeyStatus;
    }
    interface StreamErrorPayload {
      error?: string;
      insufficientCredits?: boolean;
      invalidKey?: boolean;
      restricted?: boolean;
      rateLimited?: boolean;
    }
    let donePayload: DonePayload | null = null;
    let streamError: StreamErrorPayload | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          currentEvent = 'message';
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          const payloadStr = line.slice(5).trim();
          if (!payloadStr) continue;
          try {
            const data = JSON.parse(payloadStr) as Record<string, unknown>;
            if (currentEvent === 'delta' && typeof data.text === 'string') {
              fullText += data.text;
              params.onDelta(fullText);
            } else if (currentEvent === 'processing' && typeof data.message === 'string') {
              params.onProcessing?.(data.message);
            } else if (currentEvent === 'done') {
              donePayload = data as unknown as DonePayload;
            } else if (currentEvent === 'error') {
              streamError = data as unknown as StreamErrorPayload;
            }
          } catch {
            // ignore partial JSON chunks
          }
        }
      }
    }

    if (streamError) {
      return {
        ok: false,
        text: fullText,
        insufficientCredits: streamError.insufficientCredits,
        invalidKey: streamError.invalidKey,
        restricted: streamError.restricted,
        rateLimited: streamError.rateLimited,
        error: streamError.error || 'Chat stream failed.',
      };
    }

    if (donePayload) {
      return {
        ok: true,
        text: donePayload.text || fullText,
        providerModel: donePayload.providerModel,
        usage: donePayload.usage ?? null,
        updatedBalance: donePayload.updatedBalance ?? null,
        updatedKeyStatus: donePayload.updatedKeyStatus,
      };
    }

    return {
      ok: Boolean(fullText),
      text: fullText,
      error: fullText ? undefined : 'Chat stream ended unexpectedly without completion.',
    };
  },
};
