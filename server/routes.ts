import express from 'express';
import path from 'node:path';
import {
  calculateAffordability,
  calculateExactCost,
  getCatalogSummary,
  getModelById,
  syncCatalog,
} from './kieCatalog.ts';
import {
  type ChatTurnMessage,
  createKieTask,
  executeKieChatStream,
  getKieDownloadUrl,
  getKieTaskRecord,
  uploadKieBase64File,
  uploadKieStreamFile,
  verifyKieKeyBalance,
  verifyOutputMediaUrl,
} from './kieClient.ts';
import type {
  CatalogModel,
  ChatAttachmentPayload,
  GenerationStatus,
  ModelCategory,
} from './types.ts';
import {
  detectImageMimeFromBytes,
  parseZipArchiveBuffer,
  ZIP_MAX_ARCHIVE_BYTES,
} from './zipAnalyzer.ts';

export const apiRouter = express.Router();

// Short-TTL in-memory idempotency store keyed ONLY by (deviceId + clientRequestId).
// NEVER stores user API keys, prompts, or private histories.
interface IdempotencyEntry {
  state: 'in_flight' | 'done';
  expiresAt: number;
  responsePayload?: Record<string, unknown>;
}
const idempotencyCache = new Map<string, IdempotencyEntry>();
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

function pruneIdempotencyCache(): void {
  const now = Date.now();
  for (const [k, v] of idempotencyCache.entries()) {
    if (v.expiresAt <= now) {
      idempotencyCache.delete(k);
    }
  }
}

function validateAndSanitizeInput(
  model: CatalogModel,
  rawInput: Record<string, unknown>
): { ok: true; sanitized: Record<string, unknown> } | { ok: false; error: string } {
  const sanitized: Record<string, unknown> = {};

  for (const field of model.fields) {
    const val = rawInput[field.name];
    const isMissing =
      val === undefined ||
      val === null ||
      (typeof val === 'string' && val.trim() === '') ||
      (Array.isArray(val) && val.length === 0);

    if (isMissing) {
      if (field.required) {
        return { ok: false, error: `Required parameter "${field.name}" is missing.` };
      }
      continue;
    }

    if (field.type === 'string') {
      const strVal = String(val).trim();
      if (field.minLength !== undefined && strVal.length < field.minLength) {
        return {
          ok: false,
          error: `Parameter "${field.name}" must be at least ${field.minLength} characters.`,
        };
      }
      if (field.maxLength !== undefined && strVal.length > field.maxLength) {
        return {
          ok: false,
          error: `Parameter "${field.name}" cannot exceed ${field.maxLength} characters.`,
        };
      }
      const lowerField = field.name.toLowerCase();
      const isMediaUrlField =
        field.format === 'uri' ||
        ((lowerField.includes('url') ||
          lowerField.includes('image') ||
          lowerField.includes('frame') ||
          lowerField.includes('video') ||
          lowerField.includes('audio')) &&
          !lowerField.includes('task_type') &&
          !lowerField.includes('ratio') &&
          !lowerField.includes('num_') &&
          !lowerField.includes('seconds') &&
          !lowerField.includes('fps') &&
          !lowerField.includes('style') &&
          !lowerField.includes('mode') &&
          !field.enumValues?.length);

      if (isMediaUrlField) {
        if (/^data:/i.test(strVal) || (/^[A-Za-z0-9+/=]{120,}$/.test(strVal) && !/^https?:\/\//i.test(strVal))) {
          return {
            ok: false,
            error: `Parameter "${field.name}" must be an uploaded file URL (http/https), not raw Base64 data.`,
          };
        }
        const allowsAsset = (field.description || '').toLowerCase().includes('asset://');
        const validUrl =
          /^https?:\/\/\S+/i.test(strVal) || (allowsAsset && /^asset:\/\/\S+/i.test(strVal));
        if (!validUrl) {
          return { ok: false, error: `Parameter "${field.name}" must be a valid http(s) URL.` };
        }
      }
      if (field.enumValues && !field.enumValues.map(String).includes(strVal)) {
        return {
          ok: false,
          error: `Unsupported value "${strVal}" for "${field.name}". Allowed: ${field.enumValues.join(', ')}.`,
        };
      }
      sanitized[field.name] = strVal;
    } else if (field.type === 'integer' || field.type === 'number') {
      const numVal = Number(val);
      if (!Number.isFinite(numVal)) {
        return { ok: false, error: `Parameter "${field.name}" must be a valid number.` };
      }
      if (field.minimum !== undefined && numVal < field.minimum) {
        return {
          ok: false,
          error: `Parameter "${field.name}" must be at least ${field.minimum}.`,
        };
      }
      if (field.maximum !== undefined && numVal > field.maximum) {
        return {
          ok: false,
          error: `Parameter "${field.name}" cannot exceed ${field.maximum}.`,
        };
      }
      if (field.enumValues && !field.enumValues.map(Number).includes(numVal)) {
        return {
          ok: false,
          error: `Unsupported value "${numVal}" for "${field.name}". Allowed: ${field.enumValues.join(', ')}.`,
        };
      }
      sanitized[field.name] = field.type === 'integer' ? Math.round(numVal) : numVal;
    } else if (field.type === 'boolean') {
      sanitized[field.name] = Boolean(val);
    } else if (field.type === 'array') {
      if (!Array.isArray(val)) {
        return { ok: false, error: `Parameter "${field.name}" must be a list.` };
      }
      const cleaned = val
        .map((item) => (typeof item === 'string' ? item.trim() : item))
        .filter((item) => item !== '' && item !== null && item !== undefined);
      if (cleaned.length === 0) {
        if (field.required) {
          return { ok: false, error: `Required parameter "${field.name}" cannot be empty.` };
        }
        continue;
      }
      const lowerField = field.name.toLowerCase();
      const isMediaArrayUrl =
        field.format === 'uri' ||
        lowerField.includes('url') ||
        lowerField.includes('image') ||
        lowerField.includes('frame') ||
        lowerField.includes('video') ||
        lowerField.includes('audio');
      if (isMediaArrayUrl) {
        const allowsAsset = (field.description || '').toLowerCase().includes('asset://');
        for (const item of cleaned) {
          if (typeof item === 'string') {
            if (/^data:/i.test(item)) {
              return {
                ok: false,
                error: `Parameter "${field.name}" must contain uploaded http(s) URLs, not raw Base64 data.`,
              };
            }
            const okUrl =
              /^https?:\/\/\S+/i.test(item) || (allowsAsset && /^asset:\/\/\S+/i.test(item));
            if (!okUrl) {
              return {
                ok: false,
                error: `All URLs in "${field.name}" must be valid http(s) links.`,
              };
            }
          }
        }
      }
      sanitized[field.name] = cleaned;
    } else {
      sanitized[field.name] = val;
    }
  }

  return { ok: true, sanitized };
}

function getRequestApiKey(req: express.Request): string {
  const header = req.header('x-kie-api-key');
  return typeof header === 'string' ? header.trim() : '';
}

function getDeviceId(req: express.Request): string {
  const header = req.header('x-device-id');
  return typeof header === 'string' && header.trim() ? header.trim().slice(0, 64) : 'default';
}

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, statelessProxy: true, timestamp: Date.now() });
});

// --- Public Live Kie.ai Catalog & Pricing Routes ---
apiRouter.get('/catalog', async (_req, res) => {
  try {
    const summary = await getCatalogSummary();
    res.json(summary);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Unable to load Kie.ai model catalog.',
    });
  }
});

apiRouter.post('/catalog/sync', async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const result = await syncCatalog(force);
    const summary = await getCatalogSummary();
    res.status(result.ok ? 200 : 502).json({ ...result, ...summary });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to synchronize Kie.ai catalog.',
    });
  }
});

apiRouter.get('/catalog/model', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const catRaw = String(req.query.category || '').trim();
  const category: ModelCategory | undefined =
    catRaw === 'video' || catRaw === 'image' || catRaw === 'chat' ? catRaw : undefined;

  if (!id) {
    res.status(400).json({ error: 'Model id query parameter is required.' });
    return;
  }
  const model = await getModelById(id, category);
  if (!model) {
    res.status(404).json({ error: `Model "${id}" not found in Kie.ai catalog.` });
    return;
  }
  res.json({ model });
});

apiRouter.post('/pricing/calculate', async (req, res) => {
  const { modelId, category, input, balance } = req.body || {};
  const cat: ModelCategory | undefined =
    category === 'video' || category === 'image' || category === 'chat' ? category : undefined;
  const model = await getModelById(String(modelId || ''), cat);
  if (!model) {
    res.status(404).json({ error: 'Model not found in Kie.ai catalog.' });
    return;
  }
  const parsedInput =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const numericBalance = typeof balance === 'number' && Number.isFinite(balance) ? balance : null;
  const cost = calculateExactCost(model, parsedInput);
  const affordability = calculateAffordability(model, numericBalance, parsedInput);
  res.json({ cost, affordability });
});

// --- Stateless Proxy: Verify Key Balance ---
apiRouter.post('/proxy/verify-key', async (req, res) => {
  const apiKey = getRequestApiKey(req);
  if (!apiKey || apiKey.length < 10) {
    res.status(400).json({
      ok: false,
      status: 'Invalid',
      balance: null,
      error: 'A valid Kie.ai API key header (X-Kie-Api-Key) is required.',
    });
    return;
  }
  const result = await verifyKieKeyBalance(apiKey);
  res.json({
    ...result,
    checkedAt: Date.now(),
  });
});

function detectExtendedMediaMime(
  buf: Uint8Array,
  ext: string
): string | null {
  const coreImg = detectImageMimeFromBytes(buf);
  if (coreImg) return coreImg;
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    return 'image/tiff';
  }
  const vid = detectVideoMimeFromBytes(buf, ext);
  if (vid) return vid;
  // MP3 / WAV / M4A basic detection
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45
  ) {
    return 'audio/wav';
  }
  return null;
}

// --- Stateless Proxy: Upload Input Media via Kie.ai Base64 File Upload API ---
apiRouter.post('/proxy/upload', async (req, res) => {
  try {
    const apiKey = getRequestApiKey(req);
    if (!apiKey || apiKey.length < 10) {
      res.status(400).json({ ok: false, error: 'Add and select a valid Kie.ai API key before uploading.' });
      return;
    }

    const { base64Data, fileName, allowedMimeTypes, maxBytes, uploadPath } = req.body || {};
    if (typeof base64Data !== 'string' || base64Data.trim().length < 16) {
      res.status(400).json({ ok: false, error: 'Valid base64 file payload is required.' });
      return;
    }

    const trimmed = base64Data.trim();
    const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
    const declaredMime = dataUrlMatch ? dataUrlMatch[1].toLowerCase() : null;
    const pureBase64 = (dataUrlMatch ? dataUrlMatch[2] : trimmed).replace(/\s+/g, '');

    if (!pureBase64 || !/^[A-Za-z0-9+/]+=*$/.test(pureBase64)) {
      res.status(400).json({
        ok: false,
        error: 'Invalid Base64 Payload: Payload is malformed or not valid Base64.',
      });
      return;
    }

    const decoded = Buffer.from(pureBase64, 'base64');
    if (decoded.length === 0) {
      res.status(400).json({
        ok: false,
        error: 'Invalid Base64 Payload: Decoded file is empty (0 bytes).',
      });
      return;
    }

    const maxAllowedBytes =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.min(maxBytes, 30 * 1024 * 1024)
        : 15 * 1024 * 1024;
    if (decoded.length > maxAllowedBytes) {
      res.status(400).json({
        ok: false,
        error: `Image Too Large: File (${(decoded.length / (1024 * 1024)).toFixed(2)} MB) exceeds the ${(maxAllowedBytes / (1024 * 1024)).toFixed(1)} MB limit.`,
      });
      return;
    }

    const safeFileName = path.basename(String(fileName || `input_${Date.now()}.png`));
    const ext = path.extname(safeFileName).toLowerCase();
    const detectedMime = detectExtendedMediaMime(decoded, ext);

    if (Array.isArray(allowedMimeTypes) && allowedMimeTypes.length > 0) {
      const normalizedAllowed = allowedMimeTypes.map((m) => String(m).toLowerCase());
      if (!detectedMime || !normalizedAllowed.includes(detectedMime)) {
        res.status(400).json({
          ok: false,
          error: `Invalid Image Format: Detected binary format (${detectedMime || 'unrecognized'}) is not supported. Accepted: ${normalizedAllowed.join(', ')}.`,
        });
        return;
      }
    }

    const result = await uploadKieBase64File(
      apiKey,
      trimmed,
      safeFileName,
      typeof uploadPath === 'string' && uploadPath.trim() ? uploadPath.trim() : 'kie-studio-inputs'
    );
    if (!result.ok || !result.fileUrl) {
      res.status(result.httpStatus || 502).json({
        ok: false,
        error: result.error || 'Failed to upload file to Kie.ai.',
      });
      return;
    }

    res.json({
      ok: true,
      fileUrl: result.fileUrl,
      fileName: safeFileName,
      mimeType: result.mimeType || detectedMime || declaredMime || 'application/octet-stream',
      size: decoded.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Upload error.' });
  }
});

// --- Stateless Proxy: Upload Large Input Media via Kie.ai Stream Upload API (>10MB) ---
apiRouter.post(
  '/proxy/media/upload-stream',
  express.raw({ type: 'application/octet-stream', limit: '32mb' }),
  async (req, res) => {
    try {
      const apiKey = getRequestApiKey(req);
      if (!apiKey || apiKey.length < 10) {
        res.status(400).json({
          ok: false,
          error: 'Add and select a valid Kie.ai API key before uploading.',
        });
        return;
      }

      const rawName = path.basename(String(req.header('x-file-name') || `input_${Date.now()}.bin`));
      const ext = path.extname(rawName).toLowerCase();
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buffer.length === 0) {
        res.status(400).json({ ok: false, error: 'Uploaded file is empty (0 bytes).' });
        return;
      }

      const maxHdr = Number(req.header('x-max-bytes') || '');
      const maxAllowed =
        Number.isFinite(maxHdr) && maxHdr > 0 ? Math.min(maxHdr, 31 * 1024 * 1024) : 30 * 1024 * 1024;
      if (buffer.length > maxAllowed) {
        res.status(400).json({
          ok: false,
          error: `Image Too Large: File (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds the ${(maxAllowed / (1024 * 1024)).toFixed(1)} MB limit.`,
        });
        return;
      }

      const detectedMime = detectExtendedMediaMime(buffer, ext);
      const allowedHdr = String(req.header('x-allowed-mimes') || '').trim();
      if (allowedHdr) {
        const allowedList = allowedHdr
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (allowedList.length > 0 && (!detectedMime || !allowedList.includes(detectedMime))) {
          res.status(400).json({
            ok: false,
            error: `Invalid Image Format: Detected format (${detectedMime || 'unknown'}) is not supported. Accepted: ${allowedList.join(', ')}.`,
          });
          return;
        }
      }

      const uploadPath = String(req.header('x-upload-path') || 'kie-studio-inputs').trim();
      const uploadRes = await uploadKieStreamFile(
        apiKey,
        buffer,
        rawName,
        detectedMime || 'application/octet-stream',
        uploadPath
      );
      if (!uploadRes.ok || !uploadRes.fileUrl) {
        res.status(uploadRes.httpStatus || 502).json({
          ok: false,
          error: uploadRes.error || 'Kie.ai rejected the file upload.',
        });
        return;
      }

      res.json({
        ok: true,
        fileUrl: uploadRes.fileUrl,
        fileName: rawName,
        mimeType: detectedMime || 'application/octet-stream',
        size: buffer.length,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Media stream upload error.',
      });
    }
  }
);

// --- Stateless Proxy: Submit Video / Image Generation ---
apiRouter.post('/proxy/media/generate', async (req, res) => {
  pruneIdempotencyCache();
  const apiKey = getRequestApiKey(req);
  const deviceId = getDeviceId(req);

  if (!apiKey || apiKey.length < 10) {
    res.status(400).json({ ok: false, error: 'A valid Kie.ai API key is required.' });
    return;
  }

  const { clientRequestId, modelId, category, generationMode, input } = req.body || {};
  const reqId = typeof clientRequestId === 'string' ? clientRequestId.trim() : '';
  if (!reqId || reqId.length < 8) {
    res.status(400).json({
      ok: false,
      error: 'Missing unique clientRequestId for duplicate-submission protection.',
    });
    return;
  }

  const cat: ModelCategory | undefined =
    category === 'video' || category === 'image' ? category : undefined;
  if (!cat) {
    res.status(400).json({ ok: false, error: 'Category must be "video" or "image".' });
    return;
  }

  const idemKey = `${deviceId}:${reqId}`;
  const existing = idempotencyCache.get(idemKey);
  if (existing) {
    if (existing.state === 'in_flight') {
      res.status(409).json({
        ok: false,
        error: 'Duplicate generation blocked while the previous request is still in flight.',
      });
      return;
    }
    if (existing.state === 'done' && existing.responsePayload) {
      res.status(200).json({ ...existing.responsePayload, duplicate: true });
      return;
    }
  }

  // 12-point Validation
  const model = await getModelById(String(modelId || ''), cat);
  if (!model) {
    res.status(400).json({ ok: false, error: `Unknown or unverified model "${modelId}".` });
    return;
  }
  if (!model.isAvailable || model.deprecated || model.verificationStatus !== 'VERIFIED') {
    res.status(400).json({
      ok: false,
      error: model.unavailableReason || `Model "${model.title}" is currently unavailable.`,
    });
    return;
  }
  if (!model.modes.includes(String(generationMode) as never)) {
    res.status(400).json({
      ok: false,
      error: `Generation mode "${generationMode}" is not supported by "${model.title}".`,
    });
    return;
  }

  const rawInput = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const validation = validateAndSanitizeInput(model, rawInput);
  if (!validation.ok) {
    res.status(400).json({ ok: false, error: validation.error });
    return;
  }

  const cost = calculateExactCost(model, validation.sanitized);
  if (!cost.verified || cost.exactCredits === null) {
    res.status(400).json({
      ok: false,
      error: cost.reason || 'Pricing unavailable — generation temporarily disabled.',
    });
    return;
  }

  // Live pre-flight balance check
  const balRes = await verifyKieKeyBalance(apiKey);
  if (!balRes.ok || balRes.balance === null) {
    const statusCode =
      balRes.status === 'Insufficient Balance'
        ? 402
        : balRes.status === 'Invalid'
          ? 401
          : balRes.status === 'Restricted'
            ? 403
            : balRes.status === 'Rate Limited'
              ? 429
              : 502;
    res.status(statusCode).json({
      ok: false,
      insufficientCredits: balRes.status === 'Insufficient Balance',
      keyStatus: balRes.status,
      verifiedBalance: balRes.balance,
      error: balRes.error || `API key verification failed (${balRes.status}).`,
    });
    return;
  }

  if (balRes.balance < cost.exactCredits) {
    res.status(402).json({
      ok: false,
      insufficientCredits: true,
      keyStatus: 'Insufficient Balance',
      verifiedBalance: balRes.balance,
      error: `Verified balance (${balRes.balance} credits) is below required cost (${cost.exactCredits} credits).`,
    });
    return;
  }

  idempotencyCache.set(idemKey, {
    state: 'in_flight',
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });

  try {
    const payload = {
      model: model.id,
      input: validation.sanitized,
    };
    const apiRes = await createKieTask(apiKey, model.endpointPath, payload);

    if (apiRes.ok && apiRes.taskId) {
      const responsePayload = {
        ok: true,
        taskId: apiRes.taskId,
        rawState: 'waiting',
        status: 'Queued' as GenerationStatus,
        verifiedCost: cost.exactCredits,
        verifiedBalance: balRes.balance,
        endpointPath: model.endpointPath,
        sanitizedInput: validation.sanitized,
      };
      idempotencyCache.set(idemKey, {
        state: 'done',
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        responsePayload,
      });
      res.status(201).json(responsePayload);
      return;
    }

    if (apiRes.ambiguousTimeout) {
      const responsePayload = {
        ok: false,
        ambiguousTimeout: true,
        status: 'Unknown' as GenerationStatus,
        errorCode: 'TIMEOUT_AMBIGUOUS',
        error: apiRes.error,
      };
      idempotencyCache.set(idemKey, {
        state: 'done',
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        responsePayload,
      });
      res.status(504).json(responsePayload);
      return;
    }

    // Clear idempotency on deterministic pre-task rejection so user/rotation can fix or rotate
    idempotencyCache.delete(idemKey);

    res.status(apiRes.httpStatus || 502).json({
      ok: false,
      insufficientCredits: apiRes.insufficientCredits || false,
      invalidKey: apiRes.invalidKey || false,
      restricted: apiRes.restricted || false,
      rateLimited: apiRes.rateLimited || false,
      keyStatus: apiRes.insufficientCredits
        ? 'Insufficient Balance'
        : apiRes.invalidKey
          ? 'Invalid'
          : apiRes.restricted
            ? 'Restricted'
            : apiRes.rateLimited
              ? 'Rate Limited'
              : undefined,
      errorCode: String(apiRes.code || apiRes.httpStatus || 'API_ERROR'),
      error: apiRes.error || 'Kie.ai rejected the generation request.',
    });
  } catch (err) {
    idempotencyCache.delete(idemKey);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected proxy error.',
    });
  }
});

// --- Stateless Proxy: Poll Media Task Status & Verify Output URL ---
apiRouter.post('/proxy/media/poll', async (req, res) => {
  const apiKey = getRequestApiKey(req);
  const { taskId, category } = req.body || {};

  if (!apiKey || apiKey.length < 10) {
    res.status(400).json({ ok: false, error: 'API key is required to poll task status.' });
    return;
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    res.status(400).json({ ok: false, error: 'Kie.ai taskId is required.' });
    return;
  }
  const cat: 'image' | 'video' = category === 'video' ? 'video' : 'image';

  const recordRes = await getKieTaskRecord(apiKey, taskId.trim());
  if (!recordRes.ok) {
    res.status(502).json({ ok: false, error: recordRes.error || 'Failed to poll Kie.ai task.' });
    return;
  }

  const rawState = (recordRes.rawState || '').toLowerCase();
  let status: GenerationStatus = 'Unknown';
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let resultUrls: string[] = [];
  let mediaVerified = false;
  let updatedBalance: number | null = null;

  if (rawState === 'waiting' || rawState === 'queuing' || rawState === 'queued') {
    status = 'Queued';
  } else if (rawState === 'generating' || rawState === 'processing' || rawState === 'running') {
    status = 'Processing';
  } else if (rawState === 'cancel' || rawState === 'cancelled' || rawState === 'canceled') {
    status = 'Cancelled';
    errorCode = 'CANCELLED';
    errorMessage = recordRes.failMsg || 'Task was cancelled on Kie.ai.';
  } else if (rawState === 'fail' || rawState === 'failed' || rawState === 'error') {
    status = 'Failed';
    errorCode = recordRes.failCode || 'TASK_FAILED';
    errorMessage = recordRes.failMsg || 'Generation failed on Kie.ai.';
  } else if (rawState === 'success' || rawState === 'succeeded' || rawState === 'completed') {
    if (recordRes.resultUrls.length === 0) {
      status = 'Failed';
      errorCode = 'MISSING_OUTPUT_URL';
      errorMessage = 'Kie.ai reported completion, but no output URL was returned.';
    } else {
      const mediaCheck = await verifyOutputMediaUrl(recordRes.resultUrls[0], cat);
      if (!mediaCheck.accessible) {
        status = 'Failed';
        errorCode = 'UNREACHABLE_OUTPUT';
        errorMessage = mediaCheck.error || 'Returned output URL could not be retrieved.';
        resultUrls = recordRes.resultUrls;
      } else {
        status = 'Succeeded';
        resultUrls = recordRes.resultUrls;
        mediaVerified = true;
        const balRes = await verifyKieKeyBalance(apiKey);
        if (balRes.ok && balRes.balance !== null) {
          updatedBalance = balRes.balance;
        }
      }
    }
  }

  res.json({
    ok: true,
    status,
    rawState: recordRes.rawState || null,
    resultUrls,
    mediaVerified,
    errorCode,
    errorMessage,
    creditsConsumed: recordRes.creditsConsumed ?? null,
    updatedBalance,
  });
});

// --- Stateless Proxy: Resolve Signed Download URL (avoids 4.5MB serverless response cap for large videos) ---
apiRouter.post('/proxy/media/download-url', async (req, res) => {
  const apiKey = getRequestApiKey(req);
  const { url } = req.body || {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ ok: false, error: 'Valid media URL is required.' });
    return;
  }

  let resolvedUrl = url.trim();
  let isSigned = false;
  if (apiKey) {
    const dlRes = await getKieDownloadUrl(apiKey, resolvedUrl);
    if (dlRes.ok && dlRes.downloadUrl) {
      resolvedUrl = dlRes.downloadUrl;
      isSigned = true;
    }
  }

  res.json({ ok: true, downloadUrl: resolvedUrl, isSigned });
});

// --- Stateless Proxy: Verified File Download (no secret in query URL) ---
apiRouter.post('/proxy/media/download', async (req, res) => {
  const apiKey = getRequestApiKey(req);
  const { url, filename } = req.body || {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'Valid media URL is required.' });
    return;
  }

  let fetchUrl = url;
  if (apiKey) {
    const dlRes = await getKieDownloadUrl(apiKey, url);
    if (dlRes.ok && dlRes.downloadUrl) {
      fetchUrl = dlRes.downloadUrl;
    }
  }

  try {
    const mediaRes = await fetch(fetchUrl);
    if (!mediaRes.ok) {
      res.status(502).json({ error: `Failed to retrieve media from Kie.ai (HTTP ${mediaRes.status}).` });
      return;
    }
    const contentType = mediaRes.headers.get('content-type') || 'application/octet-stream';
    const safeName =
      typeof filename === 'string' && filename.trim()
        ? filename.replace(/[^a-zA-Z0-9._-]+/g, '_')
        : `kie_output_${Date.now()}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    const arrayBuffer = await mediaRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(502).json({
      error: `Media retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

function detectVideoMimeFromBytes(buf: Uint8Array, ext: string): string | null {
  if (buf.length < 12) return null;
  // MP4 / MOV: bytes 4..7 == 'ftyp'
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  }
  // WebM (EBML header: 1A 45 DF A3)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3 && ext === '.webm') {
    return 'video/webm';
  }
  return null;
}

const CHAT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const CHAT_MAX_VIDEO_BYTES = 30 * 1024 * 1024;

// --- Stateless Proxy: Parse ZIP Archive securely in-memory ---
apiRouter.post(
  '/proxy/chat/parse-zip',
  express.raw({ type: 'application/octet-stream', limit: `${Math.round(ZIP_MAX_ARCHIVE_BYTES / (1024 * 1024)) + 1}mb` }),
  async (req, res) => {
    try {
      const rawName = String(req.header('x-file-name') || 'archive.zip');
      const ext = path.extname(rawName).toLowerCase();
      if (ext !== '.zip') {
        res.status(400).json({ ok: false, error: 'Only .zip archives are accepted for ZIP parsing.' });
        return;
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const parsed = await parseZipArchiveBuffer(buffer, rawName);
      if (!parsed.ok) {
        res.status(400).json(parsed);
        return;
      }
      res.json(parsed);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to parse ZIP archive.',
      });
    }
  }
);

// --- Stateless Proxy: Upload Chat Image or Video to Kie.ai ---
apiRouter.post(
  '/proxy/chat/upload',
  express.raw({ type: 'application/octet-stream', limit: '31mb' }),
  async (req, res) => {
    try {
      const apiKey = getRequestApiKey(req);
      if (!apiKey || apiKey.length < 10) {
        res.status(400).json({
          ok: false,
          error: 'Add and select a valid Kie.ai API key before uploading attachments.',
        });
        return;
      }

      const rawName = path.basename(String(req.header('x-file-name') || 'upload.bin'));
      const ext = path.extname(rawName).toLowerCase();
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buffer.length === 0) {
        res.status(400).json({ ok: false, error: 'Uploaded file is empty (0 bytes).' });
        return;
      }

      const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
      const videoExts = new Set(['.mp4', '.mov', '.webm']);

      let verifiedMime: string | null = null;
      if (imageExts.has(ext)) {
        if (buffer.length > CHAT_MAX_IMAGE_BYTES) {
          res.status(400).json({
            ok: false,
            error: `Image "${rawName}" exceeds the 15 MB limit.`,
          });
          return;
        }
        verifiedMime = detectImageMimeFromBytes(buffer);
        if (!verifiedMime) {
          res.status(400).json({
            ok: false,
            error: `Invalid image header for "${rawName}". Supported: JPG, PNG, WEBP.`,
          });
          return;
        }
      } else if (videoExts.has(ext)) {
        if (buffer.length > CHAT_MAX_VIDEO_BYTES) {
          res.status(400).json({
            ok: false,
            error: `Video "${rawName}" exceeds the 30 MB limit.`,
          });
          return;
        }
        verifiedMime = detectVideoMimeFromBytes(buffer, ext);
        if (!verifiedMime) {
          res.status(400).json({
            ok: false,
            error: `Invalid or unrecognized video container for "${rawName}". Supported: MP4, MOV, WEBM.`,
          });
          return;
        }
      } else {
        res.status(400).json({
          ok: false,
          error: `Unsupported attachment extension "${ext || 'none'}". Supported media: JPG, PNG, WEBP, MP4, MOV, WEBM.`,
        });
        return;
      }

      const uploadRes = await uploadKieStreamFile(apiKey, buffer, rawName, verifiedMime);
      if (!uploadRes.ok || !uploadRes.fileUrl) {
        res.status(uploadRes.httpStatus || 502).json({
          ok: false,
          error: uploadRes.error || 'Kie.ai rejected the file upload.',
        });
        return;
      }

      res.json({
        ok: true,
        fileUrl: uploadRes.fileUrl,
        mimeType: verifiedMime,
        size: buffer.length,
        fileName: rawName,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Chat attachment upload error.',
      });
    }
  }
);

// --- Stateless Proxy: Real Chat Generation (SSE stream + non-streaming JSON models) ---
apiRouter.post('/proxy/chat/send', async (req, res) => {
  pruneIdempotencyCache();
  const apiKey = getRequestApiKey(req);
  const deviceId = getDeviceId(req);

  if (!apiKey || apiKey.length < 10) {
    res.status(400).json({ ok: false, error: 'A valid Kie.ai API key is required.' });
    return;
  }

  const { clientRequestId, modelId, messages, systemPrompt, temperature, maxTokens } =
    req.body || {};

  const reqId = typeof clientRequestId === 'string' ? clientRequestId.trim() : '';
  if (!reqId || reqId.length < 8) {
    res.status(400).json({ ok: false, error: 'Missing unique clientRequestId.' });
    return;
  }

  const model = await getModelById(String(modelId || ''), 'chat');
  if (!model) {
    res.status(404).json({
      ok: false,
      error: `Unknown chat model "${modelId}" (not found in verified Kie.ai catalog).`,
    });
    return;
  }
  if (
    !model.isAvailable ||
    model.deprecated ||
    !model.pricingVerified ||
    model.verificationStatus !== 'VERIFIED' ||
    !model.chatProtocol
  ) {
    res.status(400).json({
      ok: false,
      error: model.unavailableReason || `Chat model "${model.title}" is currently unavailable.`,
    });
    return;
  }

  const msgList: ChatTurnMessage[] = Array.isArray(messages)
    ? messages
        .filter(
          (m): m is ChatTurnMessage =>
            Boolean(m) &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            (m.content.trim().length > 0 || (Array.isArray(m.attachments) && m.attachments.length > 0))
        )
        .map((m) => ({
          role: m.role,
          content: m.content.trim() || 'Please analyze the attached file(s).',
          attachments: Array.isArray(m.attachments)
            ? (m.attachments as ChatAttachmentPayload[])
            : undefined,
        }))
    : [];

  if (msgList.length === 0) {
    res.status(400).json({ ok: false, error: 'At least one non-empty message or attachment is required.' });
    return;
  }

  // Validate attachments on the latest user turn against model capabilities (NEVER swap model silently)
  const caps = model.chatCapabilities;
  const lastTurn = msgList[msgList.length - 1];
  if (lastTurn.role === 'user' && lastTurn.attachments && lastTurn.attachments.length > 0) {
    let mediaCount = 0;
    for (const att of lastTurn.attachments) {
      if (att.kind === 'video') {
        if (!caps?.supportsVideoInput) {
          res.status(400).json({
            ok: false,
            error: `Selected model "${model.title}" (${model.id}) does not support direct video input. Select a Gemini OpenAI model for native video or use extracted visual frames.`,
          });
          return;
        }
        mediaCount += 1;
      } else if (att.kind === 'image' || att.kind === 'video-frames') {
        if (!caps?.supportsImageInput) {
          res.status(400).json({
            ok: false,
            error: `Selected model "${model.title}" (${model.id}) does not support image input. Please select a verified vision model (OpenAI, Gemini, Grok, DeepSeek, or Kimi).`,
          });
          return;
        }
        mediaCount += att.kind === 'video-frames' ? att.frameImages?.length || 0 : 1;
      } else if (att.kind === 'zip') {
        const innerImages = att.frameImages?.length || 0;
        const hasTextSummary = Boolean(att.zipSummary && att.zipSummary.trim().length > 0);
        if (innerImages > 0 && !caps?.supportsImageInput) {
          // Strip incompatible inner images if text files exist, or reject if ZIP only had images
          if (!hasTextSummary) {
            res.status(400).json({
              ok: false,
              error: `ZIP "${att.name}" only contains images, and "${model.title}" does not support image input.`,
            });
            return;
          }
          att.frameImages = [];
        }
        mediaCount += att.frameImages?.length || 0;
      }
    }
    const maxFiles = caps?.maxFilesPerMessage ?? 10;
    if (mediaCount > maxFiles) {
      res.status(400).json({
        ok: false,
        error: `Too many media items attached (${mediaCount}). "${model.title}" supports at most ${maxFiles} media files per message.`,
      });
      return;
    }
  }

  const idemKey = `${deviceId}:chat:${reqId}`;
  const existing = idempotencyCache.get(idemKey);
  if (existing?.state === 'in_flight') {
    res.status(409).json({
      ok: false,
      error: 'Duplicate chat request blocked while previous message is in progress.',
    });
    return;
  }

  // Live balance check before opening SSE stream (allows automatic rotation if insufficient)
  const balRes = await verifyKieKeyBalance(apiKey);
  if (!balRes.ok || balRes.balance === null || balRes.balance <= 0) {
    const isInsufficient =
      balRes.status === 'Insufficient Balance' ||
      (balRes.balance !== null && balRes.balance <= 0);
    const statusCode = isInsufficient
      ? 402
      : balRes.status === 'Invalid'
        ? 401
        : balRes.status === 'Restricted'
          ? 403
          : balRes.status === 'Rate Limited'
            ? 429
            : 502;
    res.status(statusCode).json({
      ok: false,
      insufficientCredits: isInsufficient,
      keyStatus: isInsufficient ? 'Insufficient Balance' : balRes.status,
      verifiedBalance: balRes.balance,
      error:
        balRes.error ||
        (isInsufficient
          ? 'API key balance is 0 credits.'
          : `API key verification failed (${balRes.status}).`),
    });
    return;
  }

  idempotencyCache.set(idemKey, {
    state: 'in_flight',
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });

  // Open SSE stream to client
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  const writeSse = (event: string, data: Record<string, unknown>) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const supportsStreaming = model.supportsStreaming !== false;
    if (!supportsStreaming) {
      writeSse('processing', {
        message: `Processing non-streaming response from ${model.title}...`,
      });
    }

    const result = await executeKieChatStream({
      apiKey,
      modelId: model.id,
      endpointPath: model.endpointPath,
      protocol: model.chatProtocol,
      messages: msgList,
      systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : undefined,
      temperature: typeof temperature === 'number' ? temperature : undefined,
      maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
      supportsStreaming,
      signal: abortController.signal,
      onDelta: (delta) => {
        writeSse('delta', { text: delta });
      },
    });

    if (!result.ok) {
      idempotencyCache.delete(idemKey);
      writeSse('error', {
        error: result.error || 'Chat generation failed.',
        insufficientCredits: result.insufficientCredits || false,
        invalidKey: result.invalidKey || false,
        restricted: result.restricted || false,
        rateLimited: result.rateLimited || false,
      });
      res.end();
      return;
    }

    // Compute exact credit cost ONLY when provider returned real token usage
    let finalUsage = result.usage;
    if (finalUsage && model.chatPricing) {
      const p = model.chatPricing;
      const hasTokens =
        finalUsage.inputTokens !== null || finalUsage.outputTokens !== null;
      if (hasTokens && p.inputCreditsPerMillion !== null && p.outputCreditsPerMillion !== null) {
        const cachedIn = finalUsage.cachedTokens ?? 0;
        const nonCachedIn = Math.max(0, (finalUsage.inputTokens ?? 0) - cachedIn);
        const reasoningTok = finalUsage.reasoningTokens ?? 0;
        const outTok = finalUsage.outputTokens ?? 0;

        let calc =
          (nonCachedIn * p.inputCreditsPerMillion) / 1_000_000 +
          (outTok * p.outputCreditsPerMillion) / 1_000_000;
        if (cachedIn > 0 && p.cachedInputCreditsPerMillion !== null) {
          calc += (cachedIn * p.cachedInputCreditsPerMillion) / 1_000_000;
        } else if (cachedIn > 0) {
          calc += (cachedIn * p.inputCreditsPerMillion) / 1_000_000;
        }
        if (reasoningTok > 0 && p.reasoningCreditsPerMillion !== null) {
          calc += (reasoningTok * p.reasoningCreditsPerMillion) / 1_000_000;
        }
        finalUsage = {
          ...finalUsage,
          calculatedCredits: Number(calc.toFixed(6)),
        };
      }
    }

    // Refresh real key balance post-response
    const postBal = await verifyKieKeyBalance(apiKey);

    idempotencyCache.set(idemKey, {
      state: 'done',
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });

    writeSse('done', {
      text: result.text,
      providerModel: result.providerModel || model.id,
      usage: finalUsage,
      updatedBalance: postBal.ok ? postBal.balance : null,
      updatedKeyStatus: postBal.status,
    });
    res.end();
  } catch (err) {
    idempotencyCache.delete(idemKey);
    writeSse('error', {
      error: err instanceof Error ? err.message : 'Unexpected chat stream failure.',
    });
    res.end();
  }
});
