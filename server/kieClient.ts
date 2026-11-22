import type {
  ChatAttachmentPayload,
  ChatProtocol,
  ChatTokenUsage,
  KeyStatus,
} from './types.ts';

const KIE_API_BASE = 'https://api.kie.ai';
const KIE_UPLOAD_STREAM_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';

export interface CreditVerificationResult {
  ok: boolean;
  status: KeyStatus;
  balance: number | null;
  error?: string;
}

export interface CreateTaskResponse {
  ok: boolean;
  ambiguousTimeout?: boolean;
  httpStatus?: number;
  code?: number;
  taskId?: string;
  error?: string;
  insufficientCredits?: boolean;
  invalidKey?: boolean;
  restricted?: boolean;
  rateLimited?: boolean;
}

export interface TaskRecordResult {
  ok: boolean;
  httpStatus?: number;
  code?: number;
  rawState?: string;
  resultUrls: string[];
  failCode?: string | null;
  failMsg?: string | null;
  creditsConsumed?: number | null;
  error?: string;
}

export interface MediaVerificationResult {
  accessible: boolean;
  contentType?: string;
  contentLength?: number | null;
  error?: string;
}

export interface ChatTurnMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: ChatAttachmentPayload[];
}

export interface ChatStreamResult {
  ok: boolean;
  httpStatus?: number;
  text: string;
  usage: ChatTokenUsage | null;
  providerModel?: string;
  insufficientCredits?: boolean;
  invalidKey?: boolean;
  restricted?: boolean;
  rateLimited?: boolean;
  error?: string;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 20000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyKieKeyBalance(apiKey: string): Promise<CreditVerificationResult> {
  try {
    const res = await fetchWithTimeout(
      `${KIE_API_BASE}/api/v1/chat/credit`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: 'application/json',
        },
      },
      12000
    );

    const text = await res.text();
    let json: { code?: number; msg?: string; data?: unknown } = {};
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: 'Balance Unavailable',
        balance: null,
        error: `Unexpected non-JSON response from Kie.ai (HTTP ${res.status}).`,
      };
    }

    const code = json.code ?? res.status;
    if (res.status === 401 || code === 401) {
      return {
        ok: false,
        status: 'Invalid',
        balance: null,
        error: json.msg || 'Invalid API key (401 Unauthorized).',
      };
    }
    if (res.status === 403 || code === 403) {
      return {
        ok: false,
        status: 'Restricted',
        balance: null,
        error: json.msg || 'API key is restricted or lacks permissions (403 Forbidden).',
      };
    }
    if (res.status === 402 || code === 402) {
      return {
        ok: false,
        status: 'Insufficient Balance',
        balance: 0,
        error: json.msg || 'Account credits exhausted (402).',
      };
    }
    if (res.status === 429 || code === 429) {
      return {
        ok: false,
        status: 'Rate Limited',
        balance: null,
        error: json.msg || 'Kie.ai rate limit exceeded (429).',
      };
    }
    if (res.ok && code === 200 && json.data !== undefined && json.data !== null) {
      const balance = Number(json.data);
      if (!Number.isFinite(balance)) {
        return {
          ok: false,
          status: 'Balance Unavailable',
          balance: null,
          error: 'Kie.ai returned a non-numeric credit balance.',
        };
      }
      return {
        ok: true,
        status: balance > 0 ? 'Valid' : 'Insufficient Balance',
        balance,
      };
    }

    return {
      ok: false,
      status: 'Balance Unavailable',
      balance: null,
      error: json.msg || `Kie.ai returned status code ${code}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return {
      ok: false,
      status: 'Balance Unavailable',
      balance: null,
      error: `Failed to reach Kie.ai credit endpoint: ${message}`,
    };
  }
}

export async function createKieTask(
  apiKey: string,
  endpointPath: string,
  payload: Record<string, unknown>
): Promise<CreateTaskResponse> {
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const url = `${KIE_API_BASE}${cleanPath}`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
      30000
    );

    const text = await res.text();
    let json: { code?: number; msg?: string; message?: string; data?: { taskId?: string } } = {};
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        error: `Kie.ai returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
      };
    }

    const code = json.code ?? res.status;
    const msg = json.msg || json.message || `Kie.ai error code ${code}`;

    if (res.status === 401 || code === 401) {
      return { ok: false, httpStatus: res.status, code, invalidKey: true, error: msg };
    }
    if (res.status === 403 || code === 403) {
      return { ok: false, httpStatus: res.status, code, restricted: true, error: msg };
    }
    if (res.status === 402 || code === 402 || /insufficient|credit|balance/i.test(msg)) {
      return { ok: false, httpStatus: res.status, code, insufficientCredits: true, error: msg };
    }
    if (res.status === 429 || code === 429) {
      return { ok: false, httpStatus: res.status, code, rateLimited: true, error: msg };
    }

    if (res.ok && code === 200 && json.data?.taskId) {
      return {
        ok: true,
        httpStatus: res.status,
        code,
        taskId: String(json.data.taskId),
      };
    }

    return {
      ok: false,
      httpStatus: res.status,
      code,
      error: msg,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      ambiguousTimeout: isAbort,
      error: isAbort
        ? 'Request timed out waiting for Kie.ai response. Do not resubmit until verifying task status.'
        : `Network error contacting Kie.ai: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function getKieTaskRecord(apiKey: string, taskId: string): Promise<TaskRecordResult> {
  const url = `${KIE_API_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: 'application/json',
        },
      },
      15000
    );

    const text = await res.text();
    let json: {
      code?: number;
      msg?: string;
      data?: {
        taskId?: string;
        state?: string;
        resultJson?: string | null;
        failCode?: string | null;
        failMsg?: string | null;
        creditsConsumed?: number | null;
        info?: { resultUrls?: string[] };
        response?: { resultUrls?: string[] };
      };
    } = {};

    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        resultUrls: [],
        error: `Non-JSON response from Kie.ai recordInfo (HTTP ${res.status})`,
      };
    }

    const code = json.code ?? res.status;
    if (!res.ok || code !== 200 || !json.data) {
      return {
        ok: false,
        httpStatus: res.status,
        code,
        resultUrls: [],
        error: json.msg || `Failed to query Kie.ai task status (code ${code})`,
      };
    }

    const data = json.data;
    const resultUrls: string[] = [];

    if (typeof data.resultJson === 'string' && data.resultJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(data.resultJson) as {
          resultUrls?: unknown[];
          images?: unknown[];
          videos?: unknown[];
          url?: string;
        };
        const candidates = [
          ...(Array.isArray(parsed.resultUrls) ? parsed.resultUrls : []),
          ...(Array.isArray(parsed.images) ? parsed.images : []),
          ...(Array.isArray(parsed.videos) ? parsed.videos : []),
          ...(typeof parsed.url === 'string' ? [parsed.url] : []),
        ];
        for (const item of candidates) {
          if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
            resultUrls.push(item);
          } else if (
            item &&
            typeof item === 'object' &&
            'url' in item &&
            typeof (item as { url: unknown }).url === 'string'
          ) {
            resultUrls.push((item as { url: string }).url);
          }
        }
      } catch {
        // Keep empty resultUrls; caller treats missing/malformed resultJson on success as error
      }
    }

    if (Array.isArray(data.info?.resultUrls)) {
      for (const u of data.info.resultUrls) {
        if (typeof u === 'string' && /^https?:\/\//i.test(u) && !resultUrls.includes(u)) {
          resultUrls.push(u);
        }
      }
    }
    if (Array.isArray(data.response?.resultUrls)) {
      for (const u of data.response.resultUrls) {
        if (typeof u === 'string' && /^https?:\/\//i.test(u) && !resultUrls.includes(u)) {
          resultUrls.push(u);
        }
      }
    }

    return {
      ok: true,
      httpStatus: res.status,
      code,
      rawState: data.state,
      resultUrls,
      failCode: data.failCode ?? null,
      failMsg: data.failMsg ?? null,
      creditsConsumed:
        typeof data.creditsConsumed === 'number' && Number.isFinite(data.creditsConsumed)
          ? data.creditsConsumed
          : null,
    };
  } catch (err) {
    return {
      ok: false,
      resultUrls: [],
      error: `Failed to poll Kie.ai task: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function verifyOutputMediaUrl(
  url: string,
  expectedCategory: 'image' | 'video'
): Promise<MediaVerificationResult> {
  if (!/^https?:\/\//i.test(url)) {
    return { accessible: false, error: 'Output URL is missing or invalid.' };
  }
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, 12000);
    if (res.status === 405 || res.status === 403 || !res.ok) {
      res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: { Range: 'bytes=0-1023' },
          redirect: 'follow',
        },
        12000
      );
    }
    if (!res.ok) {
      return {
        accessible: false,
        error: `Output URL returned HTTP ${res.status}.`,
      };
    }
    const contentType = res.headers.get('content-type') || '';
    const lenHeader = res.headers.get('content-length');
    const contentLength = lenHeader ? Number(lenHeader) : null;

    if (
      contentType &&
      !contentType.startsWith(expectedCategory) &&
      !contentType.includes('octet-stream')
    ) {
      return {
        accessible: false,
        contentType,
        contentLength,
        error: `Output URL returned unexpected content-type "${contentType}" instead of ${expectedCategory}.`,
      };
    }
    return {
      accessible: true,
      contentType,
      contentLength,
    };
  } catch (err) {
    return {
      accessible: false,
      error: `Failed to verify output media URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const KIE_FILE_UPLOAD_BASE = 'https://kieai.redpandaai.co';

export async function uploadKieBase64File(
  apiKey: string,
  base64Data: string,
  fileName: string,
  uploadPath = 'kie-studio-inputs'
): Promise<{
  ok: boolean;
  httpStatus?: number;
  fileUrl?: string;
  mimeType?: string;
  fileSize?: number;
  error?: string;
}> {
  try {
    const cleanUploadPath = uploadPath.replace(/^\/+|\/+$/g, '') || 'kie-studio-inputs';
    const res = await fetchWithTimeout(
      `${KIE_FILE_UPLOAD_BASE}/api/file-base64-upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          base64Data,
          uploadPath: cleanUploadPath,
          fileName,
        }),
      },
      45000
    );

    const raw = await res.text();
    let json: {
      success?: boolean;
      code?: number;
      msg?: string;
      message?: string;
      data?: {
        downloadUrl?: string;
        fileUrl?: string;
        mimeType?: string;
        fileSize?: number;
      };
    } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        error: `Kie.ai Base64 upload returned non-JSON response (HTTP ${res.status}).`,
      };
    }

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
        httpStatus: res.status,
        fileUrl: url.trim(),
        mimeType: json.data?.mimeType,
        fileSize: json.data?.fileSize,
      };
    }

    const msg = json.msg || json.message || `Kie.ai Base64 file upload failed (code ${code})`;
    if (res.status === 401 || code === 401) {
      return {
        ok: false,
        httpStatus: 401,
        error: `Authentication failed during upload (401): ${msg}`,
      };
    }
    if (res.status === 403 || code === 403) {
      return {
        ok: false,
        httpStatus: 403,
        error: `Upload forbidden (403): ${msg}`,
      };
    }
    if (res.status === 429 || code === 429) {
      return {
        ok: false,
        httpStatus: 429,
        error: `Upload rate limited (429): ${msg}`,
      };
    }
    return {
      ok: false,
      httpStatus: res.status >= 400 ? res.status : code >= 400 ? code : 502,
      error: url
        ? msg
        : `${msg} (Kie.ai did not return a download URL.)`,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 502,
      error: `Failed to upload file to Kie.ai: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export async function uploadKieStreamFile(
  apiKey: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  uploadPath = 'kie-studio-chat'
): Promise<{ ok: boolean; httpStatus?: number; fileUrl?: string; error?: string }> {
  try {
    const cleanUploadPath = uploadPath.replace(/^\/+|\/+$/g, '') || 'kie-studio-inputs';
    const form = new FormData();
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(buffer);
    const blob = new Blob([copy], { type: mimeType || 'application/octet-stream' });
    form.append('file', blob, fileName);
    form.append('uploadPath', cleanUploadPath);
    form.append('fileName', fileName);

    const res = await fetchWithTimeout(
      KIE_UPLOAD_STREAM_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: form,
      },
      60000
    );

    const raw = await res.text();
    let json: {
      success?: boolean;
      code?: number;
      msg?: string;
      message?: string;
      data?: { downloadUrl?: string; fileUrl?: string };
    } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        error: `Kie.ai upload returned non-JSON response (HTTP ${res.status}).`,
      };
    }

    const code = json.code ?? res.status;
    const url = json.data?.downloadUrl || json.data?.fileUrl;
    if (
      res.ok &&
      json.success !== false &&
      code === 200 &&
      typeof url === 'string' &&
      /^https?:\/\/\S+/i.test(url)
    ) {
      return { ok: true, httpStatus: res.status, fileUrl: url.trim() };
    }

    const msg = json.msg || json.message || `File upload failed (HTTP ${res.status})`;
    if (res.status === 401 || code === 401) {
      return { ok: false, httpStatus: 401, error: `API key rejected during upload (401): ${msg}` };
    }
    if (res.status === 403 || code === 403) {
      return { ok: false, httpStatus: 403, error: `Upload forbidden (403): ${msg}` };
    }
    return {
      ok: false,
      httpStatus: res.status >= 400 ? res.status : code >= 400 ? code : 502,
      error: msg,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 502,
      error: `Failed to upload file stream to Kie.ai: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export async function getKieDownloadUrl(
  apiKey: string,
  url: string
): Promise<{ ok: boolean; downloadUrl?: string; error?: string }> {
  try {
    const res = await fetchWithTimeout(
      `${KIE_API_BASE}/api/v1/common/download-url`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      },
      12000
    );
    const json = (await res.json()) as { code?: number; msg?: string; data?: string };
    if (res.ok && json.code === 200 && typeof json.data === 'string' && json.data.startsWith('http')) {
      return { ok: true, downloadUrl: json.data };
    }
    return { ok: false, error: json.msg || `Download link unavailable (HTTP ${res.status})` };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to request Kie.ai download URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function mergeUsage(prev: ChatTokenUsage | null, next: Partial<ChatTokenUsage>): ChatTokenUsage {
  const base: ChatTokenUsage = prev || {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    creditsConsumed: null,
    calculatedCredits: null,
  };
  return {
    inputTokens: next.inputTokens ?? base.inputTokens,
    outputTokens: next.outputTokens ?? base.outputTokens,
    cachedTokens: next.cachedTokens ?? base.cachedTokens,
    reasoningTokens: next.reasoningTokens ?? base.reasoningTokens,
    totalTokens: next.totalTokens ?? base.totalTokens,
    creditsConsumed: next.creditsConsumed ?? base.creditsConsumed,
    calculatedCredits: next.calculatedCredits ?? base.calculatedCredits,
  };
}

function extractUsageFromObject(obj: Record<string, unknown>): Partial<ChatTokenUsage> | null {
  const creditsRaw =
    typeof obj.credits_consumed === 'number'
      ? obj.credits_consumed
      : typeof obj.creditsConsumed === 'number'
        ? obj.creditsConsumed
        : null;

  const usageObj =
    (obj.usage as Record<string, unknown> | undefined) ||
    (obj.usageMetadata as Record<string, unknown> | undefined) ||
    ((obj.response as Record<string, unknown> | undefined)?.usage as
      | Record<string, unknown>
      | undefined);

  if (!usageObj && creditsRaw === null) return null;

  const inputTokens =
    typeof usageObj?.input_tokens === 'number'
      ? usageObj.input_tokens
      : typeof usageObj?.prompt_tokens === 'number'
        ? usageObj.prompt_tokens
        : typeof usageObj?.promptTokenCount === 'number'
          ? usageObj.promptTokenCount
          : null;

  const outputTokens =
    typeof usageObj?.output_tokens === 'number'
      ? usageObj.output_tokens
      : typeof usageObj?.completion_tokens === 'number'
        ? usageObj.completion_tokens
        : typeof usageObj?.candidatesTokenCount === 'number'
          ? usageObj.candidatesTokenCount
          : null;

  const inputDetails = usageObj?.input_tokens_details as Record<string, unknown> | undefined;
  const promptDetails = usageObj?.prompt_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usageObj?.output_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = usageObj?.completion_tokens_details as
    | Record<string, unknown>
    | undefined;

  const cachedTokens =
    typeof usageObj?.cache_read_input_tokens === 'number'
      ? usageObj.cache_read_input_tokens
      : typeof usageObj?.cachedContentTokenCount === 'number'
        ? usageObj.cachedContentTokenCount
        : typeof inputDetails?.cached_tokens === 'number'
          ? inputDetails.cached_tokens
          : typeof promptDetails?.cached_tokens === 'number'
            ? promptDetails.cached_tokens
            : null;

  const reasoningTokens =
    typeof outputDetails?.reasoning_tokens === 'number'
      ? outputDetails.reasoning_tokens
      : typeof completionDetails?.reasoning_tokens === 'number'
        ? completionDetails.reasoning_tokens
        : typeof usageObj?.thoughtsTokenCount === 'number'
          ? usageObj.thoughtsTokenCount
          : null;

  const totalTokens =
    typeof usageObj?.total_tokens === 'number'
      ? usageObj.total_tokens
      : typeof usageObj?.totalTokenCount === 'number'
        ? usageObj.totalTokenCount
        : inputTokens !== null && outputTokens !== null
          ? inputTokens + outputTokens
          : null;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    totalTokens,
    creditsConsumed: creditsRaw,
  };
}

function formatChatHttpError(status: number, modelId: string, rawMsg: string): string {
  const detail = rawMsg ? ` Details: ${rawMsg}` : '';
  if (status === 401) {
    return `API key rejected by Kie.ai (HTTP 401 Unauthorized). Verify your key in API Key Manager.${detail}`;
  }
  if (status === 402) {
    return `Insufficient Kie.ai credits (HTTP 402 Payment Required).${detail}`;
  }
  if (status === 403) {
    return `Access forbidden for Chat model "${modelId}" (HTTP 403 Forbidden). Your API key may lack Chat endpoint permissions or account access.${detail}`;
  }
  if (status === 404) {
    return `Chat model or endpoint not found on Kie.ai (HTTP 404 Not Found) for "${modelId}". The model may be retired or unavailable.${detail}`;
  }
  if (status === 429) {
    return `Kie.ai rate limit exceeded (HTTP 429 Too Many Requests). Wait briefly or rotate to another API key.${detail}`;
  }
  if (status >= 500) {
    return `Kie.ai upstream service error (HTTP ${status}).${detail}`;
  }
  return rawMsg || `Kie.ai chat error (HTTP ${status}).`;
}

function extractMessageMediaAndText(msg: ChatTurnMessage): {
  text: string;
  mediaItems: Array<{
    url?: string;
    dataUrl?: string;
    mimeType: string;
    label: string;
  }>;
} {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (attachments.length === 0) {
    return { text: msg.content, mediaItems: [] };
  }

  const extraTextParts: string[] = [];
  const mediaItems: Array<{
    url?: string;
    dataUrl?: string;
    mimeType: string;
    label: string;
  }> = [];

  for (const att of attachments) {
    if (att.kind === 'zip') {
      if (att.zipSummary) {
        extraTextParts.push(att.zipSummary);
      } else {
        extraTextParts.push(`[Previously attached ZIP archive: ${att.name}]`);
      }
      for (const img of att.frameImages || []) {
        if (img.remoteUrl || img.dataUrl) {
          mediaItems.push({
            url: img.remoteUrl,
            dataUrl: img.dataUrl,
            mimeType: img.mimeType || 'image/png',
            label: img.label || att.name,
          });
        }
      }
    } else if (att.kind === 'video-frames') {
      const frames = att.frameImages || [];
      if (frames.length > 0) {
        const labels = frames.map((f) => f.label).join(', ');
        extraTextParts.push(
          `[VIDEO ANALYZED AS VISUAL FRAMES ONLY — NO AUDIO TRACK: ${att.name} (${frames.length} extracted frames: ${labels}). Answer strictly based on visible visual frames and explicitly note that audio/speech cannot be heard.]`
        );
        for (const f of frames) {
          if (f.remoteUrl || f.dataUrl) {
            mediaItems.push({
              url: f.remoteUrl,
              dataUrl: f.dataUrl,
              mimeType: f.mimeType || 'image/jpeg',
              label: `${att.name} (${f.label})`,
            });
          }
        }
      } else {
        extraTextParts.push(`[Previously attached video frames: ${att.name}]`);
      }
    } else if (att.kind === 'image' || att.kind === 'video') {
      if (att.remoteUrl || att.dataUrl) {
        mediaItems.push({
          url: att.remoteUrl,
          dataUrl: att.dataUrl,
          mimeType: att.mimeType,
          label: att.name,
        });
      } else {
        extraTextParts.push(`[Previously attached ${att.kind}: ${att.name}]`);
      }
    }
  }

  const combinedText =
    extraTextParts.length > 0
      ? `${msg.content}\n\n${extraTextParts.join('\n\n')}`
      : msg.content;

  return { text: combinedText, mediaItems };
}

function parseDataUrlParts(dataUrl: string): { mimeType: string; base64: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

export function buildChatRequestPayload(params: {
  modelId: string;
  protocol: ChatProtocol;
  messages: ChatTurnMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  supportsStreaming?: boolean;
}): { overridePath?: string; pathSuffix: string; body: Record<string, unknown> } {
  const {
    modelId,
    protocol,
    messages,
    systemPrompt,
    temperature,
    maxTokens,
    supportsStreaming = true,
  } = params;
  const cleanMsgs = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

  if (protocol === 'openai-responses') {
    const body: Record<string, unknown> = {
      model: modelId,
      input: cleanMsgs.map((m) => {
        if (m.role === 'assistant') {
          return { role: 'assistant', content: m.content };
        }
        const { text, mediaItems } = extractMessageMediaAndText(m);
        if (mediaItems.length === 0) {
          return { role: 'user', content: text };
        }
        const contentParts: Array<Record<string, unknown>> = [
          { type: 'input_text', text },
          ...mediaItems
            .map((item) => {
              const imgUrl = item.url || item.dataUrl;
              return imgUrl ? { type: 'input_image', image_url: imgUrl } : null;
            })
            .filter((x): x is { type: string; image_url: string } => x !== null),
        ];
        return { role: 'user', content: contentParts };
      }),
      stream: supportsStreaming,
    };
    if (systemPrompt?.trim()) body.instructions = systemPrompt.trim();
    if (typeof temperature === 'number' && Number.isFinite(temperature)) {
      body.temperature = temperature;
    }
    if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
      body.max_output_tokens = maxTokens;
    }
    return { pathSuffix: '', body };
  }

  if (protocol === 'anthropic-messages') {
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens:
        typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
          ? maxTokens
          : 4096,
      messages: cleanMsgs.map((m) => {
        const { text } = extractMessageMediaAndText(m);
        return {
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: text,
        };
      }),
      stream: supportsStreaming,
    };
    if (systemPrompt?.trim()) body.system = systemPrompt.trim();
    if (typeof temperature === 'number' && Number.isFinite(temperature)) {
      body.temperature = temperature;
    }
    return { pathSuffix: '', body };
  }

  if (protocol === 'gemini-native') {
    const body: Record<string, unknown> = {
      contents: cleanMsgs.map((m) => {
        if (m.role === 'assistant') {
          return { role: 'model', parts: [{ text: m.content }] };
        }
        const { text, mediaItems } = extractMessageMediaAndText(m);
        const parts: Array<Record<string, unknown>> = [{ text }];
        for (const item of mediaItems) {
          if (item.dataUrl) {
            const parsed = parseDataUrlParts(item.dataUrl);
            if (parsed) {
              parts.push({
                inline_data: {
                  mime_type: parsed.mimeType,
                  data: parsed.base64,
                },
              });
              continue;
            }
          }
          if (item.url) {
            parts.push({
              file_data: {
                mime_type: item.mimeType,
                file_uri: item.url,
              },
            });
          }
        }
        return { role: 'user', parts };
      }),
    };
    if (systemPrompt?.trim()) {
      body.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
    }
    const genConfig: Record<string, unknown> = {};
    if (typeof temperature === 'number' && Number.isFinite(temperature)) {
      genConfig.temperature = temperature;
    }
    if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
      genConfig.maxOutputTokens = maxTokens;
    }
    if (Object.keys(genConfig).length > 0) {
      body.generationConfig = genConfig;
    }
    if (!supportsStreaming) {
      return {
        overridePath: `/gemini/v1/models/${encodeURIComponent(modelId)}:generateContent`,
        pathSuffix: '',
        body,
      };
    }
    return { pathSuffix: '?alt=sse', body };
  }

  // Default: openai-completions (supports Unified Media File Format on Gemini OpenAI endpoints & image_url on GPT-5.2)
  const fullMsgs = [
    ...(systemPrompt?.trim() ? [{ role: 'system', content: systemPrompt.trim() }] : []),
    ...cleanMsgs.map((m) => {
      if (m.role === 'assistant') {
        return { role: 'assistant', content: m.content };
      }
      const { text, mediaItems } = extractMessageMediaAndText(m);
      if (mediaItems.length === 0) {
        return { role: 'user', content: text };
      }
      const parts: Array<Record<string, unknown>> = [
        { type: 'text', text },
        ...mediaItems
          .map((item) => {
            const mediaUrl = item.url || item.dataUrl;
            return mediaUrl
              ? { type: 'image_url', image_url: { url: mediaUrl } }
              : null;
          })
          .filter((x): x is { type: string; image_url: { url: string } } => x !== null),
      ];
      return { role: 'user', content: parts };
    }),
  ];
  const body: Record<string, unknown> = {
    model: modelId,
    messages: fullMsgs,
    stream: supportsStreaming,
  };
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    body.temperature = temperature;
  }
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }
  return { pathSuffix: '', body };
}

export async function executeKieChatStream(params: {
  apiKey: string;
  modelId: string;
  endpointPath: string;
  protocol: ChatProtocol;
  messages: ChatTurnMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  supportsStreaming?: boolean;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<ChatStreamResult> {
  const { apiKey, modelId, endpointPath, supportsStreaming = true, onDelta, signal } = params;
  const { overridePath, pathSuffix, body } = buildChatRequestPayload(params);
  const chosenPath = overridePath || endpointPath;
  const cleanPath = chosenPath.startsWith('/') ? chosenPath : `/${chosenPath}`;
  const url = `${KIE_API_BASE}${cleanPath}${cleanPath.includes('?') ? '' : pathSuffix}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        Accept: supportsStreaming ? 'text/event-stream, application/json' : 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let parsedErr: {
        error?: { message?: string } | string;
        msg?: string;
        message?: string;
        code?: number;
      } = {};
      try {
        parsedErr = JSON.parse(errText);
      } catch {
        // non-JSON error
      }
      const nestedErrMsg =
        parsedErr.error && typeof parsedErr.error === 'object'
          ? parsedErr.error.message
          : typeof parsedErr.error === 'string'
            ? parsedErr.error
            : undefined;
      const rawMsg =
        nestedErrMsg ||
        parsedErr.msg ||
        parsedErr.message ||
        errText.slice(0, 240).trim();

      const code = parsedErr.code ?? res.status;
      const effectiveStatus = code === 401 || code === 402 || code === 403 || code === 404 || code === 429 ? code : res.status;
      const formattedMsg = formatChatHttpError(effectiveStatus, modelId, rawMsg);

      return {
        ok: false,
        httpStatus: effectiveStatus,
        text: '',
        usage: null,
        invalidKey: res.status === 401 || code === 401,
        restricted: res.status === 403 || code === 403,
        insufficientCredits:
          res.status === 402 || code === 402 || /insufficient|credit|balance/i.test(rawMsg),
        rateLimited: res.status === 429 || code === 429,
        error: formattedMsg,
      };
    }

    const contentType = res.headers.get('content-type') || '';

    // Non-streaming JSON fallback if provider responds with JSON directly
    if (contentType.includes('application/json') || !supportsStreaming) {
      const rawJsonText = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(rawJsonText);
      } catch {
        return {
          ok: false,
          httpStatus: res.status,
          text: '',
          usage: null,
          error: 'Kie.ai returned malformed JSON response.',
        };
      }

      // Check for enveloped Kie error { code: 402/500, msg: "..." }
      if (typeof json.code === 'number' && json.code !== 200) {
        const msg = String(json.msg || json.message || `Kie.ai error code ${json.code}`);
        return {
          ok: false,
          httpStatus: res.status,
          text: '',
          usage: null,
          invalidKey: json.code === 401,
          restricted: json.code === 403,
          insufficientCredits: json.code === 402 || /insufficient|credit|balance/i.test(msg),
          rateLimited: json.code === 429,
          error: msg,
        };
      }

      let outText = '';
      if (Array.isArray(json.choices)) {
        const c0 = json.choices[0] as { message?: { content?: string }; text?: string } | undefined;
        outText = c0?.message?.content || c0?.text || '';
      } else if (Array.isArray(json.output)) {
        for (const item of json.output as Array<{
          content?: Array<{ text?: string }>;
        }>) {
          for (const part of item.content || []) {
            if (typeof part.text === 'string') outText += part.text;
          }
        }
      } else if (Array.isArray(json.content)) {
        for (const block of json.content as Array<{ text?: string }>) {
          if (typeof block.text === 'string') outText += block.text;
        }
      } else if (Array.isArray(json.candidates)) {
        const c0 = json.candidates[0] as {
          content?: { parts?: Array<{ text?: string }> };
        };
        for (const part of c0?.content?.parts || []) {
          if (typeof part.text === 'string') outText += part.text;
        }
      }

      if (outText) onDelta(outText);
      const usagePatch = extractUsageFromObject(json);
      return {
        ok: Boolean(outText),
        httpStatus: res.status,
        text: outText,
        usage: usagePatch ? mergeUsage(null, usagePatch) : null,
        providerModel: typeof json.model === 'string' ? json.model : undefined,
        error: outText ? undefined : 'Kie.ai returned an empty response body.',
      };
    }

    // Stream SSE chunks
    if (!res.body) {
      return {
        ok: false,
        httpStatus: res.status,
        text: '',
        usage: null,
        error: 'Kie.ai returned an empty stream body.',
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let usage: ChatTokenUsage | null = null;
    let providerModel: string | undefined;
    let currentEventName = '';

    const handleParsedEvent = (evt: Record<string, unknown>) => {
      if (typeof evt.model === 'string') providerModel = evt.model;
      const evtResponse = evt.response as Record<string, unknown> | undefined;
      if (evtResponse && typeof evtResponse.model === 'string') {
        providerModel = evtResponse.model;
      }

      // Check error events in stream
      if (evt.type === 'error' || evt.error) {
        const errObj = evt.error as { message?: string } | string | undefined;
        const msg =
          typeof errObj === 'object' && errObj?.message
            ? errObj.message
            : typeof errObj === 'string'
              ? errObj
              : String(evt.message || 'Streaming error from Kie.ai');
        throw new Error(msg);
      }

      // 1. OpenAI Responses API events
      if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        fullText += evt.delta;
        onDelta(evt.delta);
      } else if (
        evt.type === 'response.completed' &&
        evtResponse
      ) {
        const u = extractUsageFromObject(evtResponse);
        if (u) usage = mergeUsage(usage, u);
      }

      // 2. Anthropic Messages API events
      if (
        (currentEventName === 'content_block_delta' || evt.type === 'content_block_delta') &&
        evt.delta &&
        typeof evt.delta === 'object'
      ) {
        const deltaObj = evt.delta as { type?: string; text?: string };
        if (typeof deltaObj.text === 'string') {
          fullText += deltaObj.text;
          onDelta(deltaObj.text);
        }
      }
      if (evt.message && typeof evt.message === 'object') {
        const u = extractUsageFromObject(evt.message as Record<string, unknown>);
        if (u) usage = mergeUsage(usage, u);
      }

      // 3. OpenAI Chat Completions events
      if (Array.isArray(evt.choices)) {
        const c0 = evt.choices[0] as
          | { delta?: { content?: string }; message?: { content?: string } }
          | undefined;
        const chunkText = c0?.delta?.content ?? c0?.message?.content;
        if (typeof chunkText === 'string' && chunkText.length > 0) {
          fullText += chunkText;
          onDelta(chunkText);
        }
      }

      // 4. Gemini Native streamGenerateContent chunks
      if (Array.isArray(evt.candidates)) {
        const c0 = evt.candidates[0] as
          | { content?: { parts?: Array<{ text?: string; thought?: boolean }> } }
          | undefined;
        for (const part of c0?.content?.parts || []) {
          if (typeof part.text === 'string' && !part.thought) {
            fullText += part.text;
            onDelta(part.text);
          }
        }
      }

      // Always check top-level usage / usageMetadata / credits_consumed
      const directUsage = extractUsageFromObject(evt);
      if (directUsage) {
        usage = mergeUsage(usage, directUsage);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          currentEventName = '';
          continue;
        }
        if (line.startsWith('event:')) {
          currentEventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          const payloadStr = line.slice(5).trim();
          if (payloadStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payloadStr) as Record<string, unknown>;
            handleParsedEvent(parsed);
          } catch (err) {
            if (err instanceof Error && !err.message.includes('JSON')) {
              throw err;
            }
          }
        }
      }
    }

    if (!fullText) {
      return {
        ok: false,
        httpStatus: res.status,
        text: '',
        usage,
        error: 'Kie.ai completed the stream without returning assistant text.',
      };
    }

    return {
      ok: true,
      httpStatus: res.status,
      text: fullText,
      usage,
      providerModel,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      text: '',
      usage: null,
      error: isAbort
        ? 'Chat request timed out or was cancelled.'
        : `Chat request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
