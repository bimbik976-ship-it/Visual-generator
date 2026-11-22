export type KeyStatus =
  | 'Valid'
  | 'Invalid'
  | 'Insufficient Balance'
  | 'Restricted'
  | 'Rate Limited'
  | 'Balance Unavailable'
  | 'Unknown';

export type GenerationStatus =
  | 'Validating'
  | 'Submitting'
  | 'Queued'
  | 'Processing'
  | 'Succeeded'
  | 'Failed'
  | 'Cancelled'
  | 'Timed Out'
  | 'Unknown';

export type ModelCategory = 'video' | 'image' | 'chat';

export type ChatProtocol =
  | 'openai-responses'
  | 'openai-completions'
  | 'anthropic-messages'
  | 'gemini-native';

export type VerificationBadge =
  | 'VERIFIED'
  | 'UNVERIFIED'
  | 'UNAVAILABLE'
  | 'STALE'
  | 'COMING SOON';

export interface ModelInputField {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  itemType?: string;
  required: boolean;
  description: string;
  enumValues?: Array<string | number | boolean>;
  defaultValue?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  example?: unknown;
}

export interface PricingRuleRow {
  modelDescription: string;
  interfaceType: string;
  provider: string;
  creditPrice: string;
  creditUnit: string;
  usdPrice: string;
  anchor: string;
}

export interface ChatTokenPricing {
  inputCreditsPerMillion: number | null;
  outputCreditsPerMillion: number | null;
  cachedInputCreditsPerMillion: number | null;
  cacheWriteCreditsPerMillion: number | null;
  reasoningCreditsPerMillion: number | null;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

export interface ChatCapabilities {
  supportsImageInput: boolean;
  supportsVideoInput: boolean;
  supportsFileInput: boolean;
  supportsZipAnalysis: boolean;
  maxFilesPerMessage: number;
}

export interface ChatAttachmentPayload {
  kind: 'image' | 'video' | 'zip' | 'video-frames';
  name: string;
  mimeType: string;
  size: number;
  remoteUrl?: string;
  dataUrl?: string;
  zipSummary?: string;
  frameImages?: Array<{
    label: string;
    mimeType: string;
    dataUrl?: string;
    remoteUrl?: string;
  }>;
}

export interface ChatMessageAttachmentMeta {
  kind: 'image' | 'video' | 'zip' | 'video-frames';
  name: string;
  mimeType: string;
  size: number;
  remoteUrl?: string;
  zipFileCount?: number;
  frameCount?: number;
  note?: string;
}

export interface CatalogModel {
  id: string;
  docUrl: string;
  title: string;
  provider: string;
  category: ModelCategory;
  modes: string[];
  endpointPath: string;
  description: string;
  deprecated: boolean;
  isInModelPaths: boolean;
  isAvailable: boolean;
  verificationStatus: VerificationBadge;
  unavailableReason?: string;
  specHydrated: boolean;
  supportedResolutions: string[];
  supportedAspectRatios: string[];
  supportedDurations: number[];
  minDuration?: number;
  maxDuration?: number;
  supportedOutputCounts: number[];
  supportsAudioToggle: boolean;
  fields: ModelInputField[];
  pricingRows: PricingRuleRow[];
  pricingVerified: boolean;
  pricingUnavailableReason?: string;
  startingCredits: number | null;
  pricingUnitLabel: string | null;
  chatProtocol?: ChatProtocol;
  supportsStreaming?: boolean;
  contextWindow?: number | null;
  chatPricing?: ChatTokenPricing;
  chatCapabilities?: ChatCapabilities;
}

export interface CostCalculationResult {
  verified: boolean;
  exactCredits: number | null;
  exactUsd: number | null;
  breakdown: string[];
  reason?: string;
}

export interface AffordabilityOption {
  label: string;
  value: number | string;
  credits: number;
  affordable: boolean;
}

export interface AffordabilitySummary {
  verified: boolean;
  balance: number | null;
  category: ModelCategory;
  options: AffordabilityOption[];
  maxAffordableLabel: string | null;
  maxAffordableValue: number | null;
  reason?: string;
}

export interface LocalApiKey {
  id: string;
  label: string;
  apiKey: string;
  maskedKey: string;
  status: KeyStatus;
  balance: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  isActive: boolean;
  priorityOrder: number;
  createdAt: number;
}

export interface LocalMediaTask {
  id: string;
  clientRequestId: string;
  keyId: string | null;
  keyLabelUsed: string | null;
  maskedKeyUsed: string | null;
  modelId: string;
  modelTitle: string;
  category: 'video' | 'image';
  generationMode: string;
  endpointPath: string;
  input: Record<string, unknown>;
  verifiedCost: number;
  status: GenerationStatus;
  kieTaskId: string | null;
  resultUrls: string[];
  mediaVerified: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  rawState: string | null;
  creditsConsumed: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ChatTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  creditsConsumed: number | null;
  calculatedCredits: number | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  // Per-message attribution preserved when user switches models mid-conversation
  modelId: string;
  modelTitle: string;
  provider: string;
  keyLabelUsed?: string | null;
  maskedKeyUsed?: string | null;
  usage?: ChatTokenUsage | null;
  error?: string | null;
  attachments?: ChatMessageAttachmentMeta[];
}

export interface ChatConversation {
  id: string;
  title: string;
  modelId: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
