import { load as loadYaml } from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.ts';
import type {
  AffordabilityOption,
  AffordabilitySummary,
  CatalogModel,
  ChatCapabilities,
  ChatProtocol,
  ChatTokenPricing,
  CostCalculationResult,
  GenerationMode,
  ModelCategory,
  ModelInputField,
  PricingRuleRow,
  VerificationBadge,
} from './types.ts';

const DOCS_LLMS_URL = 'https://docs.kie.ai/llms.txt';
const MODEL_PATHS_URL = 'https://api.kie.ai/api/v1/playground/model-paths';
const PRICING_PAGE_URL = 'https://api.kie.ai/client/v1/model-pricing/page';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(CURRENT_DIR, 'verifiedCatalogRegistry.json');

const DOCS_FETCH_HEADERS: Record<string, string> = {
  Accept: 'text/markdown, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (compatible; KieStudio/2.0; +https://kie.ai)',
};

export interface DocEntry {
  category: ModelCategory;
  provider: string;
  title: string;
  docUrl: string;
}

export interface ParsedSpec {
  endpointPath: string;
  modelId: string | null;
  description: string;
  fields: ModelInputField[];
  hasPost: boolean;
  deprecated: boolean;
  supportsStreaming: boolean;
  contextWindow: number | null;
}

interface VerifiedRegistryFile {
  generatedAt: number;
  docEntries: DocEntry[];
  specs: Record<string, ParsedSpec>;
}

interface CatalogState {
  syncedAt: number | null;
  syncing: boolean;
  lastError: string | null;
  docsWarning: string | null;
  modelPaths: string[];
  pricingRows: PricingRuleRow[];
  docEntries: DocEntry[];
  models: CatalogModel[];
}

const state: CatalogState = {
  syncedAt: null,
  syncing: false,
  lastError: null,
  docsWarning: null,
  modelPaths: [],
  pricingRows: [],
  docEntries: [],
  models: [],
};

let inflightSyncPromise: Promise<{
  ok: boolean;
  syncedAt: number | null;
  totalModels: number;
  error?: string;
}> | null = null;

function formatHttpSourceError(sourceName: string, status: number): string {
  if (status === 403) {
    return `${sourceName} returned HTTP 403 Forbidden (access blocked)`;
  }
  if (status === 404) {
    return `${sourceName} returned HTTP 404 Not Found`;
  }
  if (status === 429) {
    return `${sourceName} returned HTTP 429 Rate Limited`;
  }
  return `${sourceName} returned HTTP ${status}`;
}

function loadVerifiedRegistry(): VerifiedRegistryFile | null {
  try {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(new URL('./verifiedCatalogRegistry.json', import.meta.url), 'utf8');
    } catch {
      const candidatePaths = [
        REGISTRY_PATH,
        path.resolve(process.cwd(), 'server', 'verifiedCatalogRegistry.json'),
      ];
      const resolvedPath = candidatePaths.find((p) => fs.existsSync(p));
      if (resolvedPath) {
        raw = fs.readFileSync(resolvedPath, 'utf8');
      }
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VerifiedRegistryFile;
    if (!Array.isArray(parsed.docEntries) || !parsed.specs || typeof parsed.specs !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function hydrateMissingSpecsFromRegistry(registry: VerifiedRegistryFile | null): void {
  if (!registry) return;
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO model_specs (doc_url, model_id, category, title, spec_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const entryMap = new Map<string, DocEntry>(registry.docEntries.map((e) => [e.docUrl, e]));
  const tx = db.transaction(() => {
    for (const [docUrl, spec] of Object.entries(registry.specs)) {
      const entry = entryMap.get(docUrl);
      insertStmt.run(
        docUrl,
        spec.modelId,
        entry?.category || 'chat',
        entry?.title || spec.modelId || docUrl,
        JSON.stringify(spec),
        registry.generatedAt || Date.now()
      );
    }
  });
  tx();
}

function inferModes(
  title: string,
  modelId: string,
  category: ModelCategory,
  fields: ModelInputField[]
): GenerationMode[] {
  if (category === 'chat') {
    return ['Chat'];
  }

  const hay = `${title} ${modelId}`.toLowerCase();
  const fieldNames = new Set(fields.map((f) => f.name.toLowerCase()));
  const modes: GenerationMode[] = [];

  if (category === 'image') {
    if (hay.includes('upscale')) modes.push('Image-Upscale');
    if (hay.includes('inpaint')) modes.push('Inpainting');
    if (hay.includes('outpaint')) modes.push('Outpainting');
    if (hay.includes('edit') || hay.includes('remove-background') || hay.includes('segment')) {
      modes.push('Image-Edit');
    }
    if (
      hay.includes('image-to-image') ||
      hay.includes('image to image') ||
      hay.includes('remix') ||
      hay.includes('character')
    ) {
      modes.push('Image-to-Image');
    }
    if (hay.includes('text-to-image') || hay.includes('text to image') || modes.length === 0) {
      if (
        !hay.includes('image-to-image') &&
        !hay.includes('upscale') &&
        !hay.includes('remove-background')
      ) {
        modes.push('Text-to-Image');
      }
    }
    if (
      (fieldNames.has('image_urls') ||
        fieldNames.has('image_url') ||
        fieldNames.has('input_image') ||
        fieldNames.has('image_input')) &&
      !modes.includes('Image-to-Image') &&
      !modes.includes('Image-Edit') &&
      !modes.includes('Image-Upscale')
    ) {
      modes.push('Image-to-Image');
    }
    if (modes.length === 0) modes.push('Text-to-Image');
    return modes;
  }

  // Video modes
  if (hay.includes('upscale')) modes.push('Video-Upscale');
  if (hay.includes('extend')) modes.push('Video-Extend');
  if (
    hay.includes('avatar') ||
    hay.includes('lip-sync') ||
    hay.includes('omnihuman') ||
    hay.includes('infinitalk')
  ) {
    modes.push('Avatar / Lip-Sync');
  }
  if (
    hay.includes('reference-to-video') ||
    hay.includes('reference to video') ||
    hay.includes('r2v') ||
    hay.includes('fusion')
  ) {
    modes.push('Reference-to-Video');
  }
  if (
    hay.includes('video-to-video') ||
    hay.includes('video to video') ||
    hay.includes('video-edit') ||
    hay.includes('motion-control')
  ) {
    modes.push('Video-to-Video');
  }
  if (
    hay.includes('image-to-video') ||
    hay.includes('image to video') ||
    hay.includes('keyframe') ||
    hay.includes('transition')
  ) {
    modes.push('Image-to-Video');
  }
  if (hay.includes('text-to-video') || hay.includes('text to video')) {
    modes.push('Text-to-Video');
  }

  if (modes.length === 0) {
    if (
      fieldNames.has('image_urls') ||
      fieldNames.has('image_url') ||
      fieldNames.has('first_frame_image')
    ) {
      modes.push('Text-to-Video', 'Image-to-Video');
    } else {
      modes.push('Text-to-Video');
    }
  }
  if (hay.includes('veo') || hay.includes('seedance-2')) {
    if (!modes.includes('Text-to-Video')) modes.push('Text-to-Video');
    if (!modes.includes('Image-to-Video')) modes.push('Image-to-Video');
    if (!modes.includes('Reference-to-Video')) modes.push('Reference-to-Video');
  }

  return Array.from(new Set(modes));
}

function normalizeProvider(raw: string, modelId?: string, title?: string): string {
  const cleaned = raw.trim();
  const hay = `${cleaned} ${modelId || ''} ${title || ''}`.toLowerCase();
  if (cleaned.toLowerCase() === 'chat' || cleaned.toLowerCase() === 'openai' || hay.includes('gpt-')) {
    return 'OpenAI';
  }
  if (cleaned.toLowerCase() === 'claude' || hay.includes('claude')) {
    return 'Anthropic';
  }
  if (cleaned.toLowerCase() === 'gemini' || hay.includes('gemini')) {
    return 'Google';
  }
  if (cleaned.toLowerCase() === 'grok' || hay.includes('grok')) {
    return 'xAI';
  }
  if (cleaned.toLowerCase() === 'deepseek' || hay.includes('deepseek')) {
    return 'DeepSeek';
  }
  if (cleaned.toLowerCase() === 'kimi' || hay.includes('kimi')) {
    return 'Moonshot';
  }
  return cleaned || 'Kie.ai';
}

function parsellmsEntries(txt: string): DocEntry[] {
  const entries: DocEntry[] = [];
  const seenUrls = new Set<string>();
  for (const rawLine of txt.split('\n')) {
    const line = rawLine.trim();
    if (
      !line ||
      line.includes('/cn/') ||
      line.includes('/old-model/') ||
      line.includes('-callbacks.md') ||
      line.includes('/integration.md') ||
      line.includes('claude-code-integration.md') ||
      line.includes('codex/gpt-codex.md')
    ) {
      continue;
    }

    const isImage = /Image\s+Models/i.test(line);
    const isVideo = /Video\s+Models/i.test(line);
    const isChat = /Chat\s+Models/i.test(line);
    if (!isImage && !isVideo && !isChat) continue;

    // Exclude read-only helper docs
    if (
      line.includes('get-veo-3-1080-p-video') ||
      line.includes('get-veo-3-4k-video') ||
      line.includes('gemini-omni-audio') ||
      line.includes('human-identification') ||
      line.includes('subject-detection') ||
      line.includes('segment-map')
    ) {
      continue;
    }

    const linkMatch = line.match(/\[([^\]]+)\]\((https:\/\/docs\.kie\.ai\/[^)]+\.md)\)/);
    if (!linkMatch) continue;
    const title = linkMatch[1].trim();
    const docUrl = linkMatch[2].trim();
    if (seenUrls.has(docUrl)) continue;
    seenUrls.add(docUrl);

    let rawProvider = 'Kie.ai';
    const parts = line.split('>');
    if (parts.length >= 2) {
      const afterArrow = parts[1].split('[')[0].trim();
      if (afterArrow) rawProvider = afterArrow;
    }

    const category: ModelCategory = isChat ? 'chat' : isImage ? 'image' : 'video';
    const provider =
      category === 'chat' ? normalizeProvider(rawProvider, docUrl, title) : rawProvider;

    entries.push({
      category,
      provider,
      title,
      docUrl,
    });
  }
  return entries;
}

function normalizeSchemaField(
  name: string,
  rawProp: Record<string, unknown>,
  requiredSet: Set<string>
): ModelInputField {
  const typeRaw = String(rawProp.type || 'string').toLowerCase();
  const type =
    typeRaw === 'integer' ||
    typeRaw === 'number' ||
    typeRaw === 'boolean' ||
    typeRaw === 'array' ||
    typeRaw === 'object'
      ? typeRaw
      : 'string';

  const enumValues = Array.isArray(rawProp.enum)
    ? (rawProp.enum as Array<string | number | boolean>)
    : undefined;
  const items =
    rawProp.items && typeof rawProp.items === 'object'
      ? (rawProp.items as Record<string, unknown>)
      : undefined;
  const examples = Array.isArray(rawProp.examples) ? rawProp.examples[0] : rawProp.example;

  return {
    name,
    type,
    itemType: items?.type ? String(items.type) : undefined,
    required: requiredSet.has(name),
    description:
      typeof rawProp.description === 'string'
        ? rawProp.description.replace(/\s+/g, ' ').trim()
        : '',
    enumValues,
    defaultValue: rawProp.default,
    minimum: typeof rawProp.minimum === 'number' ? rawProp.minimum : undefined,
    maximum: typeof rawProp.maximum === 'number' ? rawProp.maximum : undefined,
    minLength: typeof rawProp.minLength === 'number' ? rawProp.minLength : undefined,
    maxLength: typeof rawProp.maxLength === 'number' ? rawProp.maxLength : undefined,
    format: typeof rawProp.format === 'string' ? rawProp.format : undefined,
    example: examples,
  };
}

function parseContextWindow(description: string): number | null {
  if (!description) return null;
  // Matches e.g. "Context window: 272K tokens", "1M-token context window", "128K context"
  const mMillion = description.match(/(?:context\s*window[:\s]*|with\s+a\s+\*{0,2})(\d+(?:\.\d+)?)\s*M(?:-token|\s*tokens|\s*context)/i);
  if (mMillion) {
    const val = Number(mMillion[1]);
    if (Number.isFinite(val) && val > 0) return Math.round(val * 1_000_000);
  }
  const mThousand = description.match(/(?:context\s*window[:\s]*|with\s+a\s+\*{0,2})(\d+(?:\.\d+)?)\s*K(?:-token|\s*tokens|\s*context)/i);
  if (mThousand) {
    const val = Number(mThousand[1]);
    if (Number.isFinite(val) && val > 0) return Math.round(val * 1_000);
  }
  const mPlain = description.match(/context\s*window[:\s]*(\d[\d,]*)\s*tokens/i);
  if (mPlain) {
    const val = Number(mPlain[1].replace(/,/g, ''));
    if (Number.isFinite(val) && val > 0) return val;
  }
  return null;
}

function extractPathModelId(endpointPath: string): string | null {
  // e.g. /gemini/v1/models/gemini-4-carbon:streamGenerateContent -> gemini-4-carbon
  const geminiMatch = endpointPath.match(/\/gemini\/v1\/models\/([^/:]+)/i);
  if (geminiMatch) return geminiMatch[1];

  // e.g. /gpt-5-2/v1/chat/completions or /gemini-3.1-pro/v1/chat/completions
  const completionsMatch = endpointPath.match(/^\/([^/]+)\/v1\/chat\/completions$/i);
  if (completionsMatch) return completionsMatch[1];

  return null;
}

function extractOpenApiSpec(md: string, docUrl?: string): ParsedSpec | null {
  const yamlMatch = md.match(/```yaml\s*([\s\S]*?)```/i);
  if (!yamlMatch) return null;

  let doc: Record<string, unknown>;
  try {
    doc = loadYaml(yamlMatch[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths || typeof paths !== 'object') return null;

  let endpointPath = '/api/v1/jobs/createTask';
  let postOp: Record<string, unknown> | null = null;

  // Prefer streaming / primary generation POST path if multiple exist
  const entries = Object.entries(paths);
  for (const [p, methods] of entries) {
    if (methods && typeof methods === 'object' && 'post' in methods && methods.post) {
      endpointPath = p;
      postOp = methods.post as Record<string, unknown>;
      if (p.includes('streamGenerateContent') || p.includes('createTask')) {
        break;
      }
    }
  }
  if (!postOp) {
    return {
      endpointPath,
      modelId: null,
      description: '',
      fields: [],
      hasPost: false,
      deprecated: false,
      supportsStreaming: false,
      contextWindow: null,
    };
  }

  const deprecated = Boolean(postOp.deprecated);
  const description = typeof postOp.description === 'string' ? postOp.description : '';
  const requestBody = postOp.requestBody as Record<string, unknown> | undefined;
  const content = requestBody?.content as Record<string, unknown> | undefined;
  const appJson = content?.['application/json'] as Record<string, unknown> | undefined;
  const schema = appJson?.schema as Record<string, unknown> | undefined;
  const topProps = schema?.properties as Record<string, Record<string, unknown>> | undefined;

  let modelId: string | null = null;
  if (topProps?.model) {
    if (Array.isArray(topProps.model.enum) && topProps.model.enum.length > 0) {
      modelId = String(topProps.model.enum[0]);
    } else if (typeof topProps.model.default === 'string') {
      modelId = topProps.model.default;
    } else if (typeof topProps.model.example === 'string') {
      modelId = topProps.model.example;
    } else if (Array.isArray(topProps.model.examples) && topProps.model.examples.length > 0) {
      modelId = String(topProps.model.examples[0]);
    }
  }

  if (!modelId) {
    modelId = extractPathModelId(endpointPath);
  }
  if (!modelId && docUrl) {
    const urlSlug = (docUrl.split('/').pop() || '').replace(/\.md$/i, '');
    if (urlSlug && md.includes(`"model": "${urlSlug}"`)) {
      modelId = urlSlug;
    }
  }
  if (!modelId && description) {
    const codeMatch = description.match(/<code>model<\/code>\s+set\s+to\s+(?:one\s+of\s+)?<code>([a-z0-9._-]+)<\/code>/i);
    if (codeMatch) {
      modelId = codeMatch[1];
    }
  }
  if (!modelId && typeof postOp.operationId === 'string') {
    modelId = postOp.operationId;
  }

  const inputSchema = topProps?.input as Record<string, unknown> | undefined;
  const inputProps = (inputSchema?.properties || topProps) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const requiredArr = Array.isArray(inputSchema?.required)
    ? inputSchema.required.map(String)
    : Array.isArray(schema?.required)
      ? schema.required.map(String)
      : [];
  const requiredSet = new Set(requiredArr);

  const fields: ModelInputField[] = [];
  if (inputProps && typeof inputProps === 'object') {
    for (const [k, prop] of Object.entries(inputProps)) {
      if (!inputSchema && (k === 'model' || k === 'callBackUrl')) continue;
      if (!prop || typeof prop !== 'object') continue;
      fields.push(normalizeSchemaField(k, prop, requiredSet));
    }
  }

  const supportsStreaming = Boolean(
    topProps?.stream ||
      endpointPath.includes('streamGenerateContent') ||
      /(?:"stream"|stream)\s*:\s*true|text\/event-stream|###\s*Streaming\s+Support/i.test(
        `${description}\n${md}`
      )
  );

  return {
    endpointPath,
    modelId,
    description,
    fields,
    hasPost: true,
    deprecated,
    supportsStreaming,
    contextWindow: parseContextWindow(description),
  };
}

function inferChatProtocol(endpointPath: string): ChatProtocol | undefined {
  const p = endpointPath.toLowerCase();
  if (p.includes('/claude/v1/messages')) return 'anthropic-messages';
  if (p.includes('/gemini/v1/models/')) return 'gemini-native';
  if (p.includes('/v1/responses')) return 'openai-responses';
  if (p.includes('/v1/chat/completions')) return 'openai-completions';
  return undefined;
}

function inferChatCapabilities(
  modelId: string,
  protocol: ChatProtocol | undefined,
  description: string
): ChatCapabilities {
  const idLow = modelId.toLowerCase();
  const descLow = description.toLowerCase();

  // Anthropic Claude endpoints on Kie.ai only document text/tool messages (no multimodal image/video schema documented)
  if (protocol === 'anthropic-messages') {
    return {
      supportsImageInput: false,
      supportsVideoInput: false,
      supportsFileInput: false,
      supportsZipAnalysis: true,
      maxFilesPerMessage: 1,
    };
  }

  // Gemini OpenAI-compatible endpoints explicitly document "Text, image, video, audio, and PDF input"
  if (protocol === 'openai-completions' && idLow.includes('gemini')) {
    return {
      supportsImageInput: true,
      supportsVideoInput: true,
      supportsFileInput: true,
      supportsZipAnalysis: true,
      maxFilesPerMessage: 10,
    };
  }

  // Gemini native endpoints explicitly document inline_data / file_data up to 10 files (images)
  if (protocol === 'gemini-native') {
    return {
      supportsImageInput: true,
      supportsVideoInput: false,
      supportsFileInput: false,
      supportsZipAnalysis: true,
      maxFilesPerMessage: 10,
    };
  }

  // GPT-5.2 (/v1/chat/completions) explicitly documents "only images are supported"
  if (protocol === 'openai-completions') {
    return {
      supportsImageInput: true,
      supportsVideoInput: false,
      supportsFileInput: false,
      supportsZipAnalysis: true,
      maxFilesPerMessage: 10,
    };
  }

  // OpenAI Responses API (/codex/v1/responses, /grok/v1/responses, /openai/v1/responses)
  // GPT & Grok document both input_image & input_file; DeepSeek & Kimi document input_image only
  const supportsFileInput =
    descLow.includes('input_file') || idLow.startsWith('gpt-') || idLow.startsWith('grok-');

  return {
    supportsImageInput: true,
    supportsVideoInput: false,
    supportsFileInput,
    supportsZipAnalysis: true,
    maxFilesPerMessage: 10,
  };
}

function extractSupportedParams(fields: ModelInputField[]): {
  resolutions: string[];
  aspectRatios: string[];
  durations: number[];
  minDuration?: number;
  maxDuration?: number;
  outputCounts: number[];
  supportsAudioToggle: boolean;
} {
  const resolutions: string[] = [];
  const aspectRatios: string[] = [];
  const durations: number[] = [];
  let minDuration: number | undefined;
  let maxDuration: number | undefined;
  const outputCounts: number[] = [];
  let supportsAudioToggle = false;

  for (const f of fields) {
    const n = f.name.toLowerCase();

    if (n === 'resolution' || n === 'quality' || n === 'image_size' || n === 'size') {
      if (f.enumValues) {
        for (const v of f.enumValues) {
          const s = String(v);
          if (!resolutions.includes(s)) resolutions.push(s);
        }
      } else if (f.defaultValue !== undefined) {
        const s = String(f.defaultValue);
        if (!resolutions.includes(s)) resolutions.push(s);
      }
    }

    if (n === 'aspect_ratio' || n === 'size') {
      if (f.enumValues) {
        for (const v of f.enumValues) {
          const s = String(v);
          if (/^\d+:\d+$/.test(s) || s.toLowerCase() === 'auto') {
            if (!aspectRatios.includes(s)) aspectRatios.push(s);
          }
        }
      }
    }

    if (n === 'duration' || n === 'seconds' || n === 'n_frames') {
      if (f.enumValues) {
        for (const v of f.enumValues) {
          const num = parseFloat(String(v).replace(/s$/i, ''));
          if (Number.isFinite(num) && num > 0 && !durations.includes(num)) {
            durations.push(num);
          }
        }
      }
      if (typeof f.minimum === 'number') minDuration = f.minimum;
      if (typeof f.maximum === 'number') maxDuration = f.maximum;

      if (durations.length === 0 && f.description) {
        const rangeMatch = f.description.match(/(\d+)\s*(?:to|-|–)\s*(\d+)\s*seconds?/i);
        if (rangeMatch) {
          minDuration = minDuration ?? Number(rangeMatch[1]);
          maxDuration = maxDuration ?? Number(rangeMatch[2]);
        }
      }
      if (durations.length === 0 && typeof minDuration === 'number' && typeof maxDuration === 'number') {
        const candidates = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30];
        for (const c of candidates) {
          if (c >= minDuration && c <= maxDuration && !durations.includes(c)) {
            durations.push(c);
          }
        }
        if (!durations.includes(minDuration)) durations.unshift(minDuration);
        if (!durations.includes(maxDuration)) durations.push(maxDuration);
      }
      if (durations.length === 0 && f.defaultValue !== undefined) {
        const num = parseFloat(String(f.defaultValue).replace(/s$/i, ''));
        if (Number.isFinite(num) && num > 0) durations.push(num);
      }
    }

    if (n === 'n' || n === 'num_images' || n === 'image_count' || n === 'num_outputs' || n === 'batch_size') {
      if (f.enumValues) {
        for (const v of f.enumValues) {
          const num = Number(v);
          if (Number.isFinite(num) && num > 0 && !outputCounts.includes(num)) outputCounts.push(num);
        }
      } else if (typeof f.minimum === 'number' && typeof f.maximum === 'number') {
        for (let i = Math.max(1, f.minimum); i <= Math.min(8, f.maximum); i++) {
          outputCounts.push(i);
        }
      }
    }

    if (
      n === 'sound' ||
      n === 'generate_audio' ||
      n === 'enable_audio' ||
      n === 'audio' ||
      n === 'with_audio'
    ) {
      supportsAudioToggle = true;
    }
  }

  durations.sort((a, b) => a - b);
  if (durations.length > 0) {
    minDuration = minDuration ?? durations[0];
    maxDuration = maxDuration ?? durations[durations.length - 1];
  }

  if (outputCounts.length === 0) {
    outputCounts.push(1);
  }
  outputCounts.sort((a, b) => a - b);

  return {
    resolutions,
    aspectRatios,
    durations,
    minDuration,
    maxDuration,
    outputCounts,
    supportsAudioToggle,
  };
}

function parseModelFromAnchor(anchor: string): string | null {
  try {
    const u = new URL(anchor);
    const m = u.searchParams.get('model');
    return m ? m.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function parseSlugFromAnchor(anchor: string): string {
  try {
    return new URL(anchor).pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/-openai$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function matchPricingRows(
  modelId: string,
  title: string,
  category: ModelCategory,
  allPricingRows: PricingRuleRow[]
): PricingRuleRow[] {
  const idLower = modelId.toLowerCase();
  const candidates = allPricingRows.filter((r) => r.interfaceType.toLowerCase() === category);

  // 1. Exact ?model= query parameter match in anchor URL
  const exactAnchor = candidates.filter((r) => parseModelFromAnchor(r.anchor) === idLower);
  if (exactAnchor.length > 0) return exactAnchor;

  // 2. For Chat models, match anchor pathname slug deterministically (e.g. gpt-5.6-luna <-> gpt-5-6-luna, gemini-3.1-pro <-> gemini-3-1-pro)
  if (category === 'chat') {
    const cleanIdCanon = canonicalSlug(modelId);
    const cleanTitleCanon = canonicalSlug(title.replace(/\(openai\)/i, ''));

    const slugMatches = candidates.filter((r) => {
      const slug = parseSlugFromAnchor(r.anchor);
      if (!slug) return false;
      const slugCanon = canonicalSlug(slug);
      return slugCanon === cleanIdCanon || slugCanon === cleanTitleCanon;
    });
    if (slugMatches.length > 0) return slugMatches;

    // Fallback: prefix before first comma in modelDescription
    const descMatches = candidates.filter((r) => {
      const prefix = r.modelDescription.split(',')[0] || '';
      const prefixCanon = canonicalSlug(prefix);
      return prefixCanon === cleanIdCanon || prefixCanon === cleanTitleCanon;
    });
    if (descMatches.length > 0) return descMatches;
    return [];
  }

  // 3. Exact modelId prefix/token inside modelDescription (e.g. "bytedance/seedance-2-5-flash, ...")
  const exactDesc = candidates.filter((r) => {
    const descLower = r.modelDescription.toLowerCase();
    return (
      descLower.startsWith(`${idLower},`) ||
      descLower.startsWith(`${idLower} `) ||
      descLower === idLower
    );
  });
  if (exactDesc.length > 0) return exactDesc;

  // 4. Scored family/variant match with strict version/tier conflict guard
  const normalizedId = normalizeToken(modelId);
  const normalizedTitle = normalizeToken(title);
  const idParts = idLower.split('/');
  const familySlug = idParts[0];
  const variantSlug = idParts[1] || '';

  const scored: Array<{ row: PricingRuleRow; score: number }> = [];
  for (const row of candidates) {
    const descNorm = normalizeToken(row.modelDescription);
    const anchorPath = parseSlugFromAnchor(row.anchor);

    let score = 0;

    const tierWords = [
      'pro',
      'lite',
      'fast',
      'flash',
      'mini',
      'max',
      'turbo',
      'ultra',
      'economy',
      'flare',
      'sunburst',
      'master',
      'standard',
      'draft',
      'prime',
      'omni',
      'klein',
    ];
    let tierConflict = false;
    for (const tw of tierWords) {
      const inModel =
        normalizedId.includes(` ${tw}`) ||
        normalizedId.startsWith(`${tw} `) ||
        normalizedTitle.includes(tw);
      const inRow = descNorm.includes(tw) || anchorPath.includes(tw);
      if (inModel !== inRow) {
        if (!idLower.includes('veo-3-1') && !idLower.includes('veo3')) {
          tierConflict = true;
          break;
        }
      }
    }
    if (tierConflict) continue;

    if (descNorm.includes(normalizedId)) score += 100;
    if (descNorm.includes(normalizedTitle)) score += 90;
    if (anchorPath && normalizeToken(anchorPath) === normalizeToken(familySlug)) score += 40;

    const modes = [
      'text to image',
      'image to image',
      'image edit',
      'upscale',
      'text to video',
      'image to video',
      'reference to video',
      'keyframe to video',
      'video to video',
      'extend',
    ];
    for (const m of modes) {
      const mInModel = normalizedId.includes(m) || normalizedTitle.includes(m);
      const mInRow = descNorm.includes(m);
      if (mInModel && mInRow) score += 50;
      else if (
        mInModel &&
        !mInRow &&
        (descNorm.includes('text to') ||
          descNorm.includes('image to') ||
          descNorm.includes('reference to') ||
          descNorm.includes('keyframe to'))
      ) {
        const rawLower = row.modelDescription.toLowerCase();
        if (!rawLower.includes('text /image') && !rawLower.includes('text-to-image / image-to-image')) {
          score -= 40;
        }
      }
    }

    const verModel = normalizedId.match(/\b(\d+(?: \d+)?)\b/g) || [];
    const verRow = descNorm.match(/\b(\d+(?: \d+)?)\b/g) || [];
    if (verModel.length > 0 && verRow.length > 0) {
      const v1 = verModel[0];
      if (v1) {
        if (descNorm.includes(v1)) score += 30;
        else score -= 60;
      }
    }

    if (variantSlug && descNorm.includes(normalizeToken(variantSlug))) {
      score += 45;
    }

    if (score >= 80) {
      scored.push({ row, score });
    }
  }

  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;
  return scored.filter((s) => s.score >= topScore - 20).map((s) => s.row);
}

function buildChatTokenPricing(rows: PricingRuleRow[]): ChatTokenPricing {
  let inputCreditsPerMillion: number | null = null;
  let outputCreditsPerMillion: number | null = null;
  let cachedInputCreditsPerMillion: number | null = null;
  let cacheWriteCreditsPerMillion: number | null = null;
  let reasoningCreditsPerMillion: number | null = null;
  let inputUsdPerMillion: number | null = null;
  let outputUsdPerMillion: number | null = null;

  for (const r of rows) {
    const desc = r.modelDescription.toLowerCase();
    const cr = Number(r.creditPrice);
    const usd = Number(r.usdPrice);
    if (!Number.isFinite(cr)) continue;

    if (desc.includes('cached input') || desc.includes('cache read')) {
      cachedInputCreditsPerMillion = cr;
    } else if (desc.includes('cache write') || desc.includes('cache creation')) {
      cacheWriteCreditsPerMillion = cr;
    } else if (desc.includes('reasoning')) {
      reasoningCreditsPerMillion = cr;
    } else if (desc.includes('output')) {
      outputCreditsPerMillion = cr;
      if (Number.isFinite(usd)) outputUsdPerMillion = usd;
    } else if (desc.includes('input')) {
      inputCreditsPerMillion = cr;
      if (Number.isFinite(usd)) inputUsdPerMillion = usd;
    }
  }

  return {
    inputCreditsPerMillion,
    outputCreditsPerMillion,
    cachedInputCreditsPerMillion,
    cacheWriteCreditsPerMillion,
    reasoningCreditsPerMillion,
    inputUsdPerMillion,
    outputUsdPerMillion,
  };
}

function evaluatePricingVerification(
  category: ModelCategory,
  rows: PricingRuleRow[],
  chatPricing?: ChatTokenPricing
): {
  pricingVerified: boolean;
  pricingUnavailableReason?: string;
  startingCredits: number | null;
  pricingUnitLabel: string | null;
} {
  if (rows.length === 0) {
    return {
      pricingVerified: false,
      pricingUnavailableReason: 'Pricing unavailable — generation temporarily disabled.',
      startingCredits: null,
      pricingUnitLabel: null,
    };
  }

  if (category === 'chat') {
    if (
      chatPricing &&
      chatPricing.inputCreditsPerMillion !== null &&
      chatPricing.outputCreditsPerMillion !== null
    ) {
      return {
        pricingVerified: true,
        startingCredits: chatPricing.inputCreditsPerMillion,
        pricingUnitLabel: 'cr / 1M input tokens',
      };
    }
    return {
      pricingVerified: false,
      pricingUnavailableReason: 'Token pricing unavailable — chat model temporarily disabled.',
      startingCredits: null,
      pricingUnitLabel: null,
    };
  }

  const fixedRows = rows.filter((r) => !r.creditUnit.toLowerCase().includes('token'));
  if (fixedRows.length === 0) {
    return {
      pricingVerified: false,
      pricingUnavailableReason: 'Variable token-based pricing — exact pre-generation credit cost unavailable.',
      startingCredits: null,
      pricingUnitLabel: rows[0].creditUnit || null,
    };
  }

  const numericPrices = fixedRows
    .map((r) => Number(r.creditPrice))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (numericPrices.length === 0) {
    return {
      pricingVerified: false,
      pricingUnavailableReason: 'Pricing unavailable — generation temporarily disabled.',
      startingCredits: null,
      pricingUnitLabel: null,
    };
  }

  const mainRows = fixedRows.filter(
    (r) =>
      !r.modelDescription.toLowerCase().includes('(each)') &&
      !r.modelDescription.toLowerCase().includes('input image')
  );
  const targetRows = mainRows.length > 0 ? mainRows : fixedRows;
  let minRow = targetRows[0];
  let minPrice = Number(minRow.creditPrice);
  for (const r of targetRows) {
    const p = Number(r.creditPrice);
    if (Number.isFinite(p) && p > 0 && p < minPrice) {
      minPrice = p;
      minRow = r;
    }
  }

  return {
    pricingVerified: true,
    startingCredits: Number.isFinite(minPrice) ? minPrice : null,
    pricingUnitLabel: minRow.creditUnit || null,
  };
}

function buildCatalogModel(
  entry: DocEntry,
  parsedSpec: ParsedSpec | null,
  specHydrated: boolean,
  modelPathsSet: Set<string>,
  allPricingRows: PricingRuleRow[]
): CatalogModel | null {
  if (parsedSpec && !parsedSpec.hasPost) {
    return null;
  }

  const modelId = parsedSpec?.modelId || deriveFallbackModelId(entry.docUrl, entry.category);
  const fields = parsedSpec?.fields || [];
  const modes = inferModes(entry.title, modelId, entry.category, fields);
  const params = extractSupportedParams(fields);
  const pricingRows = matchPricingRows(modelId, entry.title, entry.category, allPricingRows);
  const chatPricing = entry.category === 'chat' ? buildChatTokenPricing(pricingRows) : undefined;
  const pricingCheck = evaluatePricingVerification(entry.category, pricingRows, chatPricing);
  const deprecated = Boolean(parsedSpec?.deprecated);

  const endpointPath = parsedSpec?.endpointPath || '/api/v1/jobs/createTask';
  const chatProtocol = entry.category === 'chat' ? inferChatProtocol(endpointPath) : undefined;

  const isInModelPaths =
    modelPathsSet.size === 0
      ? entry.category !== 'chat'
      : modelPathsSet.has(modelId) ||
        Array.from(modelPathsSet).some((p) => p.toLowerCase() === modelId.toLowerCase());

  const isAvailable = Boolean(
    specHydrated &&
      parsedSpec?.hasPost &&
      !deprecated &&
      modelId &&
      (entry.category === 'chat'
        ? Boolean(chatProtocol) && (modelPathsSet.size === 0 || isInModelPaths)
        : isInModelPaths || endpointPath.startsWith('/api/v1/'))
  );

  let unavailableReason: string | undefined;
  if (!specHydrated) {
    unavailableReason = 'Model specification still synchronizing from Kie.ai docs.';
  } else if (deprecated) {
    unavailableReason = 'Deprecated model in official Kie.ai docs — generation disabled.';
  } else if (!isAvailable) {
    unavailableReason =
      entry.category === 'chat' && modelPathsSet.size > 0 && !isInModelPaths
        ? 'Model not currently active in Kie.ai playground/model-paths API.'
        : 'Model could not be verified as active in Kie.ai API.';
  } else if (!pricingCheck.pricingVerified) {
    unavailableReason = pricingCheck.pricingUnavailableReason;
  }

  const verificationStatus: VerificationBadge = !specHydrated
    ? 'UNVERIFIED'
    : deprecated || !isAvailable || !pricingCheck.pricingVerified
      ? 'UNAVAILABLE'
      : 'VERIFIED';

  const cleanDesc = (parsedSpec?.description || '')
    .replace(/:::[\s\S]*?:::/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);

  return {
    id: modelId,
    docUrl: entry.docUrl,
    title: entry.title,
    provider: entry.provider,
    category: entry.category,
    modes,
    endpointPath,
    description: cleanDesc,
    deprecated,
    isInModelPaths,
    isAvailable,
    verificationStatus,
    unavailableReason,
    specHydrated,
    supportedResolutions: params.resolutions,
    supportedAspectRatios: params.aspectRatios,
    supportedDurations: params.durations,
    minDuration: params.minDuration,
    maxDuration: params.maxDuration,
    supportedOutputCounts: params.outputCounts,
    supportsAudioToggle: params.supportsAudioToggle,
    fields,
    pricingRows,
    pricingVerified: pricingCheck.pricingVerified,
    pricingUnavailableReason: pricingCheck.pricingUnavailableReason,
    startingCredits: pricingCheck.startingCredits,
    pricingUnitLabel: pricingCheck.pricingUnitLabel,
    chatProtocol,
    supportsStreaming: entry.category === 'chat' ? Boolean(parsedSpec?.supportsStreaming) : undefined,
    contextWindow: entry.category === 'chat' ? parsedSpec?.contextWindow ?? null : undefined,
    chatPricing,
    chatCapabilities:
      entry.category === 'chat'
        ? inferChatCapabilities(modelId, chatProtocol, parsedSpec?.description || '')
        : undefined,
  };
}

function deriveFallbackModelId(docUrl: string, category: ModelCategory): string {
  if (category === 'chat') {
    const lastSeg = docUrl.split('/').pop() || docUrl;
    return lastSeg.replace(/\.md$/, '');
  }
  return docUrl
    .replace('https://docs.kie.ai/market/', '')
    .replace('https://docs.kie.ai/', '')
    .replace(/\.md$/, '');
}

async function fetchPricingPages(interfaceType: 'image' | 'video' | 'chat'): Promise<PricingRuleRow[]> {
  const rows: PricingRuleRow[] = [];
  let page = 1;
  while (page <= 12) {
    const res = await fetch(PRICING_PAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pageNum: page, pageSize: 100, interfaceType }),
    });
    if (!res.ok) {
      throw new Error(formatHttpSourceError(`Pricing API (${interfaceType})`, res.status));
    }
    const json = (await res.json()) as {
      code?: number;
      data?: { records?: PricingRuleRow[]; pages?: number; total?: number };
    };
    if (json.code !== 200 || !json.data?.records) break;
    rows.push(...json.data.records);
    if (page >= (json.data.pages || 1) || rows.length >= (json.data.total || rows.length)) break;
    page++;
  }
  return rows;
}

async function fetchAndCacheSpec(entry: DocEntry): Promise<ParsedSpec | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(entry.docUrl, {
        headers: DOCS_FETCH_HEADERS,
        signal: controller.signal,
      });
      if (!res.ok) {
        if (attempt === 0) continue;
        return null;
      }
      const md = await res.text();
      const spec = extractOpenApiSpec(md, entry.docUrl);
      if (spec) {
        db.prepare(
          `INSERT INTO model_specs (doc_url, model_id, category, title, spec_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(doc_url) DO UPDATE SET
             model_id = excluded.model_id,
             category = excluded.category,
             title = excluded.title,
             spec_json = excluded.spec_json,
             synced_at = excluded.synced_at`
        ).run(entry.docUrl, spec.modelId, entry.category, entry.title, JSON.stringify(spec), Date.now());
      }
      return spec;
    } catch {
      if (attempt === 1) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function rebuildModelsFromState(): void {
  const specRows = db.prepare('SELECT doc_url, spec_json FROM model_specs').all() as Array<{
    doc_url: string;
    spec_json: string;
  }>;
  const specMap = new Map<string, ParsedSpec>();
  for (const r of specRows) {
    try {
      specMap.set(r.doc_url, JSON.parse(r.spec_json) as ParsedSpec);
    } catch {
      // ignore corrupted entry
    }
  }

  const modelPathsSet = new Set(state.modelPaths);
  const built: CatalogModel[] = [];
  const seenKey = new Set<string>();

  for (const entry of state.docEntries) {
    const spec = specMap.get(entry.docUrl) ?? null;
    const model = buildCatalogModel(entry, spec, spec !== null, modelPathsSet, state.pricingRows);
    if (!model) continue;
    const uniqueKey = `${model.category}:${model.id}`;
    if (seenKey.has(uniqueKey)) continue;
    seenKey.add(uniqueKey);
    built.push(model);
  }

  built.sort((a, b) => {
    const scoreA = (a.isAvailable ? 2 : 0) + (a.pricingVerified ? 1 : 0);
    const scoreB = (b.isAvailable ? 2 : 0) + (b.pricingVerified ? 1 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.title.localeCompare(b.title);
  });

  state.models = built;
}

export function loadCatalogFromDb(): boolean {
  const registry = loadVerifiedRegistry();
  hydrateMissingSpecsFromRegistry(registry);

  const row = db
    .prepare(
      'SELECT synced_at, model_paths_json, pricing_rows_json, doc_entries_json FROM catalog_cache WHERE id = ?'
    )
    .get('primary') as
    | {
        synced_at: number;
        model_paths_json: string;
        pricing_rows_json: string;
        doc_entries_json: string;
      }
    | undefined;

  if (!row) return false;
  try {
    state.syncedAt = row.synced_at;
    state.modelPaths = JSON.parse(row.model_paths_json);
    state.pricingRows = JSON.parse(row.pricing_rows_json);
    const parsedEntries = JSON.parse(row.doc_entries_json) as DocEntry[];
    state.docEntries = parsedEntries.filter(
      (e) => !e.docUrl.includes('codex/gpt-codex.md')
    );
    rebuildModelsFromState();
    return true;
  } catch {
    return false;
  }
}

export async function syncCatalog(forceSpecs = false): Promise<{
  ok: boolean;
  syncedAt: number | null;
  totalModels: number;
  error?: string;
}> {
  if (inflightSyncPromise) {
    return inflightSyncPromise;
  }

  inflightSyncPromise = runSyncCatalog(forceSpecs).finally(() => {
    inflightSyncPromise = null;
  });
  return inflightSyncPromise;
}

async function runSyncCatalog(forceSpecs: boolean): Promise<{
  ok: boolean;
  syncedAt: number | null;
  totalModels: number;
  error?: string;
}> {
  state.syncing = true;
  state.lastError = null;
  state.docsWarning = null;

  try {
    const registry = loadVerifiedRegistry();
    const cachedSpecRowsBefore = db
      .prepare('SELECT doc_url, spec_json FROM model_specs')
      .all() as Array<{ doc_url: string; spec_json: string }>;

    const [llmsSettled, modelPathsSettled, imgPricingSettled, vidPricingSettled, chatPricingSettled] =
      await Promise.allSettled([
        fetch(DOCS_LLMS_URL, { headers: DOCS_FETCH_HEADERS }).then(async (r) => {
          if (!r.ok) {
            throw new Error(formatHttpSourceError('docs.kie.ai/llms.txt', r.status));
          }
          return r.text();
        }),
        fetch(MODEL_PATHS_URL, { headers: { Accept: 'application/json' } }).then(async (r) => {
          if (!r.ok) {
            throw new Error(formatHttpSourceError('api.kie.ai/api/v1/playground/model-paths', r.status));
          }
          return (await r.json()) as { code?: number; data?: string[] };
        }),
        fetchPricingPages('image'),
        fetchPricingPages('video'),
        fetchPricingPages('chat'),
      ]);

    const liveApiErrors: string[] = [];

    if (modelPathsSettled.status === 'fulfilled') {
      const mpData = modelPathsSettled.value.data;
      if (Array.isArray(mpData) && mpData.length > 0) {
        state.modelPaths = mpData;
      } else {
        liveApiErrors.push('api.kie.ai/api/v1/playground/model-paths returned an empty list');
      }
    } else {
      liveApiErrors.push(
        modelPathsSettled.reason instanceof Error
          ? modelPathsSettled.reason.message
          : String(modelPathsSettled.reason)
      );
    }

    const nextPricingByType = new Map<string, PricingRuleRow[]>();
    for (const existingRow of state.pricingRows) {
      const key = existingRow.interfaceType.toLowerCase();
      const arr = nextPricingByType.get(key) || [];
      arr.push(existingRow);
      nextPricingByType.set(key, arr);
    }

    const pricingResults: Array<['image' | 'video' | 'chat', PromiseSettledResult<PricingRuleRow[]>]> = [
      ['image', imgPricingSettled],
      ['video', vidPricingSettled],
      ['chat', chatPricingSettled],
    ];
    for (const [iface, settled] of pricingResults) {
      if (settled.status === 'fulfilled') {
        nextPricingByType.set(iface, settled.value);
      } else {
        liveApiErrors.push(
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
        );
      }
    }
    const mergedPricingRows = Array.from(nextPricingByType.values()).flat();
    if (mergedPricingRows.length > 0) {
      state.pricingRows = mergedPricingRows;
    }

    let docEntries: DocEntry[] = [];
    let docsLiveOk = false;

    if (llmsSettled.status === 'fulfilled') {
      const parsed = parsellmsEntries(llmsSettled.value);
      if (parsed.length > 0) {
        docEntries = parsed;
        docsLiveOk = true;
      } else {
        state.docsWarning = 'docs.kie.ai/llms.txt returned no parseable model entries';
      }
    } else {
      state.docsWarning =
        llmsSettled.reason instanceof Error
          ? llmsSettled.reason.message
          : String(llmsSettled.reason);
    }

    if (!docsLiveOk) {
      // Fall back to existing DB entries or bundled official OpenAPI registry (still verified live against api.kie.ai)
      hydrateMissingSpecsFromRegistry(registry);
      if (state.docEntries.length > 0) {
        docEntries = state.docEntries;
      } else if (registry && registry.docEntries.length > 0) {
        docEntries = registry.docEntries;
      }
    } else {
      state.docEntries = docEntries;
    }

    if (docEntries.length === 0) {
      const msg =
        [state.docsWarning, ...liveApiErrors].filter(Boolean).join('; ') ||
        'No model specifications available from Kie.ai sources.';
      state.lastError = msg;
      return {
        ok: false,
        syncedAt: state.syncedAt,
        totalModels: state.models.length,
        error: msg,
      };
    }

    state.docEntries = docEntries;

    if (docsLiveOk) {
      const validCachedUrls = new Set<string>();
      for (const r of cachedSpecRowsBefore) {
        try {
          const parsed = JSON.parse(r.spec_json) as Partial<ParsedSpec>;
          if (typeof parsed.deprecated === 'boolean') {
            validCachedUrls.add(r.doc_url);
          }
        } catch {
          // re-fetch corrupted cache
        }
      }

      const toFetch = forceSpecs
        ? docEntries
        : docEntries.filter((e) => !validCachedUrls.has(e.docUrl));

      // Keep concurrency <= 8 to avoid connect timeouts on docs.kie.ai
      const BATCH = 8;
      for (let i = 0; i < toFetch.length; i += BATCH) {
        const slice = toFetch.slice(i, i + BATCH);
        await Promise.all(slice.map((entry) => fetchAndCacheSpec(entry).catch(() => null)));
      }
      // Ensure any docs that timed out or failed still use verified registry if available
      hydrateMissingSpecsFromRegistry(registry);
    }

    const liveApiAllFailed =
      modelPathsSettled.status === 'rejected' && chatPricingSettled.status === 'rejected';

    if (liveApiErrors.length > 0) {
      state.lastError = liveApiErrors.join('; ');
    }

    if (!liveApiAllFailed) {
      state.syncedAt = Date.now();
      db.prepare(
        `INSERT INTO catalog_cache (id, synced_at, model_paths_json, pricing_rows_json, doc_entries_json)
         VALUES ('primary', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           synced_at = excluded.synced_at,
           model_paths_json = excluded.model_paths_json,
           pricing_rows_json = excluded.pricing_rows_json,
           doc_entries_json = excluded.doc_entries_json`
      ).run(
        state.syncedAt,
        JSON.stringify(state.modelPaths),
        JSON.stringify(state.pricingRows),
        JSON.stringify(state.docEntries)
      );
    }

    rebuildModelsFromState();

    const ok = liveApiErrors.length === 0 && state.models.length > 0;
    return {
      ok,
      syncedAt: state.syncedAt,
      totalModels: state.models.length,
      error: state.lastError || undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    return {
      ok: false,
      syncedAt: state.syncedAt,
      totalModels: state.models.length,
      error: message,
    };
  } finally {
    state.syncing = false;
  }
}

export async function exportRegistrySnapshot(): Promise<VerifiedRegistryFile> {
  await syncCatalog(true);
  const specRows = db
    .prepare('SELECT doc_url, spec_json FROM model_specs')
    .all() as Array<{ doc_url: string; spec_json: string }>;
  const specs: Record<string, ParsedSpec> = {};
  const validUrls = new Set(state.docEntries.map((e) => e.docUrl));
  for (const row of specRows) {
    if (!validUrls.has(row.doc_url)) continue;
    try {
      specs[row.doc_url] = JSON.parse(row.spec_json) as ParsedSpec;
    } catch {
      // skip
    }
  }
  return {
    generatedAt: Date.now(),
    docEntries: state.docEntries,
    specs,
  };
}

export async function ensureCatalogReady(): Promise<void> {
  if (state.models.length === 0) {
    loadCatalogFromDb();
  }
  const hasChatEntries = state.docEntries.some((d) => d.category === 'chat');
  const stale =
    !state.syncedAt || Date.now() - state.syncedAt > CACHE_TTL_MS || !hasChatEntries;

  if (state.models.length === 0 || !hasChatEntries) {
    await syncCatalog(false);
  } else if (stale && !state.syncing) {
    void syncCatalog(false);
  }
}

export async function getCatalogSummary(): Promise<{
  syncedAt: number | null;
  syncing: boolean;
  stale: boolean;
  lastError: string | null;
  docsWarning: string | null;
  models: CatalogModel[];
}> {
  await ensureCatalogReady();
  const stale =
    state.lastError !== null ||
    !state.syncedAt ||
    Date.now() - state.syncedAt > CACHE_TTL_MS;
  return {
    syncedAt: state.syncedAt,
    syncing: state.syncing,
    stale,
    lastError: state.lastError,
    docsWarning: state.docsWarning,
    models: state.models,
  };
}

export async function getModelById(
  modelId: string,
  category?: ModelCategory
): Promise<CatalogModel | null> {
  await ensureCatalogReady();
  const found =
    state.models.find((m) => m.id === modelId && (!category || m.category === category)) ||
    null;
  if (found && !found.specHydrated) {
    const entry = state.docEntries.find((e) => e.docUrl === found.docUrl);
    if (entry) {
      await fetchAndCacheSpec(entry).catch(() => null);
      rebuildModelsFromState();
      return (
        state.models.find((m) => m.id === modelId && (!category || m.category === category)) ||
        found
      );
    }
  }
  return found;
}

export function calculateExactCost(
  model: CatalogModel,
  inputParams: Record<string, unknown>
): CostCalculationResult {
  if (model.category === 'chat') {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: 'Chat models are billed dynamically per input, output, cached, and reasoning tokens.',
    };
  }

  if (!model.isAvailable) {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: model.unavailableReason || 'Selected model is currently unavailable.',
    };
  }
  if (!model.pricingVerified || model.pricingRows.length === 0) {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: model.pricingUnavailableReason || 'Pricing unavailable — generation temporarily disabled.',
    };
  }

  const fixedRows = model.pricingRows.filter((r) => !r.creditUnit.toLowerCase().includes('token'));
  if (fixedRows.length === 0) {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: 'Pricing unavailable — generation temporarily disabled.',
    };
  }

  const addonRows = fixedRows.filter(
    (r) =>
      r.modelDescription.toLowerCase().includes('reference image (each)') ||
      r.modelDescription.toLowerCase().includes('input image')
  );
  const mainRows = fixedRows.filter((r) => !addonRows.includes(r));
  if (mainRows.length === 0) {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: 'Pricing unavailable — generation temporarily disabled.',
    };
  }

  const resolution = String(
    inputParams.resolution ?? inputParams.quality ?? inputParams.image_size ?? ''
  ).toLowerCase();
  const durationRaw = inputParams.duration ?? inputParams.seconds ?? model.supportedDurations[0];
  const durationNum =
    durationRaw !== undefined ? parseFloat(String(durationRaw).replace(/s$/i, '')) : NaN;
  const soundOn = Boolean(
    inputParams.sound ??
      inputParams.generate_audio ??
      inputParams.enable_audio ??
      inputParams.audio ??
      false
  );
  const outputCountRaw =
    inputParams.n ?? inputParams.num_images ?? inputParams.image_count ?? inputParams.num_outputs ?? 1;
  const outputCount = Math.max(1, Number(outputCountRaw) || 1);
  const subModelTier = typeof inputParams.model === 'string' ? inputParams.model.toLowerCase() : '';

  const hasVideoInput =
    Boolean(inputParams.video_url) ||
    (Array.isArray(inputParams.video_urls) && inputParams.video_urls.length > 0);
  const inputImageCount = Array.isArray(inputParams.image_urls)
    ? inputParams.image_urls.filter(Boolean).length
    : Array.isArray(inputParams.input_urls)
      ? inputParams.input_urls.filter(Boolean).length
      : inputParams.image_url || inputParams.input_image
        ? 1
        : 0;

  let candidates = [...mainRows];

  if (subModelTier) {
    const tierFiltered = candidates.filter((r) => {
      const d = r.modelDescription.toLowerCase();
      if (subModelTier.includes('lite')) return d.includes('lite');
      if (subModelTier.includes('fast')) return d.includes('fast');
      if (subModelTier === 'veo3')
        return d.includes('quality') || (!d.includes('fast') && !d.includes('lite'));
      return d.includes(subModelTier);
    });
    if (tierFiltered.length > 0) candidates = tierFiltered;
  }

  if (resolution) {
    const resNorm = resolution.replace(/\s+/g, '');
    const resFiltered = candidates.filter((r) => {
      const d = r.modelDescription.toLowerCase();
      return (
        d.includes(resNorm) ||
        (resNorm === '1k' && d.includes('1k / 2k')) ||
        (resNorm === '2k' && d.includes('1k / 2k'))
      );
    });
    if (resFiltered.length > 0) candidates = resFiltered;
  }

  const hasExplicitAudioRows = candidates.some((r) =>
    /with audio|no audio|without audio|with sound|no sound|audio on|audio off/i.test(
      r.modelDescription
    )
  );
  if (hasExplicitAudioRows) {
    const audioFiltered = candidates.filter((r) => {
      const d = r.modelDescription.toLowerCase();
      if (soundOn) {
        return d.includes('with audio') || d.includes('with sound') || d.includes('audio on');
      }
      return (
        d.includes('no audio') ||
        d.includes('without audio') ||
        d.includes('no sound') ||
        d.includes('audio off')
      );
    });
    if (audioFiltered.length > 0) candidates = audioFiltered;
  }

  const hasVideoInputRows = candidates.some((r) =>
    /with video|no video/i.test(r.modelDescription)
  );
  if (hasVideoInputRows) {
    const vidFiltered = candidates.filter((r) => {
      const d = r.modelDescription.toLowerCase();
      return hasVideoInput ? d.includes('with video') : d.includes('no video');
    });
    if (vidFiltered.length > 0) candidates = vidFiltered;
  }

  if (Number.isFinite(durationNum)) {
    const durFiltered = candidates.filter((r) => {
      const d = r.modelDescription.toLowerCase();
      return (
        d.includes(`${durationNum}.0s`) ||
        d.includes(`${durationNum}s`) ||
        d.includes(`${durationNum} second`)
      );
    });
    if (durFiltered.length > 0) candidates = durFiltered;
  }

  const uniquePrices = Array.from(new Set(candidates.map((c) => Number(c.creditPrice))));
  if (candidates.length === 0 || uniquePrices.length === 0) {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: 'Pricing unavailable for selected configuration — generation temporarily disabled.',
    };
  }

  if (uniquePrices.length > 1) {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: `Exact price depends on a specific tier (${candidates.map((c) => c.modelDescription).slice(0, 3).join('; ')}). Please select matching parameters.`,
    };
  }

  const chosen = candidates[0];
  const baseUnitCredits = Number(chosen.creditPrice);
  if (!Number.isFinite(baseUnitCredits) || baseUnitCredits <= 0) {
    return {
      verified: false,
      exactCredits: null,
      exactUsd: null,
      breakdown: [],
      reason: 'Pricing unavailable — generation temporarily disabled.',
    };
  }

  const unitLower = chosen.creditUnit.toLowerCase();
  const breakdown: string[] = [];
  let totalCredits = 0;

  if (unitLower.includes('second')) {
    if (!Number.isFinite(durationNum) || durationNum <= 0) {
      return {
        verified: false,
        exactCredits: null,
        exactUsd: null,
        breakdown: [],
        reason: 'Select a valid video duration to compute exact credit cost.',
      };
    }
    let effectiveRate = baseUnitCredits;
    if (
      !hasExplicitAudioRows &&
      soundOn &&
      /enabling sound doubles the price/i.test(model.description)
    ) {
      effectiveRate *= 2;
      breakdown.push(`${baseUnitCredits} × 2 (audio enabled) = ${effectiveRate} credits/s`);
    } else {
      breakdown.push(`${effectiveRate} credits/s (${chosen.modelDescription})`);
    }
    totalCredits = Number((effectiveRate * durationNum).toFixed(4));
    breakdown.push(`${durationNum}s × ${effectiveRate} credits/s = ${totalCredits} credits`);
  } else if (unitLower.includes('video') || (unitLower.includes('request') && model.category === 'video')) {
    let effectivePrice = baseUnitCredits;
    if (
      !hasExplicitAudioRows &&
      soundOn &&
      /enabling sound doubles the price/i.test(model.description)
    ) {
      effectivePrice *= 2;
      breakdown.push(`${baseUnitCredits} × 2 (audio enabled) = ${effectivePrice} credits`);
    } else {
      breakdown.push(`${effectivePrice} credits ${chosen.creditUnit} (${chosen.modelDescription})`);
    }
    totalCredits = Number(effectivePrice.toFixed(4));
  } else {
    totalCredits = Number((baseUnitCredits * outputCount).toFixed(4));
    breakdown.push(
      `${outputCount} image${outputCount > 1 ? 's' : ''} × ${baseUnitCredits} credits = ${totalCredits} credits`
    );
    if (addonRows.length > 0 && inputImageCount > 0) {
      const addonPrice = Number(addonRows[0].creditPrice);
      if (Number.isFinite(addonPrice) && addonPrice > 0) {
        const addonTotal = Number((addonPrice * inputImageCount).toFixed(4));
        totalCredits = Number((totalCredits + addonTotal).toFixed(4));
        breakdown.push(
          `+ ${inputImageCount} input image${inputImageCount > 1 ? 's' : ''} × ${addonPrice} credits = ${addonTotal} credits`
        );
      }
    }
  }

  return {
    verified: true,
    exactCredits: totalCredits,
    exactUsd: Number((totalCredits * 0.005).toFixed(5)),
    breakdown,
  };
}

export function calculateAffordability(
  model: CatalogModel,
  balanceCredits: number | null,
  currentInputParams: Record<string, unknown>
): AffordabilitySummary {
  if (!model.pricingVerified) {
    return {
      verified: false,
      balance: balanceCredits,
      category: model.category,
      options: [],
      maxAffordableLabel: null,
      maxAffordableValue: null,
      reason: model.pricingUnavailableReason || 'Pricing unavailable — generation temporarily disabled.',
    };
  }

  if (model.category === 'chat') {
    const inRate = model.chatPricing?.inputCreditsPerMillion;
    const outRate = model.chatPricing?.outputCreditsPerMillion;
    if (inRate === null || inRate === undefined || outRate === null || outRate === undefined) {
      return {
        verified: false,
        balance: balanceCredits,
        category: 'chat',
        options: [],
        maxAffordableLabel: null,
        maxAffordableValue: null,
        reason: 'Token pricing unavailable for this chat model.',
      };
    }
    // Sample real token bundle affordability (e.g. 1K in / 1K out, 10K in / 2K out)
    const sample1k = Number(((1000 * inRate + 1000 * outRate) / 1_000_000).toFixed(4));
    const sample10k = Number(((10000 * inRate + 2000 * outRate) / 1_000_000).toFixed(4));
    const options: AffordabilityOption[] = [
      {
        label: '1K input + 1K output tokens',
        value: '1k-1k',
        credits: sample1k,
        affordable: balanceCredits !== null && balanceCredits >= sample1k,
      },
      {
        label: '10K input + 2K output tokens',
        value: '10k-2k',
        credits: sample10k,
        affordable: balanceCredits !== null && balanceCredits >= sample10k,
      },
    ];
    const maxInputTokens =
      balanceCredits !== null && inRate > 0
        ? Math.floor((balanceCredits / inRate) * 1_000_000)
        : null;
    return {
      verified: true,
      balance: balanceCredits,
      category: 'chat',
      options,
      maxAffordableLabel:
        maxInputTokens !== null
          ? `Up to ${maxInputTokens.toLocaleString()} input tokens`
          : null,
      maxAffordableValue: maxInputTokens,
    };
  }

  const options: AffordabilityOption[] = [];

  if (model.category === 'video') {
    const durationsToCheck =
      model.supportedDurations.length > 0 ? model.supportedDurations : [5, 10, 15];

    let maxDur: number | null = null;
    for (const d of durationsToCheck) {
      const costRes = calculateExactCost(model, { ...currentInputParams, duration: d, seconds: d });
      if (costRes.verified && costRes.exactCredits !== null) {
        const affordable = balanceCredits !== null && balanceCredits >= costRes.exactCredits;
        if (affordable && (maxDur === null || d > maxDur)) {
          maxDur = d;
        }
        options.push({
          label: `${d} seconds`,
          value: d,
          credits: costRes.exactCredits,
          affordable,
        });
      }
    }

    if (options.length === 0) {
      const baseCost = calculateExactCost(model, currentInputParams);
      if (baseCost.verified && baseCost.exactCredits !== null) {
        const countAffordable =
          balanceCredits !== null ? Math.floor(balanceCredits / baseCost.exactCredits) : 0;
        options.push({
          label: '1 video',
          value: 1,
          credits: baseCost.exactCredits,
          affordable: balanceCredits !== null && balanceCredits >= baseCost.exactCredits,
        });
        return {
          verified: true,
          balance: balanceCredits,
          category: 'video',
          options,
          maxAffordableLabel:
            balanceCredits !== null
              ? `${countAffordable} video${countAffordable === 1 ? '' : 's'}`
              : null,
          maxAffordableValue: balanceCredits !== null ? countAffordable : null,
        };
      }
      return {
        verified: false,
        balance: balanceCredits,
        category: 'video',
        options: [],
        maxAffordableLabel: null,
        maxAffordableValue: null,
        reason: baseCost.reason || 'Pricing unavailable for current video parameters.',
      };
    }

    return {
      verified: true,
      balance: balanceCredits,
      category: 'video',
      options,
      maxAffordableLabel:
        balanceCredits === null
          ? null
          : maxDur !== null
            ? `${maxDur} seconds`
            : '0 seconds (insufficient balance)',
      maxAffordableValue: balanceCredits === null ? null : maxDur ?? 0,
    };
  }

  // Image category
  const countsToCheck =
    model.supportedOutputCounts.length > 1 ? model.supportedOutputCounts : [1, 2, 4];
  const oneCostRes = calculateExactCost(model, {
    ...currentInputParams,
    n: 1,
    num_images: 1,
    image_count: 1,
  });
  if (!oneCostRes.verified || oneCostRes.exactCredits === null) {
    return {
      verified: false,
      balance: balanceCredits,
      category: 'image',
      options: [],
      maxAffordableLabel: null,
      maxAffordableValue: null,
      reason: oneCostRes.reason || 'Pricing unavailable for current image parameters.',
    };
  }

  for (const cnt of countsToCheck) {
    const costRes = calculateExactCost(model, {
      ...currentInputParams,
      n: cnt,
      num_images: cnt,
      image_count: cnt,
    });
    if (costRes.verified && costRes.exactCredits !== null) {
      options.push({
        label: `${cnt} ${cnt === 1 ? 'image' : 'images'}`,
        value: cnt,
        credits: costRes.exactCredits,
        affordable: balanceCredits !== null && balanceCredits >= costRes.exactCredits,
      });
    }
  }

  const maxImages =
    balanceCredits !== null && oneCostRes.exactCredits > 0
      ? Math.floor(balanceCredits / oneCostRes.exactCredits)
      : null;

  return {
    verified: true,
    balance: balanceCredits,
    category: 'image',
    options,
    maxAffordableLabel:
      maxImages !== null ? `${maxImages} image${maxImages === 1 ? '' : 's'}` : null,
    maxAffordableValue: maxImages,
  };
}
