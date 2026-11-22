import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Edit3,
  ExternalLink,
  FileArchive,
  FileImage,
  FileVideo,
  Info,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api, type ZipParseResponse } from '../api';
import { getCandidateKeysInOrder } from '../storage/localVault';
import type {
  CatalogModel,
  ChatAttachmentPayload,
  ChatConversation,
  ChatMessage,
  ChatMessageAttachmentMeta,
  KeyStatus,
  LocalApiKey,
} from '../types';
import {
  extractVideoKeyframes,
  type VideoFrameExtractionResult,
} from '../utils/videoFrameExtractor';

interface ChatGeneratorViewProps {
  models: CatalogModel[];
  syncedAt: number | null;
  catalogSyncing: boolean;
  catalogStale: boolean;
  catalogError: string | null;
  onSyncCatalog: () => void;
  keys: LocalApiKey[];
  autoRotateEnabled: boolean;
  onUpdateKeyVerification: (
    keyId: string,
    patch: { status: KeyStatus; balance: number | null; lastError?: string | null }
  ) => void;
  conversations: ChatConversation[];
  onConversationsChange: (conversations: ChatConversation[]) => void;
  onGoToKeys: () => void;
}

const CHAT_MAX_ZIP_BYTES = 25 * 1024 * 1024;
const CHAT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const CHAT_MAX_VIDEO_BYTES = 30 * 1024 * 1024;

interface PendingAttachment {
  id: string;
  file: File;
  kind: 'image' | 'video' | 'zip';
  name: string;
  size: number;
  mimeType: string;
  status: 'processing' | 'ready' | 'error';
  statusLabel: string;
  error?: string;
  previewUrl?: string;
  dataUrl?: string;
  remoteUrl?: string;
  zipData?: ZipParseResponse;
  zipExpanded?: boolean;
  videoMode?: 'native' | 'frames';
  videoFrames?: VideoFrameExtractionResult;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error(`Failed to read "${file.name}".`));
      }
    };
    reader.onerror = () => reject(new Error(`Failed to read "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

function formatContextWindow(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return 'Not specified';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 2)}M tokens`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K tokens`;
  return `${tokens.toLocaleString()} tokens`;
}

export function ChatGeneratorView({
  models,
  syncedAt,
  catalogSyncing,
  catalogStale,
  catalogError,
  onSyncCatalog,
  keys,
  autoRotateEnabled,
  onUpdateKeyVerification,
  conversations,
  onConversationsChange,
  onGoToKeys,
}: ChatGeneratorViewProps) {
  const chatModels = useMemo(
    () => models.filter((m) => m.category === 'chat'),
    [models]
  );

  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const m of chatModels) set.add(m.provider);
    return Array.from(set).sort();
  }, [chatModels]);

  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [modelSearch, setModelSearch] = useState('');
  const [showUnavailableModels, setShowUnavailableModels] = useState(false);

  const [activeConvId, setActiveConvId] = useState<string>(
    () => conversations[0]?.id || ''
  );
  const [convSearch, setConvSearch] = useState('');
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [preferredKeyId, setPreferredKeyId] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperatureStr, setTemperatureStr] = useState('');
  const [maxTokensStr, setMaxTokensStr] = useState('');

  const [promptInput, setPromptInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [streamingText, setStreamingText] = useState<string>('');
  const [processingMessage, setProcessingMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [rotationNotice, setRotationNotice] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const threadContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;

  useEffect(() => {
    return () => {
      for (const att of pendingAttachmentsRef.current) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
    };
  }, []);

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    return chatModels.filter((m) => {
      if (providerFilter !== 'all' && m.provider !== providerFilter) return false;
      if (!showUnavailableModels && m.verificationStatus !== 'VERIFIED') return false;
      if (q && !`${m.title} ${m.id} ${m.provider}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [chatModels, providerFilter, showUnavailableModels, modelSearch]);

  // Sync selected model on catalog load or conversation switch
  useEffect(() => {
    if (chatModels.length === 0) return;
    const activeConv = conversations.find((c) => c.id === activeConvId);
    if (activeConv?.modelId && chatModels.some((m) => m.id === activeConv.modelId)) {
      setSelectedModelId(activeConv.modelId);
      setSystemPrompt(activeConv.systemPrompt || '');
      return;
    }
    setSelectedModelId((prev) => {
      if (prev && chatModels.some((m) => m.id === prev)) return prev;
      const firstVerified = chatModels.find((m) => m.verificationStatus === 'VERIFIED');
      return firstVerified?.id || chatModels[0].id;
    });
  }, [chatModels, activeConvId]);

  // Keep selected model aligned when user changes provider/search/availability filter
  useEffect(() => {
    if (filteredModels.length === 0) return;
    if (!filteredModels.some((m) => m.id === selectedModelId)) {
      const next =
        filteredModels.find((m) => m.verificationStatus === 'VERIFIED') || filteredModels[0];
      if (next) setSelectedModelId(next.id);
    }
  }, [filteredModels, selectedModelId]);

  const activeModel = useMemo(() => {
    if (chatModels.length === 0) return null;
    if (filteredModels.length === 0) {
      return chatModels.find((m) => m.id === selectedModelId) || null;
    }
    return (
      filteredModels.find((m) => m.id === selectedModelId) ||
      filteredModels[0] ||
      null
    );
  }, [chatModels, filteredModels, selectedModelId]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConvId) || null,
    [conversations, activeConvId]
  );

  const filteredConversations = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }, [conversations, convSearch]);

  const selectedKey = useMemo(() => {
    if (preferredKeyId) {
      return keys.find((k) => k.id === preferredKeyId) || null;
    }
    return keys.find((k) => k.isActive) || keys[0] || null;
  }, [keys, preferredKeyId]);

  useEffect(() => {
    const el = threadContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [activeConversation?.messages.length, streamingText]);

  function handleNewConversation() {
    const id = crypto.randomUUID();
    const modelId = activeModel?.id || '';
    const conv: ChatConversation = {
      id,
      title: 'New Conversation',
      modelId,
      systemPrompt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    onConversationsChange([conv, ...conversations]);
    setActiveConvId(id);
    setChatError(null);
    setRotationNotice(null);
  }

  function handleSelectModel(newModelId: string) {
    setSelectedModelId(newModelId);
    setChatError(null);
    // Update the conversation's next-turn modelId WITHOUT touching prior messages' attributions
    if (activeConversation) {
      const next = conversations.map((c) =>
        c.id === activeConversation.id ? { ...c, modelId: newModelId } : c
      );
      onConversationsChange(next);
    }
  }

  function handleDeleteConversation(id: string) {
    const remaining = conversations.filter((c) => c.id !== id);
    onConversationsChange(remaining);
    if (activeConvId === id) {
      setActiveConvId(remaining[0]?.id || '');
    }
  }

  function handleSaveRename(id: string) {
    const clean = editingTitle.trim();
    if (clean) {
      onConversationsChange(
        conversations.map((c) => (c.id === id ? { ...c, title: clean } : c))
      );
    }
    setEditingConvId(null);
  }

  async function handleCopyMessage(msgId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(msgId);
      setTimeout(() => setCopiedMsgId(null), 1800);
    } catch {
      // clipboard fallback ignored
    }
  }

  const keyEligibility = useMemo(() => {
    if (keys.length === 0) {
      return { eligible: false, reason: 'No Kie.ai API keys saved. Add a key in API Key Manager.' };
    }
    if (
      selectedKey &&
      (selectedKey.status === 'Valid' || selectedKey.status === 'Unknown') &&
      (selectedKey.balance === null || selectedKey.balance > 0)
    ) {
      return { eligible: true };
    }
    if (
      selectedKey &&
      (selectedKey.status === 'Insufficient Balance' ||
        (selectedKey.balance !== null && selectedKey.balance <= 0)) &&
      autoRotateEnabled
    ) {
      const fallback = keys.find(
        (k) => k.id !== selectedKey.id && k.status === 'Valid' && (k.balance ?? 0) > 0
      );
      if (fallback) return { eligible: true };
    }
    return {
      eligible: false,
      reason: `Selected key (${selectedKey?.label || 'None'}) has status ${selectedKey?.status || 'Unavailable'}.`,
    };
  }, [keys, selectedKey, autoRotateEnabled]);

  const modelReady =
    Boolean(activeModel) &&
    activeModel?.verificationStatus === 'VERIFIED' &&
    activeModel?.isAvailable &&
    !activeModel?.deprecated &&
    activeModel?.pricingVerified;

  // Adapt pending video mode if the user switches between native-video and vision-only models
  useEffect(() => {
    if (!activeModel) return;
    const caps = activeModel.chatCapabilities;
    const wantsNativeVideo = Boolean(caps?.supportsVideoInput);
    const wantsFrames = !wantsNativeVideo && Boolean(caps?.supportsImageInput);

    for (const att of pendingAttachmentsRef.current) {
      if (att.kind !== 'video') continue;
      if (wantsFrames && !att.videoFrames && att.status !== 'processing') {
        setPendingAttachments((prev) =>
          prev.map((item) =>
            item.id === att.id
              ? {
                  ...item,
                  status: 'processing',
                  videoMode: 'frames',
                  statusLabel: 'Extracting visual keyframes...',
                  error: undefined,
                }
              : item
          )
        );
        void extractVideoKeyframes(att.file, 6)
          .then((framesResult) => {
            setPendingAttachments((prev) =>
              prev.map((item) =>
                item.id === att.id
                  ? {
                      ...item,
                      status: 'ready',
                      videoMode: 'frames',
                      videoFrames: framesResult,
                      statusLabel: `Extracted ${framesResult.frames.length} visual keyframes (no audio)`,
                      error: undefined,
                    }
                  : item
              )
            );
          })
          .catch((err) => {
            setPendingAttachments((prev) =>
              prev.map((item) =>
                item.id === att.id
                  ? {
                      ...item,
                      status: 'error',
                      videoMode: 'frames',
                      statusLabel: 'Frame extraction failed',
                      error:
                        err instanceof Error ? err.message : 'Unable to extract frames from video.',
                    }
                  : item
              )
            );
          });
      } else if (wantsNativeVideo && att.videoMode !== 'native') {
        setPendingAttachments((prev) =>
          prev.map((item) =>
            item.id === att.id
              ? {
                  ...item,
                  videoMode: 'native',
                  status: 'ready',
                  statusLabel: item.remoteUrl
                    ? 'Uploaded to Kie.ai ✓'
                    : 'Local preview ready (uploads to Kie.ai on send)',
                  error: undefined,
                }
              : item
          )
        );
      }
    }
  }, [activeModel?.id]);

  function updatePendingAttachment(id: string, patch: Partial<PendingAttachment>) {
    setPendingAttachments((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  async function processSingleAttachment(att: PendingAttachment) {
    if (att.kind === 'zip') {
      try {
        const zipData = await api.parseChatZip(att.file);
        const textCount = zipData.textFiles.length;
        const imgCount = zipData.images.length;
        const skippedCount = zipData.entries.filter((e) => e.status === 'skipped').length;
        updatePendingAttachment(att.id, {
          status: 'ready',
          zipData,
          statusLabel: `Extracted: ${textCount} text/code · ${imgCount} image(s)${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}`,
          error: undefined,
        });
      } catch (err) {
        updatePendingAttachment(att.id, {
          status: 'error',
          statusLabel: 'ZIP validation failed',
          error: err instanceof Error ? err.message : 'Unable to read ZIP archive.',
        });
      }
      return;
    }

    if (att.kind === 'image') {
      try {
        const dataUrl = await readFileAsDataUrl(att.file);
        if (selectedKey?.apiKey && activeModel?.chatCapabilities?.supportsImageInput !== false) {
          updatePendingAttachment(att.id, {
            dataUrl,
            status: 'processing',
            statusLabel: 'Uploading image to Kie.ai...',
          });
          const uploaded = await api.uploadChatMediaFile(selectedKey.apiKey, att.file);
          updatePendingAttachment(att.id, {
            dataUrl,
            remoteUrl: uploaded.fileUrl,
            mimeType: uploaded.mimeType,
            status: 'ready',
            statusLabel: 'Uploaded to Kie.ai ✓',
            error: undefined,
          });
        } else {
          updatePendingAttachment(att.id, {
            dataUrl,
            status: 'ready',
            statusLabel: 'Local preview ready',
            error: undefined,
          });
        }
      } catch (err) {
        updatePendingAttachment(att.id, {
          status: 'error',
          statusLabel: 'Image upload failed',
          error: err instanceof Error ? err.message : 'Unable to process image attachment.',
        });
      }
      return;
    }

    // Video
    const caps = activeModel?.chatCapabilities;
    if (caps?.supportsVideoInput) {
      if (selectedKey?.apiKey) {
        try {
          updatePendingAttachment(att.id, {
            videoMode: 'native',
            status: 'processing',
            statusLabel: 'Uploading video to Kie.ai...',
          });
          const uploaded = await api.uploadChatMediaFile(selectedKey.apiKey, att.file);
          updatePendingAttachment(att.id, {
            videoMode: 'native',
            remoteUrl: uploaded.fileUrl,
            mimeType: uploaded.mimeType,
            status: 'ready',
            statusLabel: 'Uploaded to Kie.ai ✓',
            error: undefined,
          });
        } catch (err) {
          updatePendingAttachment(att.id, {
            videoMode: 'native',
            status: 'error',
            statusLabel: 'Video upload failed',
            error: err instanceof Error ? err.message : 'Unable to upload video to Kie.ai.',
          });
        }
      } else {
        updatePendingAttachment(att.id, {
          videoMode: 'native',
          status: 'ready',
          statusLabel: 'Local preview ready (API key required to upload)',
          error: undefined,
        });
      }
      return;
    }

    if (caps?.supportsImageInput) {
      try {
        updatePendingAttachment(att.id, {
          videoMode: 'frames',
          status: 'processing',
          statusLabel: 'Extracting visual keyframes...',
        });
        const framesResult = await extractVideoKeyframes(att.file, 6);
        updatePendingAttachment(att.id, {
          videoMode: 'frames',
          videoFrames: framesResult,
          status: 'ready',
          statusLabel: `Extracted ${framesResult.frames.length} visual keyframes (no audio)`,
          error: undefined,
        });
      } catch (err) {
        updatePendingAttachment(att.id, {
          videoMode: 'frames',
          status: 'error',
          statusLabel: 'Frame extraction failed',
          error: err instanceof Error ? err.message : 'Unable to extract video frames.',
        });
      }
      return;
    }

    updatePendingAttachment(att.id, {
      status: 'ready',
      statusLabel: 'Local preview ready',
      error: undefined,
    });
  }

  function handleAttachFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setChatError(null);

    const newItems: PendingAttachment[] = [];
    const immediateErrors: string[] = [];
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    const videoExts = new Set(['.mp4', '.mov', '.webm']);

    for (const file of Array.from(fileList)) {
      const ext = getFileExtension(file.name);
      if (ext === '.zip') {
        if (file.size <= 0 || file.size > CHAT_MAX_ZIP_BYTES) {
          immediateErrors.push(`ZIP "${file.name}" must be between 1 B and 25 MB.`);
          continue;
        }
        newItems.push({
          id: crypto.randomUUID(),
          file,
          kind: 'zip',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/zip',
          status: 'processing',
          statusLabel: 'Validating & extracting ZIP...',
          zipExpanded: true,
        });
      } else if (imageExts.has(ext)) {
        if (file.size <= 0 || file.size > CHAT_MAX_IMAGE_BYTES) {
          immediateErrors.push(`Image "${file.name}" must be between 1 B and 15 MB.`);
          continue;
        }
        newItems.push({
          id: crypto.randomUUID(),
          file,
          kind: 'image',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'image/png',
          status: 'processing',
          statusLabel: 'Reading image...',
          previewUrl: URL.createObjectURL(file),
        });
      } else if (videoExts.has(ext)) {
        if (file.size <= 0 || file.size > CHAT_MAX_VIDEO_BYTES) {
          immediateErrors.push(`Video "${file.name}" must be between 1 B and 30 MB.`);
          continue;
        }
        newItems.push({
          id: crypto.randomUUID(),
          file,
          kind: 'video',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'video/mp4',
          status: 'processing',
          statusLabel: 'Inspecting video...',
          previewUrl: URL.createObjectURL(file),
        });
      } else {
        immediateErrors.push(
          `Unsupported file "${file.name}". Allowed: ZIP (.zip), Images (.jpg, .jpeg, .png, .webp), Videos (.mp4, .mov, .webm).`
        );
      }
    }

    if (immediateErrors.length > 0) {
      setChatError(immediateErrors.join(' '));
    }

    if (newItems.length > 0) {
      setPendingAttachments((prev) => [...prev, ...newItems]);
      for (const item of newItems) {
        void processSingleAttachment(item);
      }
    }
  }

  const attachmentCompatibilityIssue = useMemo(() => {
    if (pendingAttachments.length === 0) return null;
    if (pendingAttachments.some((a) => a.status === 'processing')) {
      return 'Wait for attachment inspection/upload to finish before sending.';
    }
    const failed = pendingAttachments.find((a) => a.status === 'error');
    if (failed) {
      return failed.error || `Fix or remove "${failed.name}" before sending.`;
    }
    if (!activeModel) return null;

    const caps = activeModel.chatCapabilities;
    let totalMediaItems = 0;

    for (const att of pendingAttachments) {
      if (att.kind === 'image') {
        if (!caps?.supportsImageInput) {
          return `"${activeModel.title}" does not support image input. Switch to OpenAI, Gemini, Grok, DeepSeek, or Kimi, or remove "${att.name}".`;
        }
        totalMediaItems += 1;
      } else if (att.kind === 'video') {
        if (!caps?.supportsVideoInput && !caps?.supportsImageInput) {
          return `"${activeModel.title}" does not support video or visual frame input. Select Gemini (native video) or a vision model for keyframes.`;
        }
        totalMediaItems += caps?.supportsVideoInput ? 1 : att.videoFrames?.frames.length || 0;
      } else if (att.kind === 'zip' && att.zipData) {
        const hasText = att.zipData.textFiles.length > 0;
        const imgCount = att.zipData.images.length;
        if (!hasText && imgCount === 0) {
          return `ZIP "${att.name}" contains no readable text/code or image files.`;
        }
        if (imgCount > 0 && !caps?.supportsImageInput && !hasText) {
          return `ZIP "${att.name}" only contains images, and "${activeModel.title}" does not support image input.`;
        }
        if (caps?.supportsImageInput) {
          totalMediaItems += imgCount;
        }
      }
    }

    const maxFiles = caps?.maxFilesPerMessage ?? 10;
    if (totalMediaItems > maxFiles) {
      return `Too many visual attachments (${totalMediaItems}). "${activeModel.title}" supports at most ${maxFiles} media items per message.`;
    }
    return null;
  }, [pendingAttachments, activeModel]);

  const canSend =
    (Boolean(promptInput.trim()) || pendingAttachments.length > 0) &&
    Boolean(modelReady) &&
    keyEligibility.eligible &&
    !attachmentCompatibilityIssue &&
    !sending;

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend || !activeModel) return;

    const currentAttachments = [...pendingAttachments];
    const userText =
      promptInput.trim() || 'Please inspect and analyze the attached file(s) in detail.';

    setChatError(null);
    setRotationNotice(null);
    setSending(true);
    setStreamingText('');

    const candidates = getCandidateKeysInOrder(keys, preferredKeyId || undefined);
    const primaryKey = candidates[0];

    // Ensure any un-uploaded image or native video is actually uploaded to Kie.ai before claiming success
    const preparedAttachments: PendingAttachment[] = [];
    try {
      for (const att of currentAttachments) {
        if (
          att.kind === 'image' &&
          !att.remoteUrl &&
          activeModel.chatProtocol !== 'gemini-native'
        ) {
          if (!primaryKey?.apiKey) {
            throw new Error(`No API key available to upload "${att.name}".`);
          }
          updatePendingAttachment(att.id, {
            status: 'processing',
            statusLabel: 'Uploading image to Kie.ai...',
          });
          const uploaded = await api.uploadChatMediaFile(primaryKey.apiKey, att.file);
          const updatedAtt: PendingAttachment = {
            ...att,
            remoteUrl: uploaded.fileUrl,
            mimeType: uploaded.mimeType,
            status: 'ready',
            statusLabel: 'Uploaded to Kie.ai ✓',
          };
          updatePendingAttachment(att.id, updatedAtt);
          preparedAttachments.push(updatedAtt);
        } else if (
          att.kind === 'video' &&
          activeModel.chatCapabilities?.supportsVideoInput &&
          !att.remoteUrl
        ) {
          if (!primaryKey?.apiKey) {
            throw new Error(`No API key available to upload video "${att.name}".`);
          }
          updatePendingAttachment(att.id, {
            status: 'processing',
            statusLabel: 'Uploading video to Kie.ai...',
          });
          const uploaded = await api.uploadChatMediaFile(primaryKey.apiKey, att.file);
          const updatedAtt: PendingAttachment = {
            ...att,
            videoMode: 'native',
            remoteUrl: uploaded.fileUrl,
            mimeType: uploaded.mimeType,
            status: 'ready',
            statusLabel: 'Uploaded to Kie.ai ✓',
          };
          updatePendingAttachment(att.id, updatedAtt);
          preparedAttachments.push(updatedAtt);
        } else {
          preparedAttachments.push(att);
        }
      }
    } catch (uploadErr) {
      const msg =
        uploadErr instanceof Error ? uploadErr.message : 'Failed to upload attachment to Kie.ai.';
      setChatError(msg);
      setSending(false);
      return;
    }

    // Build wire payloads & lightweight persistent metadata (never store base64 in localStorage)
    const wireAttachments: ChatAttachmentPayload[] = [];
    const messageAttachmentMetas: ChatMessageAttachmentMeta[] = [];

    for (const att of preparedAttachments) {
      if (att.kind === 'image') {
        wireAttachments.push({
          kind: 'image',
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          remoteUrl: att.remoteUrl,
          dataUrl: att.dataUrl,
        });
        messageAttachmentMetas.push({
          kind: 'image',
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          remoteUrl: att.remoteUrl,
        });
      } else if (att.kind === 'video') {
        if (activeModel.chatCapabilities?.supportsVideoInput && att.remoteUrl) {
          wireAttachments.push({
            kind: 'video',
            name: att.name,
            mimeType: att.mimeType,
            size: att.size,
            remoteUrl: att.remoteUrl,
          });
          messageAttachmentMetas.push({
            kind: 'video',
            name: att.name,
            mimeType: att.mimeType,
            size: att.size,
            remoteUrl: att.remoteUrl,
            note: 'Native video input',
          });
        } else if (att.videoFrames) {
          wireAttachments.push({
            kind: 'video-frames',
            name: att.name,
            mimeType: att.mimeType,
            size: att.size,
            frameImages: att.videoFrames.frames.map((f) => ({
              label: f.label,
              mimeType: f.mimeType,
              dataUrl: f.dataUrl,
            })),
          });
          messageAttachmentMetas.push({
            kind: 'video-frames',
            name: att.name,
            mimeType: att.mimeType,
            size: att.size,
            frameCount: att.videoFrames.frames.length,
            note: `${att.videoFrames.frames.length} visual keyframes extracted (visual only, no audio track)`,
          });
        }
      } else if (att.kind === 'zip' && att.zipData) {
        const allowImages = Boolean(activeModel.chatCapabilities?.supportsImageInput);
        wireAttachments.push({
          kind: 'zip',
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          zipSummary: att.zipData.summaryText,
          frameImages: allowImages
            ? att.zipData.images.map((img) => ({
                label: img.path,
                mimeType: img.mimeType,
                dataUrl: img.dataUrl,
              }))
            : [],
        });
        messageAttachmentMetas.push({
          kind: 'zip',
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          zipFileCount: att.zipData.totalEntries,
          note: `${att.zipData.textFiles.length} text/code · ${att.zipData.images.length} images`,
        });
      }
    }

    // Clear composer only once validated & uploaded
    setPromptInput('');
    for (const att of currentAttachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setPendingAttachments([]);

    const now = Date.now();
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      createdAt: now,
      modelId: activeModel.id,
      modelTitle: activeModel.title,
      provider: activeModel.provider,
      attachments: messageAttachmentMetas.length > 0 ? messageAttachmentMetas : undefined,
    };

    // Ensure conversation exists
    let targetConv = activeConversation;
    let workingConversations = [...conversations];
    const titleSeed =
      promptInput.trim() ||
      (messageAttachmentMetas[0] ? `Analyze ${messageAttachmentMetas[0].name}` : 'File Analysis');

    if (!targetConv) {
      const autoTitle = titleSeed.slice(0, 44) + (titleSeed.length > 44 ? '…' : '');
      targetConv = {
        id: crypto.randomUUID(),
        title: autoTitle,
        modelId: activeModel.id,
        systemPrompt,
        createdAt: now,
        updatedAt: now,
        messages: [userMsg],
      };
      workingConversations = [targetConv, ...workingConversations];
      setActiveConvId(targetConv.id);
    } else {
      const newTitle =
        targetConv.messages.length === 0 && targetConv.title === 'New Conversation'
          ? titleSeed.slice(0, 44) + (titleSeed.length > 44 ? '…' : '')
          : targetConv.title;
      targetConv = {
        ...targetConv,
        title: newTitle,
        modelId: activeModel.id,
        systemPrompt,
        updatedAt: now,
        messages: [...targetConv.messages, userMsg],
      };
      workingConversations = workingConversations.map((c) =>
        c.id === targetConv!.id ? targetConv! : c
      );
    }
    onConversationsChange(workingConversations);

    const historyForApi = targetConv.messages.map((m, idx) => {
      const isLatestTurn = idx === targetConv!.messages.length - 1;
      if (isLatestTurn && wireAttachments.length > 0) {
        return {
          role: m.role,
          content: m.content,
          attachments: wireAttachments,
        };
      }
      if (m.attachments && m.attachments.length > 0) {
        const attachmentLabel = m.attachments
          .map((a) => `${a.name} (${a.kind}${a.note ? `, ${a.note}` : ''})`)
          .join('; ');
        return {
          role: m.role,
          content: `${m.content}\n[Previously attached files: ${attachmentLabel}]`,
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });

    const parsedTemp = temperatureStr.trim() ? Number(temperatureStr) : undefined;
    const parsedMaxTok = maxTokensStr.trim() ? Number(maxTokensStr) : undefined;
    const maxAttempts = autoRotateEnabled ? candidates.length : 1;
    const baseReqId = crypto.randomUUID();

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;

    try {
      let rotatedFromLabel: string | null = null;
      let completedMsg: ChatMessage | null = null;

      for (let i = 0; i < maxAttempts; i++) {
        const candidate = candidates[i];
        setStreamingText('');
        setProcessingMessage(
          activeModel.supportsStreaming === false
            ? `Processing non-streaming response from ${activeModel.title}...`
            : null
        );

        const res = await api.sendChatStream({
          apiKey: candidate.apiKey,
          clientRequestId: `${baseReqId}_${i}`,
          modelId: activeModel.id,
          messages: historyForApi,
          systemPrompt: systemPrompt.trim() || undefined,
          temperature:
            parsedTemp !== undefined && Number.isFinite(parsedTemp) ? parsedTemp : undefined,
          maxTokens:
            parsedMaxTok !== undefined && Number.isFinite(parsedMaxTok) ? parsedMaxTok : undefined,
          signal: abortCtrl.signal,
          onDelta: (accumulated) => {
            setProcessingMessage(null);
            setStreamingText(accumulated);
          },
          onProcessing: (msg) => {
            setProcessingMessage(msg);
          },
        });

        if (typeof res.verifiedBalance === 'number' || res.keyStatus) {
          onUpdateKeyVerification(candidate.id, {
            status: res.keyStatus || (res.ok ? 'Valid' : candidate.status),
            balance:
              typeof res.verifiedBalance === 'number' ? res.verifiedBalance : candidate.balance,
            lastError: res.ok ? null : res.error || null,
          });
        }
        if (typeof res.updatedBalance === 'number') {
          onUpdateKeyVerification(candidate.id, {
            status: res.updatedKeyStatus || (res.updatedBalance > 0 ? 'Valid' : 'Insufficient Balance'),
            balance: res.updatedBalance,
            lastError: null,
          });
        }

        if (res.ok) {
          if (rotatedFromLabel && rotatedFromLabel !== candidate.label) {
            setRotationNotice(
              `Automatic rotation: "${rotatedFromLabel}" had insufficient credits. Responded using "${candidate.label}" (${candidate.maskedKey}).`
            );
          }
          completedMsg = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: res.text,
            createdAt: Date.now(),
            modelId: activeModel.id,
            modelTitle: activeModel.title,
            provider: activeModel.provider,
            keyLabelUsed: candidate.label,
            maskedKeyUsed: candidate.maskedKey,
            usage: res.usage ?? null,
          };
          break;
        }

        // Only rotate automatically on insufficient credits before streaming started
        if (res.insufficientCredits && autoRotateEnabled && i < maxAttempts - 1) {
          if (!rotatedFromLabel) rotatedFromLabel = candidate.label;
          continue;
        }

        // Non-credit error or exhausted keys: record failure clearly, NEVER switch model silently
        const errText = res.error || 'Kie.ai rejected the chat request.';
        setChatError(errText);
        completedMsg = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: res.text || '',
          createdAt: Date.now(),
          modelId: activeModel.id,
          modelTitle: activeModel.title,
          provider: activeModel.provider,
          keyLabelUsed: candidate.label,
          maskedKeyUsed: candidate.maskedKey,
          usage: res.usage ?? null,
          error: errText,
        };
        break;
      }

      if (completedMsg) {
        const finalConvs = workingConversations.map((c) =>
          c.id === targetConv!.id
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: [...c.messages, completedMsg!],
              }
            : c
        );
        onConversationsChange(finalConvs);
      } else if (!chatError) {
        setChatError('All saved API keys have insufficient credits.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chat request interrupted.';
      setChatError(msg);
    } finally {
      abortControllerRef.current = null;
      setStreamingText('');
      setProcessingMessage(null);
      setSending(false);
    }
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#C5A45A]/30 pb-5">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold tracking-tight text-[#170D2B] sm:text-2xl">
            Chat Generator
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#40205E]/80 tabular-nums">
            <span>{chatModels.filter((m) => m.verificationStatus === 'VERIFIED').length} verified chat models</span>
            <span aria-hidden="true" className="text-[#C5A45A]">·</span>
            <span>{providers.length} providers</span>
            <span aria-hidden="true" className="text-[#C5A45A]">·</span>
            <span>
              Catalog synced:{' '}
              {syncedAt
                ? new Date(syncedAt).toLocaleString()
                : catalogSyncing
                  ? 'Syncing...'
                  : 'Failed'}
            </span>
            {catalogStale && (
              <>
                <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                <span className="font-mono font-semibold text-amber-700">STALE</span>
              </>
            )}
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <button
            type="button"
            onClick={handleNewConversation}
            className="inline-flex min-h-[42px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#C5A45A] bg-[#C5A45A] px-3.5 py-2 text-xs font-bold text-[#170D2B] shadow-2xs transition-colors hover:bg-[#b5944c] whitespace-nowrap sm:flex-initial"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            <span>New Conversation</span>
          </button>
          <button
            type="button"
            onClick={onSyncCatalog}
            disabled={catalogSyncing}
            className="inline-flex min-h-[42px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#40205E]/25 bg-white px-3.5 py-2 text-xs font-semibold text-[#40205E] transition-colors hover:border-[#C5A45A] hover:bg-[#FAF6EC] disabled:opacity-50 whitespace-nowrap sm:flex-initial"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-[#C5A45A] ${catalogSyncing ? 'animate-spin' : ''}`} />
            <span>Sync Catalog</span>
          </button>
        </div>
      </div>

      {catalogError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              {chatModels.length > 0
                ? `Live catalog sync warning (${catalogError}). Showing last verified chat models.`
                : `Chat catalog synchronization failed: ${catalogError}`}
            </span>
          </div>
          <button
            type="button"
            onClick={onSyncCatalog}
            disabled={catalogSyncing}
            className="min-h-[36px] rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            Retry Sync
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-12">
        {/* Left Sidebar: Conversations */}
        <aside className="min-w-0 space-y-3 lg:col-span-3">
          <div className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xs font-bold uppercase tracking-wider text-[#40205E]">
                Conversations ({conversations.length})
              </h2>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[#7650A6]" />
              <input
                type="search"
                value={convSearch}
                onChange={(e) => setConvSearch(e.target.value)}
                placeholder="Search conversations..."
                className="min-h-[40px] w-full rounded-lg border border-[#40205E]/20 bg-[#FAF6EC]/60 py-1.5 pr-2.5 pl-8 text-xs text-[#170D2B] placeholder:text-[#7650A6]/65 focus:border-[#7650A6] focus:bg-white focus:outline-none"
              />
            </div>

            <div className="max-h-[220px] space-y-1.5 overflow-y-auto lg:max-h-[520px]">
              {filteredConversations.length === 0 ? (
                <p className="py-5 text-center text-xs text-[#40205E]/70">
                  No conversations yet. Send a message to start.
                </p>
              ) : (
                filteredConversations.map((c) => {
                  const isActive = c.id === activeConversation?.id;
                  return (
                    <div
                      key={c.id}
                      className={`group rounded-lg border px-3 py-2 text-xs transition-colors ${
                        isActive
                          ? 'border-[#C5A45A] bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                          : 'border-[#C5A45A]/20 bg-[#FAF6EC]/50 text-[#170D2B] hover:border-[#C5A45A]/60 hover:bg-[#FAF6EC]'
                      }`}
                    >
                      {editingConvId === c.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveRename(c.id);
                              if (e.key === 'Escape') setEditingConvId(null);
                            }}
                            autoFocus
                            className="min-h-[34px] w-full rounded border border-[#40205E]/30 bg-white px-2 py-0.5 text-xs text-[#170D2B]"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveRename(c.id)}
                            className="min-h-[34px] rounded bg-emerald-600 px-2 text-white"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveConvId(c.id);
                              setSystemPrompt(c.systemPrompt || '');
                              if (c.modelId) setSelectedModelId(c.modelId);
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="truncate font-semibold">{c.title}</div>
                            <div
                              className={`mt-0.5 truncate font-mono text-[10px] ${
                                isActive ? 'text-[#F4E8C9]/80' : 'text-[#40205E]/70'
                              }`}
                            >
                              {c.messages.length} msgs · {c.modelId}
                            </div>
                          </button>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              aria-label="Rename conversation"
                              onClick={() => {
                                setEditingConvId(c.id);
                                setEditingTitle(c.title);
                              }}
                              className={`rounded p-1.5 ${
                                isActive ? 'hover:bg-[#170D2B]/40' : 'hover:bg-[#F4E8C9]'
                              }`}
                            >
                              <Edit3 className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              aria-label="Delete conversation"
                              onClick={() => handleDeleteConversation(c.id)}
                              className={`rounded p-1.5 ${
                                isActive
                                  ? 'text-red-300 hover:bg-[#170D2B]/40'
                                  : 'text-red-600 hover:bg-red-50'
                              }`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        {/* Main Chat Workspace */}
        <div className="min-w-0 space-y-4 lg:col-span-9">
          {/* Model & Pricing Control Card */}
          <div className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] space-y-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setProviderFilter('all')}
                  className={`min-h-[36px] rounded-lg border px-3 py-1 text-xs font-semibold transition-colors ${
                    providerFilter === 'all'
                      ? 'border-[#40205E] bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                      : 'border-[#40205E]/20 bg-white text-[#170D2B] hover:border-[#C5A45A] hover:bg-[#FAF6EC]'
                  }`}
                >
                  All Providers
                </button>
                {providers.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProviderFilter(p)}
                    className={`min-h-[36px] rounded-lg border px-3 py-1 text-xs font-semibold transition-colors ${
                      providerFilter === p
                        ? 'border-[#40205E] bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                        : 'border-[#40205E]/20 bg-white text-[#170D2B] hover:border-[#C5A45A] hover:bg-[#FAF6EC]'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>

              <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-2 text-xs font-medium text-[#40205E]">
                <input
                  type="checkbox"
                  checked={showUnavailableModels}
                  onChange={(e) => setShowUnavailableModels(e.target.checked)}
                  className="h-4 w-4 rounded border-[#40205E]/30 accent-[#40205E]"
                />
                <span>Show Unavailable / Deprecated</span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="min-w-0 md:col-span-3">
                <label htmlFor="chat-model-search" className="block text-xs font-semibold text-[#170D2B]">
                  Search Models
                </label>
                <input
                  id="chat-model-search"
                  type="search"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="GPT, Claude, Gemini..."
                  className="mt-1.5 min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
                />
              </div>

              <div className="min-w-0 md:col-span-5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="chat-model-select" className="block text-xs font-semibold text-[#170D2B]">
                    Chat Model ({filteredModels.length})
                  </label>
                  {chatModels.length > 0 && filteredModels.length === 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setProviderFilter('all');
                        setModelSearch('');
                        setShowUnavailableModels(true);
                      }}
                      className="text-[11px] font-semibold text-[#7650A6] hover:underline"
                    >
                      Reset filters
                    </button>
                  )}
                </div>
                <select
                  id="chat-model-select"
                  value={filteredModels.length > 0 ? activeModel?.id || '' : ''}
                  onChange={(e) => handleSelectModel(e.target.value)}
                  disabled={filteredModels.length === 0}
                  className="mt-1.5 min-h-[42px] w-full max-w-full min-w-0 rounded-lg border border-[#40205E]/30 bg-white px-3 py-2 text-xs font-semibold text-[#170D2B] focus:border-[#7650A6] focus:outline-none disabled:bg-[#FAF6EC] disabled:text-[#40205E]/50 sm:text-sm"
                >
                  {chatModels.length === 0 ? (
                    <option value="">
                      {catalogSyncing
                        ? 'Synchronizing verified chat models...'
                        : 'No verified chat models loaded'}
                    </option>
                  ) : filteredModels.length === 0 ? (
                    <option value="">
                      No chat models match current filter
                    </option>
                  ) : (
                    filteredModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        [{m.provider}] {m.title} ({m.id}) —{' '}
                        {m.verificationStatus === 'VERIFIED' && m.chatPricing
                          ? `${m.chatPricing.inputCreditsPerMillion} / ${m.chatPricing.outputCreditsPerMillion} cr/1M`
                          : `[${m.verificationStatus}]`}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="min-w-0 md:col-span-4">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="chat-key-select" className="block text-xs font-semibold text-[#170D2B]">
                    API Key
                  </label>
                  <button
                    type="button"
                    onClick={onGoToKeys}
                    className="text-[11px] font-semibold text-[#7650A6] hover:text-[#40205E] hover:underline"
                  >
                    Manage ({keys.length}/10)
                  </button>
                </div>
                <select
                  id="chat-key-select"
                  value={preferredKeyId}
                  onChange={(e) => setPreferredKeyId(e.target.value)}
                  className="mt-1.5 min-h-[42px] w-full max-w-full min-w-0 rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs text-[#170D2B] focus:border-[#7650A6] focus:outline-none"
                >
                  <option value="">
                    Active ({selectedKey ? `${selectedKey.label} · ${selectedKey.balance ?? '—'} cr` : 'None'})
                  </option>
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label} ({k.maskedKey}) — {k.balance !== null ? `${k.balance} cr` : k.status}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Verified Model Metadata & Token Rates */}
            {activeModel && (
              <div className="border-t border-[#C5A45A]/20 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#40205E]/80">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-bold text-[#40205E]">{activeModel.provider}</span>
                    <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                    <span className="font-mono text-[#170D2B] break-all">{activeModel.id}</span>
                    <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                    <span
                      className={`font-mono font-bold ${
                        activeModel.verificationStatus === 'VERIFIED'
                          ? 'text-emerald-700'
                          : 'text-red-700'
                      }`}
                    >
                      {activeModel.verificationStatus}
                    </span>
                    <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                    <span className="font-mono text-[11px] break-all">{activeModel.endpointPath}</span>
                    <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                    <span className="text-[11px] text-[#40205E]/75">
                      {activeModel.supportsStreaming === false ? 'Non-streaming' : 'Streaming'}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-[11px] text-[#40205E]/75">
                      Context: <strong className="text-[#170D2B]">{formatContextWindow(activeModel.contextWindow)}</strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowSettings((s) => !s)}
                      className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-[#40205E]/20 bg-[#FAF6EC]/60 px-2.5 py-1 text-[11px] font-semibold text-[#40205E] hover:border-[#C5A45A] hover:bg-[#F4E8C9]"
                    >
                      <SlidersHorizontal className="h-3 w-3 text-[#C5A45A]" />
                      <span>System &amp; Params</span>
                    </button>
                    <a
                      href={activeModel.docUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#7650A6] hover:text-[#40205E]"
                    >
                      <span>Docs</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>

                {activeModel.pricingVerified && activeModel.chatPricing ? (
                  <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-[#170D2B] tabular-nums">
                    <span>
                      Input: <strong>{activeModel.chatPricing.inputCreditsPerMillion} cr/1M</strong>
                    </span>
                    <span>
                      Output: <strong>{activeModel.chatPricing.outputCreditsPerMillion} cr/1M</strong>
                    </span>
                    {activeModel.chatPricing.cachedInputCreditsPerMillion !== null && (
                      <span>
                        Cached Input: <strong>{activeModel.chatPricing.cachedInputCreditsPerMillion} cr/1M</strong>
                      </span>
                    )}
                    {activeModel.chatPricing.cacheWriteCreditsPerMillion !== null && (
                      <span>
                        Cache Write: <strong>{activeModel.chatPricing.cacheWriteCreditsPerMillion} cr/1M</strong>
                      </span>
                    )}
                    {activeModel.chatPricing.reasoningCreditsPerMillion !== null && (
                      <span>
                        Reasoning: <strong>{activeModel.chatPricing.reasoningCreditsPerMillion} cr/1M</strong>
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {activeModel.unavailableReason ||
                      activeModel.pricingUnavailableReason ||
                      'Pricing unavailable — chat model temporarily disabled.'}
                  </div>
                )}

                {activeModel.chatCapabilities && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#40205E]/80">
                    <span>
                      Attachments:{' '}
                      <strong className="text-[#170D2B]">ZIP (text/code) ✓</strong>
                    </span>
                    <span>
                      Images:{' '}
                      <strong
                        className={
                          activeModel.chatCapabilities.supportsImageInput
                            ? 'text-emerald-700'
                            : 'text-[#40205E]/60'
                        }
                      >
                        {activeModel.chatCapabilities.supportsImageInput ? 'Supported ✓' : 'Not supported'}
                      </strong>
                    </span>
                    <span>
                      Video:{' '}
                      <strong
                        className={
                          activeModel.chatCapabilities.supportsVideoInput
                            ? 'text-emerald-700'
                            : activeModel.chatCapabilities.supportsImageInput
                              ? 'text-amber-700'
                              : 'text-[#40205E]/60'
                        }
                      >
                        {activeModel.chatCapabilities.supportsVideoInput
                          ? 'Native Video + Audio ✓'
                          : activeModel.chatCapabilities.supportsImageInput
                            ? 'Visual keyframes only (no audio)'
                            : 'Not supported'}
                      </strong>
                    </span>
                  </div>
                )}

                {showSettings && (
                  <div className="mt-3 grid grid-cols-1 gap-3 border-t border-[#C5A45A]/20 pt-3 sm:grid-cols-12">
                    <div className="sm:col-span-6">
                      <label className="block text-[11px] font-semibold text-[#170D2B]">
                        System Instructions (Optional)
                      </label>
                      <input
                        type="text"
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        placeholder="You are a concise technical assistant..."
                        className="mt-1 min-h-[38px] w-full rounded-lg border border-[#40205E]/25 bg-white px-2.5 py-1.5 text-xs text-[#170D2B]"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="block text-[11px] font-semibold text-[#170D2B]">
                        Temperature
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        value={temperatureStr}
                        onChange={(e) => setTemperatureStr(e.target.value)}
                        placeholder="Default"
                        className="mt-1 min-h-[38px] w-full rounded-lg border border-[#40205E]/25 bg-white px-2.5 py-1.5 font-mono text-xs text-[#170D2B]"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="block text-[11px] font-semibold text-[#170D2B]">
                        Max Output Tokens
                      </label>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={maxTokensStr}
                        onChange={(e) => setMaxTokensStr(e.target.value)}
                        placeholder="Default"
                        className="mt-1 min-h-[38px] w-full rounded-lg border border-[#40205E]/25 bg-white px-2.5 py-1.5 font-mono text-xs text-[#170D2B]"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Message Thread */}
          <div className="overflow-hidden rounded-xl border border-[#C5A45A]/35 bg-white shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)]">
            <div
              ref={threadContainerRef}
              className="max-h-[460px] min-h-[280px] space-y-4 overflow-y-auto p-4 sm:p-5"
            >
              {(!activeConversation || activeConversation.messages.length === 0) && !sending ? (
                <div className="flex h-52 flex-col items-center justify-center px-3 text-center">
                  <p className="font-display text-sm font-bold text-[#170D2B]">
                    Start a real Kie.ai chat session
                  </p>
                  <p className="mt-1.5 max-w-md text-xs text-[#40205E]/75">
                    Select any verified model from OpenAI, Anthropic, Google, xAI, DeepSeek, or Moonshot. You can switch models at any time without altering earlier message attributions.
                  </p>
                </div>
              ) : (
                <>
                  {activeConversation?.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`rounded-xl border p-3.5 sm:p-4 ${
                        msg.role === 'user'
                          ? 'ml-auto max-w-3xl border-[#C5A45A]/45 bg-[#FAF6EC]'
                          : 'border-[#40205E]/15 bg-white'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C5A45A]/20 pb-2 text-[11px] text-[#40205E]/75">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="font-bold text-[#170D2B]">
                            {msg.role === 'user' ? 'You' : msg.modelTitle}
                          </span>
                          {msg.role === 'assistant' && (
                            <>
                              <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                              <span className="font-semibold text-[#40205E]">{msg.provider}</span>
                              <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                              <span className="font-mono break-all">{msg.modelId}</span>
                              {msg.keyLabelUsed && (
                                <>
                                  <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                                  <span className="font-mono">{msg.keyLabelUsed}</span>
                                </>
                              )}
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">
                            {new Date(msg.createdAt).toLocaleTimeString()}
                          </span>
                          {msg.role === 'assistant' && msg.content && (
                            <button
                              type="button"
                              onClick={() => void handleCopyMessage(msg.id, msg.content)}
                              className="inline-flex min-h-[28px] items-center gap-1 rounded-md border border-[#40205E]/20 bg-white px-2 py-0.5 text-[11px] font-semibold text-[#40205E] hover:bg-[#FAF6EC]"
                            >
                              {copiedMsgId === msg.id ? (
                                <>
                                  <Check className="h-3 w-3 text-emerald-600" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {msg.attachments.map((att, idx) => (
                            <div
                              key={`${msg.id}_att_${idx}`}
                              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[#C5A45A]/35 bg-white px-2.5 py-1 text-[11px] text-[#170D2B]"
                            >
                              {att.kind === 'zip' ? (
                                <FileArchive className="h-3.5 w-3.5 shrink-0 text-[#C5A45A]" />
                              ) : att.kind === 'image' ? (
                                <FileImage className="h-3.5 w-3.5 shrink-0 text-[#7650A6]" />
                              ) : (
                                <FileVideo className="h-3.5 w-3.5 shrink-0 text-[#40205E]" />
                              )}
                              <span className="truncate font-semibold text-[#170D2B]">{att.name}</span>
                              <span className="shrink-0 font-mono text-[#40205E]/70">
                                ({formatFileSize(att.size)})
                              </span>
                              {att.note && (
                                <span className="truncate text-[#40205E]/70">· {att.note}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {msg.error ? (
                        <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 break-words">{msg.error}</span>
                        </div>
                      ) : (
                        <div className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#170D2B]">
                          {msg.content}
                        </div>
                      )}

                      {msg.role === 'assistant' && !msg.error && (
                        <div className="mt-3 border-t border-[#C5A45A]/20 pt-2 font-mono text-[11px] text-[#40205E]/75 tabular-nums">
                          {msg.usage &&
                          (msg.usage.inputTokens !== null ||
                            msg.usage.outputTokens !== null ||
                            msg.usage.creditsConsumed !== null ||
                            msg.usage.calculatedCredits !== null) ? (
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                              {msg.usage.inputTokens !== null && (
                                <span>Input: {msg.usage.inputTokens.toLocaleString()} tok</span>
                              )}
                              {msg.usage.outputTokens !== null && (
                                <span>Output: {msg.usage.outputTokens.toLocaleString()} tok</span>
                              )}
                              {msg.usage.cachedTokens !== null && msg.usage.cachedTokens > 0 && (
                                <span>Cached: {msg.usage.cachedTokens.toLocaleString()} tok</span>
                              )}
                              {msg.usage.reasoningTokens !== null && msg.usage.reasoningTokens > 0 && (
                                <span>Reasoning: {msg.usage.reasoningTokens.toLocaleString()} tok</span>
                              )}
                              {msg.usage.creditsConsumed !== null ? (
                                <span className="font-semibold text-[#170D2B]">
                                  Credits Consumed: {msg.usage.creditsConsumed} cr
                                </span>
                              ) : msg.usage.calculatedCredits !== null ? (
                                <span className="font-semibold text-[#170D2B]">
                                  Calculated Cost: {msg.usage.calculatedCredits} cr
                                </span>
                              ) : (
                                <span>Cost: Not returned by provider</span>
                              )}
                            </div>
                          ) : (
                            <span>Usage or cost information was not returned by the provider.</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {sending && (
                    <div className="rounded-xl border border-[#7650A6]/40 bg-[#FAF6EC]/85 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#40205E]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#7650A6]" />
                        <span>
                          {streamingText
                            ? `Streaming from ${activeModel?.title}...`
                            : processingMessage
                              ? processingMessage
                              : `Waiting for real response from ${activeModel?.title}...`}
                        </span>
                      </div>
                      {streamingText && (
                        <div className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#170D2B]">
                          {streamingText}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Composer */}
            <form
              onSubmit={handleSendMessage}
              className="border-t border-[#C5A45A]/30 bg-[#FAF6EC]/70 p-4 space-y-3"
            >
              {rotationNotice && (
                <div className="flex items-start gap-2 rounded-lg border border-[#C5A45A]/50 bg-[#F4E8C9]/65 px-3 py-2 text-xs text-[#170D2B]">
                  <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#40205E]" />
                  <span className="min-w-0 break-words">{rotationNotice}</span>
                </div>
              )}

              {chatError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{chatError}</span>
                </div>
              )}

              {attachmentCompatibilityIssue && !chatError && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{attachmentCompatibilityIssue}</span>
                </div>
              )}

              {pendingAttachments.length > 0 && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-[11px] font-semibold text-[#40205E]">
                    <span>Attached Files ({pendingAttachments.length})</span>
                    <button
                      type="button"
                      onClick={() => {
                        for (const att of pendingAttachments) {
                          if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
                        }
                        setPendingAttachments([]);
                      }}
                      className="text-red-600 hover:underline"
                    >
                      Clear all
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {pendingAttachments.map((att) => (
                      <div
                        key={att.id}
                        className={`rounded-lg border bg-white p-3 text-xs ${
                          att.status === 'error'
                            ? 'border-red-300'
                            : att.status === 'processing'
                              ? 'border-[#7650A6]/50'
                              : 'border-[#C5A45A]/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-start gap-2.5">
                            {att.kind === 'image' && att.previewUrl ? (
                              <img
                                src={att.previewUrl}
                                alt={att.name}
                                className="h-12 w-12 shrink-0 rounded-md border border-[#C5A45A]/30 object-cover"
                              />
                            ) : att.kind === 'zip' ? (
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#C5A45A]/50 bg-[#F4E8C9]/55 text-[#40205E]">
                                <FileArchive className="h-5 w-5" />
                              </div>
                            ) : (
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#7650A6]/35 bg-[#FAF6EC] text-[#40205E]">
                                <FileVideo className="h-5 w-5" />
                              </div>
                            )}

                            <div className="min-w-0 space-y-0.5">
                              <div className="truncate font-semibold text-[#170D2B]">{att.name}</div>
                              <div className="font-mono text-[11px] text-[#40205E]/70">
                                {att.kind.toUpperCase()} · {formatFileSize(att.size)}
                              </div>
                              <div
                                className={`flex items-center gap-1 text-[11px] font-medium ${
                                  att.status === 'error'
                                    ? 'text-red-700'
                                    : att.status === 'processing'
                                      ? 'text-[#7650A6]'
                                      : 'text-emerald-700'
                                }`}
                              >
                                {att.status === 'processing' && (
                                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                                )}
                                <span>{att.statusLabel}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {att.kind === 'zip' && att.zipData && (
                              <button
                                type="button"
                                aria-label="Toggle ZIP file list"
                                onClick={() =>
                                  updatePendingAttachment(att.id, {
                                    zipExpanded: !att.zipExpanded,
                                  })
                                }
                                className="rounded-md border border-[#40205E]/20 p-1.5 text-[#40205E] hover:bg-[#FAF6EC]"
                              >
                                {att.zipExpanded ? (
                                  <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label={`Remove ${att.name}`}
                              onClick={() => removePendingAttachment(att.id)}
                              className="rounded-md border border-[#40205E]/20 p-1.5 text-[#40205E]/75 hover:bg-red-50 hover:text-red-700"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        {att.error && (
                          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                            <span className="min-w-0 break-words">{att.error}</span>
                            <button
                              type="button"
                              onClick={() => void processSingleAttachment(att)}
                              className="shrink-0 font-semibold underline"
                            >
                              Retry
                            </button>
                          </div>
                        )}

                        {att.kind === 'video' && att.previewUrl && (
                          <div className="mt-2 space-y-1.5">
                            <video
                              src={att.previewUrl}
                              controls
                              muted
                              playsInline
                              className="max-h-36 w-full rounded-md border border-[#C5A45A]/30 bg-[#170D2B] object-contain"
                            />
                            {att.videoFrames && att.videoFrames.frames.length > 0 && (
                              <div className="space-y-1">
                                <div className="flex gap-1 overflow-x-auto pb-1">
                                  {att.videoFrames.frames.map((frame, fIdx) => (
                                    <div key={fIdx} className="shrink-0 text-center">
                                      <img
                                        src={frame.dataUrl}
                                        alt={`${att.name} frame ${frame.label}`}
                                        className="h-10 w-16 rounded border border-[#C5A45A]/30 object-cover"
                                      />
                                      <span className="block font-mono text-[9px] text-[#40205E]/70">
                                        {frame.label}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                <p className="text-[10px] text-amber-800">
                                  Active model does not natively process video/audio streams. These{' '}
                                  {att.videoFrames.frames.length} extracted visual keyframes will be
                                  analyzed (no audio track).
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        {att.kind === 'zip' && att.zipData && att.zipExpanded && (
                          <div className="mt-2 rounded-md border border-[#C5A45A]/30 bg-[#FAF6EC]/70 p-2 space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] font-semibold text-[#40205E]">
                              <span>Archive Contents ({att.zipData.totalEntries} files)</span>
                              {!activeModel?.chatCapabilities?.supportsImageInput &&
                                att.zipData.images.length > 0 && (
                                  <span className="text-amber-700">
                                    Inner images omitted for text-only model
                                  </span>
                                )}
                            </div>
                            <div className="max-h-28 overflow-y-auto space-y-0.5 font-mono text-[10px]">
                              {att.zipData.entries.map((entry, eIdx) => (
                                <div
                                  key={eIdx}
                                  className="flex items-center justify-between gap-2 text-[#170D2B]"
                                >
                                  <span className="truncate">{entry.path}</span>
                                  <span
                                    className={`shrink-0 ${
                                      entry.status === 'parsed'
                                        ? 'text-emerald-700'
                                        : entry.status === 'truncated'
                                          ? 'text-amber-700'
                                          : 'text-[#40205E]/50'
                                    }`}
                                    title={entry.reason || entry.kind}
                                  >
                                    {formatFileSize(entry.size)} · {entry.status}
                                    {entry.reason ? ` (${entry.reason})` : ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                            {att.zipData.warnings.length > 0 && (
                              <div className="border-t border-[#C5A45A]/25 pt-1 text-[10px] text-amber-800">
                                {att.zipData.warnings.join(' ')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".zip,.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm"
                className="hidden"
                onChange={(e) => {
                  handleAttachFiles(e.target.files);
                  e.target.value = '';
                }}
              />

              <textarea
                rows={3}
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (canSend) void handleSendMessage(e);
                  }
                }}
                placeholder={
                  activeModel
                    ? `Message ${activeModel.title} (${activeModel.provider}) or attach ZIP / Image / Video... Press Enter to send, Shift+Enter for newline.`
                    : catalogSyncing
                      ? 'Synchronizing verified chat models...'
                      : 'Select or sync a verified chat model to send a message.'
                }
                className="w-full rounded-lg border border-[#40205E]/25 bg-white px-3.5 py-2.5 text-sm text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs text-[#40205E]/80">
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex min-h-[42px] items-center gap-1.5 rounded-lg border border-[#C5A45A] bg-[#F4E8C9]/55 px-3.5 py-2 text-xs font-semibold text-[#170D2B] transition-colors hover:bg-[#F4E8C9] disabled:opacity-50 whitespace-nowrap"
                  >
                    <Paperclip className="h-3.5 w-3.5 text-[#40205E]" />
                    <span>Attach ZIP / Image / Video</span>
                  </button>

                  {chatModels.length === 0 ? (
                    <span className={catalogSyncing ? 'text-[#40205E]' : 'text-red-700'}>
                      {catalogSyncing
                        ? 'Synchronizing verified chat models from Kie.ai...'
                        : catalogError || 'No verified chat models loaded. Click Sync Catalog above.'}
                    </span>
                  ) : !activeModel ? (
                    <span className="text-amber-800">
                      No chat models match current filters. Reset filters or select another provider.
                    </span>
                  ) : !modelReady ? (
                    <span className="text-red-700">
                      {activeModel.unavailableReason ||
                        activeModel.pricingUnavailableReason ||
                        'Selected chat model is unavailable.'}
                    </span>
                  ) : !keyEligibility.eligible ? (
                    <span className="text-red-700">{keyEligibility.reason}</span>
                  ) : activeModel.pricingVerified && activeModel.chatPricing ? (
                    <span className="font-mono text-[11px] text-[#40205E]/80 tabular-nums break-words">
                      Rates: {activeModel.chatPricing.inputCreditsPerMillion} cr/1M in ·{' '}
                      {activeModel.chatPricing.outputCreditsPerMillion} cr/1M out · Exact usage &amp; cost shown upon completion.
                    </span>
                  ) : (
                    <span>Ready · Real token usage &amp; cost displayed upon completion.</span>
                  )}
                </div>

                <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                  {sending && (
                    <button
                      type="button"
                      onClick={() => abortControllerRef.current?.abort()}
                      className="inline-flex min-h-[42px] items-center gap-1.5 rounded-lg border border-[#40205E]/25 bg-white px-3.5 py-2 text-xs font-semibold text-[#40205E] hover:bg-[#FAF6EC]"
                    >
                      <Square className="h-3 w-3 fill-current" />
                      <span>Stop</span>
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-[#C5A45A] bg-[#C5A45A] px-5 py-2 text-xs font-bold text-[#170D2B] shadow-2xs transition-colors hover:bg-[#b5944c] disabled:cursor-not-allowed disabled:border-[#40205E]/15 disabled:bg-[#F4E8C9]/50 disabled:text-[#40205E]/45 whitespace-nowrap sm:flex-initial"
                  >
                    {sending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    <span>{sending ? 'Generating...' : 'Send Message'}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
