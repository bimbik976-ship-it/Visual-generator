import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import { getCandidateKeysInOrder } from '../storage/localVault';
import type {
  AffordabilitySummary,
  CatalogModel,
  CostCalculationResult,
  GenerationStatus,
  KeyStatus,
  LocalApiKey,
  LocalMediaTask,
  ModelInputField,
} from '../types';
import {
  getFieldMediaKind,
  hasImageInputSupport,
  parseImageFieldConstraints,
  validateImageFileForField,
} from '../utils/mediaUploadAdapter';

interface MediaGeneratorViewProps {
  category: 'video' | 'image';
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
  tasks: LocalMediaTask[];
  onTasksChange: (tasks: LocalMediaTask[]) => void;
  onGoToKeys: () => void;
}

function buildDefaultInput(model: CatalogModel): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (field.defaultValue !== undefined) {
      defaults[field.name] = field.defaultValue;
    } else if (field.enumValues && field.enumValues.length > 0) {
      defaults[field.name] = field.enumValues[0];
    } else if (field.type === 'boolean') {
      defaults[field.name] = false;
    } else if (field.type === 'array') {
      defaults[field.name] = [];
    }
  }
  if (
    model.category === 'video' &&
    defaults.duration === undefined &&
    model.supportedDurations.length > 0
  ) {
    const durField = model.fields.find((f) => f.name === 'duration' || f.name === 'seconds');
    if (durField) defaults[durField.name] = model.supportedDurations[0];
  }
  return defaults;
}

type ImageUploadStatus =
  | 'Waiting for upload'
  | 'Uploading'
  | 'Upload successful'
  | 'Upload failed';

interface FieldUploadItem {
  id: string;
  file: File;
  fileName: string;
  fileSize: number;
  mimeType: string;
  previewUrl: string;
  status: ImageUploadStatus;
  uploadedUrl: string | null;
  error?: string;
}

function formatUploadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function isUrlField(field: ModelInputField): boolean {
  if (getFieldMediaKind(field) !== 'none') return true;
  return field.format === 'uri';
}

function renderTaskStatusBadge(status: GenerationStatus) {
  switch (status) {
    case 'Succeeded':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>Succeeded</span>
        </span>
      );
    case 'Failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Failed</span>
        </span>
      );
    case 'Cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#40205E]/75">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Cancelled</span>
        </span>
      );
    case 'Timed Out':
    case 'Unknown':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{status}</span>
        </span>
      );
    case 'Processing':
    case 'Submitting':
    case 'Validating':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#7650A6]">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>{status}</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span>{status}</span>
        </span>
      );
  }
}

export function MediaGeneratorView({
  category,
  models,
  syncedAt,
  catalogSyncing,
  catalogStale,
  catalogError,
  onSyncCatalog,
  keys,
  autoRotateEnabled,
  onUpdateKeyVerification,
  tasks,
  onTasksChange,
  onGoToKeys,
}: MediaGeneratorViewProps) {
  const categoryModels = useMemo(
    () => models.filter((m) => m.category === category),
    [models, category]
  );

  const [subView, setSubView] = useState<'studio' | 'catalog' | 'history'>('studio');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [modeFilter, setModeFilter] = useState<string>('all');
  const [verifiedOnly, setVerifiedOnly] = useState<boolean>(false);
  const [modelSearch, setModelSearch] = useState('');

  const [modelDetail, setModelDetail] = useState<CatalogModel | null>(null);
  const [loadingSpec, setLoadingSpec] = useState(false);

  const [selectedMode, setSelectedMode] = useState<string>('');
  const [preferredKeyId, setPreferredKeyId] = useState<string>('');
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});

  const [affordMode, setAffordMode] = useState<'balance' | 'benchmark80'>('balance');
  const [costResult, setCostResult] = useState<CostCalculationResult | null>(null);
  const [affordability, setAffordability] = useState<AffordabilitySummary | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);

  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [fieldUploads, setFieldUploads] = useState<Record<string, FieldUploadItem[]>>({});
  const fieldUploadsRef = useRef<Record<string, FieldUploadItem[]>>({});
  fieldUploadsRef.current = fieldUploads;
  const [submitting, setSubmitting] = useState(false);
  const [localPhase, setLocalPhase] = useState<'idle' | 'Validating' | 'Submitting'>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rotationNotice, setRotationNotice] = useState<string | null>(null);
  const [mediaLoadError, setMediaLoadError] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const [activeTaskId, setActiveTaskId] = useState<string | null>(() => tasks[0]?.id ?? null);
  const clientRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      for (const items of Object.values(fieldUploadsRef.current)) {
        for (const item of items) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        }
      }
    };
  }, []);

  // Initialize default model for this category
  useEffect(() => {
    if (categoryModels.length === 0) return;
    setSelectedModelId((prev) => {
      if (prev && categoryModels.some((m) => m.id === prev)) return prev;
      const firstVerified = categoryModels.find(
        (m) => m.verificationStatus === 'VERIFIED'
      );
      return firstVerified?.id || categoryModels[0].id;
    });
  }, [categoryModels]);

  const allModes = useMemo(() => {
    const s = new Set<string>();
    for (const m of categoryModels) {
      for (const mode of m.modes) s.add(mode);
    }
    return Array.from(s).sort();
  }, [categoryModels]);

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    return categoryModels.filter((m) => {
      if (modeFilter !== 'all' && !m.modes.includes(modeFilter)) return false;
      if (verifiedOnly && m.verificationStatus !== 'VERIFIED') return false;
      if (q) {
        const hay = `${m.title} ${m.id} ${m.provider} ${m.modes.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [categoryModels, modeFilter, verifiedOnly, modelSearch]);

  const baseSelectedModel = useMemo(
    () =>
      categoryModels.find((m) => m.id === selectedModelId) ||
      categoryModels[0] ||
      null,
    [categoryModels, selectedModelId]
  );

  const activeModel =
    modelDetail && baseSelectedModel && modelDetail.id === baseSelectedModel.id
      ? modelDetail
      : baseSelectedModel;

  useEffect(() => {
    if (!baseSelectedModel) return;
    let cancelled = false;
    setLoadingSpec(true);
    setSubmitError(null);
    setRotationNotice(null);

    setFieldUploads((prev) => {
      for (const items of Object.values(prev)) {
        for (const item of items) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        }
      }
      return {};
    });

    api
      .getModelDetail(baseSelectedModel.id, category)
      .then((res) => {
        if (cancelled) return;
        setModelDetail(res.model);
        setSelectedMode(res.model.modes[0] || '');
        setInputValues(buildDefaultInput(res.model));
      })
      .catch(() => {
        if (cancelled) return;
        setModelDetail(baseSelectedModel);
        setSelectedMode(baseSelectedModel.modes[0] || '');
        setInputValues(buildDefaultInput(baseSelectedModel));
      })
      .finally(() => {
        if (!cancelled) setLoadingSpec(false);
      });

    return () => {
      cancelled = true;
    };
  }, [baseSelectedModel?.id, category]);

  const selectedKey = useMemo(() => {
    if (preferredKeyId) {
      return keys.find((k) => k.id === preferredKeyId) || null;
    }
    return keys.find((k) => k.isActive) || keys[0] || null;
  }, [keys, preferredKeyId]);

  const activeBalance = selectedKey?.balance ?? null;
  const effectiveAffordBalance =
    affordMode === 'benchmark80' ? 80 : activeBalance;

  useEffect(() => {
    if (!activeModel) return;
    let cancelled = false;
    setPricingLoading(true);
    api
      .calculatePricing(activeModel.id, category, inputValues, effectiveAffordBalance)
      .then((res) => {
        if (cancelled) return;
        setCostResult(res.cost);
        setAffordability(res.affordability);
      })
      .catch((err) => {
        if (cancelled) return;
        setCostResult({
          verified: false,
          exactCredits: null,
          exactUsd: null,
          breakdown: [],
          reason: err instanceof Error ? err.message : 'Pricing calculation failed.',
        });
        setAffordability(null);
      })
      .finally(() => {
        if (!cancelled) setPricingLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeModel?.id, category, JSON.stringify(inputValues), effectiveAffordBalance]);

  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeTaskId) || tasks[0] || null,
    [tasks, activeTaskId]
  );

  function upsertTask(task: LocalMediaTask) {
    setActiveTaskId(task.id);
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx === -1) {
      onTasksChange([task, ...tasks]);
    } else {
      const next = [...tasks];
      next[idx] = task;
      onTasksChange(next);
    }
  }

  // Real polling loop for active non-terminal task
  useEffect(() => {
    if (!activeTask) return;
    setMediaLoadError(false);
    const nonTerminal =
      activeTask.status === 'Queued' ||
      activeTask.status === 'Processing' ||
      activeTask.status === 'Submitting';
    if (!nonTerminal || !activeTask.kieTaskId) return;

    const timer = setInterval(async () => {
      await pollSpecificTask(activeTask);
    }, 3500);

    return () => clearInterval(timer);
  }, [activeTask?.id, activeTask?.status, activeTask?.kieTaskId, keys]);

  async function pollSpecificTask(task: LocalMediaTask) {
    if (!task.kieTaskId) return;
    const keyObj =
      (task.keyId ? keys.find((k) => k.id === task.keyId) : undefined) ||
      keys.find((k) => k.isActive) ||
      keys[0];
    if (!keyObj) {
      setSubmitError('Cannot poll Kie.ai because the associated API key is no longer on this device.');
      return;
    }

    try {
      const res = await api.pollMediaTask(keyObj.apiKey, task.kieTaskId, category);
      if (!res.ok) {
        if (res.error) setSubmitError(res.error);
        return;
      }
      const nextStatus = res.status || task.status;
      const isTerminal =
        nextStatus === 'Succeeded' || nextStatus === 'Failed' || nextStatus === 'Cancelled';

      const updated: LocalMediaTask = {
        ...task,
        status: nextStatus,
        rawState: res.rawState ?? task.rawState,
        resultUrls: res.resultUrls ?? task.resultUrls,
        mediaVerified: Boolean(res.mediaVerified),
        errorCode: res.errorCode ?? null,
        errorMessage: res.errorMessage ?? null,
        creditsConsumed: res.creditsConsumed ?? task.creditsConsumed,
        updatedAt: Date.now(),
        completedAt: isTerminal ? task.completedAt || Date.now() : null,
      };
      upsertTask(updated);

      if (typeof res.updatedBalance === 'number') {
        onUpdateKeyVerification(keyObj.id, {
          status: res.updatedBalance > 0 ? 'Valid' : 'Insufficient Balance',
          balance: res.updatedBalance,
          lastError: null,
        });
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Status check failed.');
    }
  }

  // Pre-generation 12-point validation
  const paramValidationError = useMemo(() => {
    if (!activeModel) return 'Select a model from the live Kie.ai catalog.';
    if (activeModel.deprecated) return 'Deprecated model — generation disabled.';
    if (!activeModel.isAvailable || activeModel.verificationStatus !== 'VERIFIED') {
      return activeModel.unavailableReason || 'Selected model is currently unavailable.';
    }
    if (!activeModel.pricingVerified) {
      return (
        activeModel.pricingUnavailableReason ||
        'Pricing unavailable — generation temporarily disabled.'
      );
    }
    if (activeModel.fields.length === 0) {
      return 'OpenAPI parameter schema unavailable — generation disabled.';
    }

    for (const [fName, items] of Object.entries(fieldUploads)) {
      if (items.some((i) => i.status === 'Uploading')) {
        return `Image upload for "${fName}" is still in progress.`;
      }
      const failed = items.find((i) => i.status === 'Upload failed');
      if (failed) {
        return `Upload failed for "${fName}": ${failed.error || 'Retry or remove the image before generating.'}`;
      }
      const waiting = items.find((i) => i.status === 'Waiting for upload');
      if (waiting) {
        return `Image for "${fName}" has not been uploaded yet.`;
      }
    }

    for (const field of activeModel.fields) {
      const val = inputValues[field.name];
      const missing =
        val === undefined ||
        val === null ||
        (typeof val === 'string' && val.trim() === '') ||
        (Array.isArray(val) && val.length === 0);
      if (field.required && missing) {
        return `Required parameter "${field.name}" cannot be empty.`;
      }
      const mediaKind = getFieldMediaKind(field);
      const allowsAsset = (field.description || '').toLowerCase().includes('asset://');

      if (!missing && field.type === 'string') {
        const trimmed = String(val).trim();
        const len = trimmed.length;
        if (field.minLength !== undefined && len < field.minLength) {
          return `"${field.name}" must be at least ${field.minLength} characters.`;
        }
        if (field.maxLength !== undefined && len > field.maxLength) {
          return `"${field.name}" exceeds maximum length of ${field.maxLength} characters.`;
        }
        if (field.format === 'uri' || mediaKind !== 'none') {
          if (/^data:/i.test(trimmed)) {
            return `"${field.name}" requires an uploaded http(s) file URL, not raw Base64 data.`;
          }
          const validUrl =
            /^https?:\/\/\S+/i.test(trimmed) || (allowsAsset && /^asset:\/\/\S+/i.test(trimmed));
          if (!validUrl) {
            return `"${field.name}" must be a valid http(s) URL.`;
          }
        }
      } else if (!missing && field.type === 'array' && (field.format === 'uri' || mediaKind !== 'none')) {
        const arr = Array.isArray(val) ? val : [];
        if (mediaKind === 'image') {
          const constraints = parseImageFieldConstraints(field);
          if (arr.length > constraints.maxCount) {
            return `"${field.name}" accepts at most ${constraints.maxCount} image(s).`;
          }
        }
        for (const item of arr) {
          if (typeof item === 'string') {
            if (/^data:/i.test(item)) {
              return `"${field.name}" requires uploaded http(s) file URLs, not raw Base64 data.`;
            }
            const validUrl =
              /^https?:\/\/\S+/i.test(item) || (allowsAsset && /^asset:\/\/\S+/i.test(item));
            if (!validUrl) {
              return `All URLs in "${field.name}" must be valid http(s) URLs.`;
            }
          }
        }
      }
    }
    return null;
  }, [activeModel, inputValues, fieldUploads]);

  // Key eligibility & auto-rotation readiness preview
  const keyEligibility = useMemo(() => {
    if (keys.length === 0) {
      return { eligible: false, reason: 'No Kie.ai API keys saved. Add a key in API Key Manager.' };
    }
    if (!costResult?.verified || costResult.exactCredits === null) {
      return {
        eligible: false,
        reason: costResult?.reason || 'Pricing unavailable — generation temporarily disabled.',
      };
    }
    const cost = costResult.exactCredits;
    if (
      selectedKey &&
      (selectedKey.status === 'Valid' || selectedKey.status === 'Unknown') &&
      (selectedKey.balance === null || selectedKey.balance >= cost)
    ) {
      return { eligible: true, willRotate: false, targetKey: selectedKey };
    }

    const isInsufficient =
      selectedKey &&
      (selectedKey.status === 'Insufficient Balance' ||
        (selectedKey.balance !== null && selectedKey.balance < cost));

    if (isInsufficient && autoRotateEnabled) {
      const fallback = keys.find(
        (k) =>
          k.id !== selectedKey.id &&
          k.status === 'Valid' &&
          (k.balance ?? 0) >= cost
      );
      if (fallback) {
        return { eligible: true, willRotate: true, targetKey: fallback };
      }
      return {
        eligible: false,
        reason:
          'All available API keys have insufficient credits. Add a new key or replenish your Kie.ai balance.',
      };
    }

    if (isInsufficient && !autoRotateEnabled) {
      return {
        eligible: false,
        reason: `Selected key "${selectedKey?.label}" has insufficient credits (${selectedKey?.balance ?? 0} cr < ${cost} cr) and Automatic Rotation is off.`,
      };
    }

    return {
      eligible: false,
      reason: `Selected API key (${selectedKey?.label}) status is ${selectedKey?.status}.`,
    };
  }, [keys, selectedKey, costResult, autoRotateEnabled]);

  const canSubmit =
    Boolean(activeModel) &&
    !loadingSpec &&
    !pricingLoading &&
    !submitting &&
    paramValidationError === null &&
    Boolean(costResult?.verified) &&
    keyEligibility.eligible;

  function updateFieldUploadItem(fieldName: string, itemId: string, patch: Partial<FieldUploadItem>) {
    setFieldUploads((prev) => {
      const list = prev[fieldName] || [];
      return {
        ...prev,
        [fieldName]: list.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
      };
    });
  }

  function removeFieldUploadItem(field: ModelInputField, itemId: string) {
    const existingList = fieldUploads[field.name] || [];
    const target = existingList.find((it) => it.id === itemId);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);

    const remaining = existingList.filter((it) => it.id !== itemId);
    setFieldUploads((prev) => ({ ...prev, [field.name]: remaining }));

    if (target?.uploadedUrl) {
      setInputValues((prev) => {
        if (field.type === 'array') {
          const prevArr = Array.isArray(prev[field.name]) ? (prev[field.name] as unknown[]) : [];
          return {
            ...prev,
            [field.name]: prevArr.filter((entry) => {
              if (typeof entry === 'string') return entry !== target.uploadedUrl;
              if (entry && typeof entry === 'object') {
                const obj = entry as Record<string, unknown>;
                return obj.url !== target.uploadedUrl && obj.image_url !== target.uploadedUrl;
              }
              return true;
            }),
          };
        }
        return prev[field.name] === target.uploadedUrl ? { ...prev, [field.name]: '' } : prev;
      });
    }
  }

  async function uploadSingleImageItem(
    field: ModelInputField,
    item: FieldUploadItem,
    replaceUrl?: string | null
  ) {
    const constraints = parseImageFieldConstraints(field);
    if (!selectedKey?.apiKey) {
      const msg = 'Add and select a valid Kie.ai API key in API Key Manager before uploading.';
      updateFieldUploadItem(field.name, item.id, {
        status: 'Upload failed',
        error: msg,
      });
      setSubmitError(msg);
      return;
    }

    setSubmitError(null);
    setUploadingField(field.name);
    updateFieldUploadItem(field.name, item.id, {
      status: 'Uploading',
      error: undefined,
    });

    try {
      let res: { ok: boolean; fileUrl: string };

      if (item.file.size > 10 * 1024 * 1024) {
        // Kie.ai recommends File Stream Upload for >10MB files to avoid 33% Base64 overhead
        res = await api.uploadMediaStreamFile(selectedKey.apiKey, item.file, {
          allowedMimeTypes: constraints.acceptedMimeTypes,
          maxBytes: constraints.maxSizeBytes,
          uploadPath: 'kie-studio-inputs',
        });
      } else {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string' && reader.result.length >= 16) {
              resolve(reader.result);
            } else {
              reject(new Error(`Unable to read "${item.fileName}" as Base64.`));
            }
          };
          reader.onerror = () => reject(new Error(`Failed to read local file "${item.fileName}".`));
          reader.readAsDataURL(item.file);
        });

        res = await api.uploadFile(selectedKey.apiKey, dataUrl, item.fileName, {
          allowedMimeTypes: constraints.acceptedMimeTypes,
          maxBytes: constraints.maxSizeBytes,
          uploadPath: 'kie-studio-inputs',
        });
      }

      if (!res?.fileUrl || !/^https?:\/\/\S+/i.test(res.fileUrl)) {
        throw new Error('Upload URL Missing: Kie.ai did not return a valid download URL.');
      }

      updateFieldUploadItem(field.name, item.id, {
        status: 'Upload successful',
        uploadedUrl: res.fileUrl,
        error: undefined,
      });

      setInputValues((prev) => {
        if (field.type === 'array') {
          const existing = Array.isArray(prev[field.name]) ? (prev[field.name] as unknown[]) : [];
          const isObjArray = field.itemType === 'object';
          const toEntry = (url: string, idx: number): unknown => {
            if (!isObjArray) return url;
            if (field.name === 'image_references') {
              return { image_url: url, type: 'subject', ref_name: `ref${idx + 1}` };
            }
            if (field.name === 'keyframes') {
              return { url, timestamp_s: idx + 1 };
            }
            return { url };
          };
          if (replaceUrl) {
            let replacedAny = false;
            const replaced = existing.map((entry, idx) => {
              if (typeof entry === 'string' && entry === replaceUrl) {
                replacedAny = true;
                return res.fileUrl;
              }
              if (entry && typeof entry === 'object') {
                const obj = entry as Record<string, unknown>;
                if (obj.url === replaceUrl) {
                  replacedAny = true;
                  return { ...obj, url: res.fileUrl };
                }
                if (obj.image_url === replaceUrl) {
                  replacedAny = true;
                  return { ...obj, image_url: res.fileUrl };
                }
              }
              return entry;
            });
            return {
              ...prev,
              [field.name]: replacedAny ? replaced : [...existing, toEntry(res.fileUrl, existing.length)],
            };
          }
          if (constraints.maxCount === 1) {
            return { ...prev, [field.name]: [toEntry(res.fileUrl, 0)] };
          }
          return { ...prev, [field.name]: [...existing, toEntry(res.fileUrl, existing.length)] };
        }
        return { ...prev, [field.name]: res.fileUrl };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'File upload failed.';
      updateFieldUploadItem(field.name, item.id, {
        status: 'Upload failed',
        uploadedUrl: null,
        error: msg,
      });
      setSubmitError(msg);
    } finally {
      setUploadingField(null);
    }
  }

  async function handleImageFilesPicked(
    field: ModelInputField,
    fileList: FileList | null,
    replaceItemId?: string
  ) {
    if (!fileList || fileList.length === 0) return;
    setSubmitError(null);

    const constraints = parseImageFieldConstraints(field);
    const isArray = field.type === 'array';
    const picked = Array.from(fileList);

    const existingItems = fieldUploads[field.name] || [];
    const existingUrls =
      isArray && Array.isArray(inputValues[field.name])
        ? (inputValues[field.name] as string[])
        : [];

    if (!replaceItemId && isArray && constraints.maxCount > 1) {
      const currentTotal = Math.max(existingItems.length, existingUrls.length);
      if (currentTotal + picked.length > constraints.maxCount) {
        setSubmitError(
          `Maximum of ${constraints.maxCount} image(s) allowed for "${field.name}".`
        );
        return;
      }
    }

    const toProcess = !isArray || constraints.maxCount === 1 || replaceItemId ? [picked[0]] : picked;

    for (const file of toProcess) {
      const check = await validateImageFileForField(file, constraints);
      const previewUrl = URL.createObjectURL(file);
      const itemId = replaceItemId || crypto.randomUUID();

      let replaceUrl: string | null = null;
      if (replaceItemId) {
        const prevItem = existingItems.find((x) => x.id === replaceItemId);
        if (prevItem?.previewUrl) URL.revokeObjectURL(prevItem.previewUrl);
        replaceUrl = prevItem?.uploadedUrl ?? null;
      } else if (!isArray || constraints.maxCount === 1) {
        for (const prevItem of existingItems) {
          if (prevItem.previewUrl) URL.revokeObjectURL(prevItem.previewUrl);
        }
      }

      if (!check.ok) {
        const failedItem: FieldUploadItem = {
          id: itemId,
          file,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || 'unknown',
          previewUrl,
          status: 'Upload failed',
          uploadedUrl: null,
          error: check.error,
        };
        setFieldUploads((prev) => {
          const cur = prev[field.name] || [];
          if (!isArray || constraints.maxCount === 1) {
            return { ...prev, [field.name]: [failedItem] };
          }
          if (replaceItemId) {
            return {
              ...prev,
              [field.name]: cur.map((x) => (x.id === replaceItemId ? failedItem : x)),
            };
          }
          return { ...prev, [field.name]: [...cur, failedItem] };
        });
        setSubmitError(check.error);
        continue;
      }

      const initialStatus: ImageUploadStatus = selectedKey?.apiKey
        ? 'Waiting for upload'
        : 'Upload failed';

      const newItem: FieldUploadItem = {
        id: itemId,
        file,
        fileName: file.name,
        fileSize: file.size,
        mimeType: check.mimeType,
        previewUrl,
        status: initialStatus,
        uploadedUrl: null,
        error: selectedKey?.apiKey
          ? undefined
          : 'Add and select a valid Kie.ai API key in API Key Manager before uploading.',
      };

      setFieldUploads((prev) => {
        const cur = prev[field.name] || [];
        if (!isArray || constraints.maxCount === 1) {
          return { ...prev, [field.name]: [newItem] };
        }
        if (replaceItemId) {
          return {
            ...prev,
            [field.name]: cur.map((x) => (x.id === replaceItemId ? newItem : x)),
          };
        }
        return { ...prev, [field.name]: [...cur, newItem] };
      });

      if (selectedKey?.apiKey) {
        await uploadSingleImageItem(field, newItem, replaceUrl);
      } else {
        setSubmitError(newItem.error || null);
      }
    }
  }

  async function handleFileUpload(fieldName: string, isArray: boolean, file: File) {
    if (!selectedKey) {
      setSubmitError('Add an API key in API Key Manager before uploading reference media.');
      return;
    }
    setSubmitError(null);
    setUploadingField(fieldName);
    try {
      let res: { fileUrl: string };
      if (file.size > 10 * 1024 * 1024) {
        res = await api.uploadMediaStreamFile(selectedKey.apiKey, file, {
          uploadPath: 'kie-studio-inputs',
        });
      } else {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Failed to read local file.'));
          reader.readAsDataURL(file);
        });
        res = await api.uploadFile(selectedKey.apiKey, dataUrl, file.name);
      }
      if (!res?.fileUrl || !/^https?:\/\/\S+/i.test(res.fileUrl)) {
        throw new Error('Upload URL Missing: Kie.ai did not return a valid download URL.');
      }
      setInputValues((prev) => {
        if (isArray) {
          const existing = Array.isArray(prev[fieldName]) ? (prev[fieldName] as string[]) : [];
          return { ...prev, [fieldName]: [...existing, res.fileUrl] };
        }
        return { ...prev, [fieldName]: res.fileUrl };
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'File upload failed.');
    } finally {
      setUploadingField(null);
    }
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!activeModel || !canSubmit || submitting) return;

    setSubmitError(null);
    setRotationNotice(null);
    setSubmitting(true);
    setLocalPhase('Validating');

    const baseRequestId = clientRequestIdRef.current || crypto.randomUUID();
    clientRequestIdRef.current = baseRequestId;

    const candidates = getCandidateKeysInOrder(keys, preferredKeyId || undefined);
    const maxAttempts = autoRotateEnabled ? candidates.length : 1;

    try {
      setLocalPhase('Submitting');
      let rotatedFromLabel: string | null = null;

      for (let i = 0; i < maxAttempts; i++) {
        const candidate = candidates[i];
        const res = await api.submitMediaGeneration(candidate.apiKey, {
          clientRequestId: `${baseRequestId}_${i}`,
          modelId: activeModel.id,
          category,
          generationMode: selectedMode || activeModel.modes[0] || '',
          input: inputValues,
        });

        // Update local key verification state whenever backend checked it
        if (typeof res.verifiedBalance === 'number' || res.keyStatus) {
          onUpdateKeyVerification(candidate.id, {
            status: res.keyStatus || (res.ok ? 'Valid' : candidate.status),
            balance:
              typeof res.verifiedBalance === 'number' ? res.verifiedBalance : candidate.balance,
            lastError: res.ok ? null : res.error || null,
          });
        }

        if (res.ok && res.taskId) {
          const now = Date.now();
          const newTask: LocalMediaTask = {
            id: crypto.randomUUID(),
            clientRequestId: baseRequestId,
            keyId: candidate.id,
            keyLabelUsed: candidate.label,
            maskedKeyUsed: candidate.maskedKey,
            modelId: activeModel.id,
            modelTitle: activeModel.title,
            category,
            generationMode: selectedMode || activeModel.modes[0] || '',
            endpointPath: res.endpointPath || activeModel.endpointPath,
            input: res.sanitizedInput || inputValues,
            verifiedCost: res.verifiedCost ?? costResult?.exactCredits ?? 0,
            status: res.status || 'Queued',
            kieTaskId: res.taskId,
            resultUrls: [],
            mediaVerified: false,
            errorCode: null,
            errorMessage: null,
            rawState: res.rawState || 'waiting',
            creditsConsumed: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          };
          upsertTask(newTask);

          if (rotatedFromLabel && rotatedFromLabel !== candidate.label) {
            setRotationNotice(
              `Automatic rotation: "${rotatedFromLabel}" had insufficient credits. Submitted using "${candidate.label}" (${candidate.maskedKey}).`
            );
          }
          clientRequestIdRef.current = null;
          return;
        }

        // Only rotate automatically on insufficient credits
        if (res.insufficientCredits && autoRotateEnabled && i < maxAttempts - 1) {
          if (!rotatedFromLabel) rotatedFromLabel = candidate.label;
          continue;
        }

        // Record failure transparently (or Unknown on ambiguous timeout)
        const now = Date.now();
        const failedTask: LocalMediaTask = {
          id: crypto.randomUUID(),
          clientRequestId: baseRequestId,
          keyId: candidate.id,
          keyLabelUsed: candidate.label,
          maskedKeyUsed: candidate.maskedKey,
          modelId: activeModel.id,
          modelTitle: activeModel.title,
          category,
          generationMode: selectedMode || activeModel.modes[0] || '',
          endpointPath: activeModel.endpointPath,
          input: inputValues,
          verifiedCost: costResult?.exactCredits ?? 0,
          status: res.ambiguousTimeout ? 'Unknown' : 'Failed',
          kieTaskId: null,
          resultUrls: [],
          mediaVerified: false,
          errorCode: res.errorCode || String(res.httpStatus || 'ERROR'),
          errorMessage: res.error || 'Kie.ai rejected the generation request.',
          rawState: null,
          creditsConsumed: null,
          createdAt: now,
          updatedAt: now,
          completedAt: res.ambiguousTimeout ? null : now,
        };
        upsertTask(failedTask);
        setSubmitError(failedTask.errorMessage);
        clientRequestIdRef.current = null;
        return;
      }

      setSubmitError(
        'All saved API keys have insufficient credits for this generation. Add a new key or replenish your Kie.ai balance.'
      );
      clientRequestIdRef.current = null;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit generation.');
      clientRequestIdRef.current = null;
    } finally {
      setSubmitting(false);
      setLocalPhase('idle');
    }
  }

  async function handleDownload(task: LocalMediaTask, url: string, idx: number) {
    const dlKey = `${task.id}-${idx}`;
    setDownloadingKey(dlKey);
    try {
      const keyObj = task.keyId ? keys.find((k) => k.id === task.keyId) : undefined;
      const ext = task.category === 'video' ? 'mp4' : 'png';
      const filename = `kie_${task.kieTaskId || task.id}_${idx + 1}.${ext}`;
      await api.downloadMediaBlob(keyObj?.apiKey, url, filename);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingKey(null);
    }
  }

  function renderFieldControl(field: ModelInputField) {
    const val = inputValues[field.name];
    const isPrompt = field.name === 'prompt' || field.name === 'negative_prompt';

    if (isPrompt) {
      const str = typeof val === 'string' ? val : '';
      return (
        <div key={field.name} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${category}-field-${field.name}`} className="text-xs font-semibold text-[#170D2B]">
              {field.name === 'prompt' ? 'Prompt' : 'Negative Prompt'}
              {field.required && <span className="ml-1 text-red-600">*</span>}
            </label>
            {field.maxLength && (
              <span className="font-mono text-[11px] text-[#40205E]/70 tabular-nums">
                {str.length} / {field.maxLength}
              </span>
            )}
          </div>
          <textarea
            id={`${category}-field-${field.name}`}
            rows={field.name === 'prompt' ? 4 : 2}
            value={str}
            onChange={(e) =>
              setInputValues((prev) => ({ ...prev, [field.name]: e.target.value }))
            }
            placeholder={
              typeof field.example === 'string'
                ? field.example
                : `Enter ${field.name.replace(/_/g, ' ')}...`
            }
            className="mt-1.5 w-full rounded-lg border border-[#40205E]/25 bg-white px-3.5 py-2.5 text-sm text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
          />
          {field.description && (
            <p className="mt-1 text-[11px] leading-normal text-[#40205E]/75">{field.description}</p>
          )}
        </div>
      );
    }

    if (field.type === 'boolean') {
      const checked = Boolean(val);
      return (
        <div
          key={field.name}
          className="flex items-start justify-between gap-4 rounded-lg border border-[#C5A45A]/30 bg-[#FAF6EC]/65 px-3.5 py-3"
        >
          <div className="min-w-0">
            <label htmlFor={`${category}-field-${field.name}`} className="text-xs font-semibold text-[#170D2B]">
              {field.name}
            </label>
            {field.description && (
              <p className="mt-0.5 text-[11px] text-[#40205E]/75">{field.description}</p>
            )}
          </div>
          <input
            id={`${category}-field-${field.name}`}
            type="checkbox"
            checked={checked}
            onChange={(e) =>
              setInputValues((prev) => ({ ...prev, [field.name]: e.target.checked }))
            }
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-[#40205E]/30 accent-[#40205E]"
          />
        </div>
      );
    }

    if (field.enumValues && field.enumValues.length > 0) {
      return (
        <div key={field.name} className="min-w-0">
          <label htmlFor={`${category}-field-${field.name}`} className="block text-xs font-semibold text-[#170D2B]">
            {field.name}
            {field.required && <span className="ml-1 text-red-600">*</span>}
          </label>
          {field.enumValues.length <= 6 ? (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {field.enumValues.map((opt) => {
                const active = String(val) === String(opt);
                return (
                  <button
                    key={String(opt)}
                    type="button"
                    onClick={() =>
                      setInputValues((prev) => ({ ...prev, [field.name]: opt }))
                    }
                    className={`min-h-[38px] rounded-lg border px-3 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'border-[#40205E] bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                        : 'border-[#40205E]/20 bg-white text-[#170D2B] hover:border-[#C5A45A] hover:bg-[#FAF6EC]'
                    }`}
                  >
                    {String(opt)}
                  </button>
                );
              })}
            </div>
          ) : (
            <select
              id={`${category}-field-${field.name}`}
              value={val !== undefined ? String(val) : ''}
              onChange={(e) => {
                const matched = field.enumValues?.find((x) => String(x) === e.target.value);
                setInputValues((prev) => ({
                  ...prev,
                  [field.name]: matched !== undefined ? matched : e.target.value,
                }));
              }}
              className="mt-1.5 min-h-[42px] w-full max-w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-xs text-[#170D2B] focus:border-[#7650A6] focus:outline-none"
            >
              {field.enumValues.map((opt) => (
                <option key={String(opt)} value={String(opt)}>
                  {String(opt)}
                </option>
              ))}
            </select>
          )}
          {field.description && (
            <p className="mt-1 text-[11px] text-[#40205E]/75">{field.description}</p>
          )}
        </div>
      );
    }

    const mediaKind = getFieldMediaKind(field);

    if (mediaKind === 'image') {
      const constraints = parseImageFieldConstraints(field);
      const isArray = field.type === 'array';
      const uploadItems = fieldUploads[field.name] || [];
      const singleVal = !isArray && typeof val === 'string' ? val : '';
      const arrayList = isArray && Array.isArray(val) ? (val as string[]) : [];
      const singleItem = !isArray ? uploadItems[0] || null : null;

      return (
        <div key={field.name} className="space-y-2.5 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <label htmlFor={`${category}-field-${field.name}`} className="text-xs font-semibold text-[#170D2B]">
                {field.name}
                {isArray ? ` (URLs, max ${constraints.maxCount})` : ''}
                {field.required && <span className="ml-1 text-red-600">*</span>}
              </label>
              <span className="ml-2 text-[11px] text-[#40205E]/70">
                {constraints.formatLabel} · Max {constraints.maxSizeMbLabel}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg border border-[#C5A45A] bg-[#F4E8C9]/55 px-3 py-1.5 text-xs font-semibold text-[#170D2B] transition-colors hover:bg-[#F4E8C9] whitespace-nowrap">
                {uploadingField === field.name ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#40205E]" />
                ) : (
                  <Upload className="h-3.5 w-3.5 text-[#40205E]" />
                )}
                <span>
                  {!isArray && singleItem
                    ? 'Replace Image'
                    : isArray && constraints.maxCount > 1
                      ? 'Upload Images'
                      : 'Upload Image'}
                </span>
                <input
                  type="file"
                  accept={constraints.acceptAttr}
                  multiple={isArray && constraints.maxCount > 1}
                  className="hidden"
                  disabled={uploadingField === field.name}
                  onChange={(e) => {
                    void handleImageFilesPicked(
                      field,
                      e.target.files,
                      !isArray && singleItem ? singleItem.id : undefined
                    );
                    e.target.value = '';
                  }}
                />
              </label>
              {!isArray && singleItem && (
                <button
                  type="button"
                  onClick={() => removeFieldUploadItem(field, singleItem.id)}
                  className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Remove</span>
                </button>
              )}
            </div>
          </div>

          {uploadItems.length > 0 && (
            <div className="space-y-2">
              {uploadItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-xs ${
                    item.status === 'Upload failed'
                      ? 'border-red-200 bg-red-50/75'
                      : item.status === 'Uploading'
                        ? 'border-[#7650A6]/40 bg-[#FAF6EC]'
                        : item.status === 'Upload successful'
                          ? 'border-emerald-200 bg-emerald-50/50'
                          : 'border-[#C5A45A]/30 bg-[#FAF6EC]/50'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    {item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt={item.fileName}
                        className="h-12 w-12 shrink-0 rounded-md border border-[#C5A45A]/35 bg-white object-cover"
                      />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-[#C5A45A]/35 bg-white text-[#7650A6]">
                        <ImageIcon className="h-5 w-5" />
                      </div>
                    )}
                    <div className="min-w-0 space-y-0.5">
                      <div className="truncate font-semibold text-[#170D2B]">{item.fileName}</div>
                      <div className="font-mono text-[11px] text-[#40205E]/70">
                        {formatUploadBytes(item.fileSize)} · {item.mimeType}
                      </div>
                      <div
                        className={`flex items-center gap-1 text-[11px] font-semibold ${
                          item.status === 'Upload failed'
                            ? 'text-red-700'
                            : item.status === 'Uploading'
                              ? 'text-[#7650A6]'
                              : item.status === 'Upload successful'
                                ? 'text-emerald-700'
                                : 'text-amber-700'
                        }`}
                      >
                        {item.status === 'Uploading' && (
                          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                        )}
                        {item.status === 'Upload successful' && (
                          <CheckCircle2 className="h-3 w-3 shrink-0" />
                        )}
                        {item.status === 'Upload failed' && (
                          <AlertCircle className="h-3 w-3 shrink-0" />
                        )}
                        <span>{item.status}</span>
                      </div>
                      {item.error && (
                        <div className="text-[11px] text-red-700 break-words">{item.error}</div>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {item.status === 'Upload failed' && (
                      <button
                        type="button"
                        disabled={uploadingField === field.name}
                        onClick={() => void uploadSingleImageItem(field, item)}
                        className="min-h-[34px] rounded-md border border-red-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        Retry Upload
                      </button>
                    )}
                    {isArray && (
                      <>
                        <label className="inline-flex min-h-[34px] cursor-pointer items-center rounded-md border border-[#40205E]/25 bg-white px-2.5 py-1 text-[11px] font-medium text-[#40205E] hover:bg-[#FAF6EC]">
                          <span>Replace</span>
                          <input
                            type="file"
                            accept={constraints.acceptAttr}
                            className="hidden"
                            disabled={uploadingField === field.name}
                            onChange={(e) => {
                              void handleImageFilesPicked(field, e.target.files, item.id);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => removeFieldUploadItem(field, item.id)}
                          className="min-h-[34px] rounded-md border border-red-200 bg-white p-1.5 text-red-600 hover:bg-red-50"
                          aria-label={`Remove ${item.fileName}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {isArray ? (
            field.itemType === 'object' ? (
              <textarea
                id={`${category}-field-${field.name}`}
                rows={4}
                value={Array.isArray(val) && val.length > 0 ? JSON.stringify(val, null, 2) : ''}
                onChange={(e) => {
                  const rawText = e.target.value.trim();
                  if (!rawText) {
                    setInputValues((prev) => ({ ...prev, [field.name]: [] }));
                    return;
                  }
                  try {
                    const parsed = JSON.parse(rawText);
                    if (Array.isArray(parsed)) {
                      setInputValues((prev) => ({ ...prev, [field.name]: parsed }));
                    }
                  } catch {
                    // keep typing until valid JSON
                  }
                }}
                placeholder="Upload an image above to populate structured entries, or paste valid JSON array..."
                className="w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-xs text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
              />
            ) : (
              <textarea
                id={`${category}-field-${field.name}`}
                rows={2}
                value={arrayList.join('\n')}
                onChange={(e) => {
                  const lines = e.target.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  setInputValues((prev) => ({ ...prev, [field.name]: lines }));
                }}
                placeholder="Upload an image above or paste verified https:// image URL(s)..."
                className="w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-xs text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
              />
            )
          ) : (
            <input
              id={`${category}-field-${field.name}`}
              type="url"
              value={singleVal}
              onChange={(e) =>
                setInputValues((prev) => ({ ...prev, [field.name]: e.target.value }))
              }
              placeholder="Upload an image above to populate the Kie.ai URL (https://...)"
              className="min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-xs text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
            />
          )}

          {field.description && (
            <p className="text-[11px] text-[#40205E]/75">{field.description}</p>
          )}
        </div>
      );
    }

    if (field.type === 'array' && isUrlField(field)) {
      const list = Array.isArray(val) ? (val as string[]) : [];
      const textValue = list.join('\n');
      const acceptFilter =
        mediaKind === 'video' ? 'video/*' : mediaKind === 'audio' ? 'audio/*' : 'image/*,video/*,audio/*';
      return (
        <div key={field.name} className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`${category}-field-${field.name}`} className="text-xs font-semibold text-[#170D2B]">
              {field.name} (URLs, one per line)
              {field.required && <span className="ml-1 text-red-600">*</span>}
            </label>
            <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg border border-[#C5A45A] bg-[#F4E8C9]/55 px-3 py-1.5 text-xs font-semibold text-[#170D2B] hover:bg-[#F4E8C9] whitespace-nowrap">
              {uploadingField === field.name ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#40205E]" />
              ) : (
                <Upload className="h-3.5 w-3.5 text-[#40205E]" />
              )}
              <span>Upload File</span>
              <input
                type="file"
                accept={acceptFilter}
                className="hidden"
                disabled={uploadingField === field.name}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileUpload(field.name, true, file);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <textarea
            id={`${category}-field-${field.name}`}
            rows={2}
            value={textValue}
            onChange={(e) => {
              const lines = e.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
              setInputValues((prev) => ({ ...prev, [field.name]: lines }));
            }}
            placeholder="https://..."
            className="mt-1.5 w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-xs text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
          />
          {field.description && (
            <p className="mt-1 text-[11px] text-[#40205E]/75">{field.description}</p>
          )}
        </div>
      );
    }

    if (field.type === 'string' && isUrlField(field)) {
      const str = typeof val === 'string' ? val : '';
      const acceptFilter =
        mediaKind === 'video' ? 'video/*' : mediaKind === 'audio' ? 'audio/*' : 'image/*,video/*,audio/*';
      const showUpload = mediaKind !== 'none';
      return (
        <div key={field.name} className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`${category}-field-${field.name}`} className="text-xs font-semibold text-[#170D2B]">
              {field.name}
              {field.required && <span className="ml-1 text-red-600">*</span>}
            </label>
            {showUpload && (
              <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg border border-[#C5A45A] bg-[#F4E8C9]/55 px-3 py-1.5 text-xs font-semibold text-[#170D2B] hover:bg-[#F4E8C9] whitespace-nowrap">
                {uploadingField === field.name ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#40205E]" />
                ) : (
                  <Upload className="h-3.5 w-3.5 text-[#40205E]" />
                )}
                <span>Upload</span>
                <input
                  type="file"
                  accept={acceptFilter}
                  className="hidden"
                  disabled={uploadingField === field.name}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFileUpload(field.name, false, file);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
          <input
            id={`${category}-field-${field.name}`}
            type="url"
            value={str}
            onChange={(e) =>
              setInputValues((prev) => ({ ...prev, [field.name]: e.target.value }))
            }
            placeholder="https://..."
            className="mt-1.5 min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-xs text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
          />
          {field.description && (
            <p className="mt-1 text-[11px] text-[#40205E]/75">{field.description}</p>
          )}
        </div>
      );
    }

    if (field.type === 'integer' || field.type === 'number') {
      const numVal = val !== undefined && val !== null ? String(val) : '';
      return (
        <div key={field.name} className="min-w-0">
          <label htmlFor={`${category}-field-${field.name}`} className="block text-xs font-semibold text-[#170D2B]">
            {field.name}
            {field.minimum !== undefined && field.maximum !== undefined && (
              <span className="ml-1.5 font-mono text-[11px] text-[#40205E]/70">
                ({field.minimum}–{field.maximum})
              </span>
            )}
            {field.required && <span className="ml-1 text-red-600">*</span>}
          </label>
          <input
            id={`${category}-field-${field.name}`}
            type="number"
            min={field.minimum}
            max={field.maximum}
            step={field.type === 'integer' ? 1 : 'any'}
            value={numVal}
            onChange={(e) =>
              setInputValues((prev) => ({
                ...prev,
                [field.name]: e.target.value === '' ? undefined : Number(e.target.value),
              }))
            }
            className="mt-1.5 min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-xs text-[#170D2B] focus:border-[#7650A6] focus:outline-none"
          />
          {field.description && (
            <p className="mt-1 text-[11px] text-[#40205E]/75">{field.description}</p>
          )}
        </div>
      );
    }

    return (
      <div key={field.name} className="min-w-0">
        <label htmlFor={`${category}-field-${field.name}`} className="block text-xs font-semibold text-[#170D2B]">
          {field.name}
          {field.required && <span className="ml-1 text-red-600">*</span>}
        </label>
        <input
          id={`${category}-field-${field.name}`}
          type="text"
          value={typeof val === 'string' ? val : ''}
          onChange={(e) =>
            setInputValues((prev) => ({ ...prev, [field.name]: e.target.value }))
          }
          className="mt-1.5 min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs text-[#170D2B] focus:border-[#7650A6] focus:outline-none"
        />
        {field.description && (
          <p className="mt-1 text-[11px] text-[#40205E]/75">{field.description}</p>
        )}
      </div>
    );
  }

  const remainingBalance =
    activeBalance !== null && costResult?.verified && costResult.exactCredits !== null
      ? Number((activeBalance - costResult.exactCredits).toFixed(4))
      : null;

  const canShowOutput =
    activeTask &&
    activeTask.status === 'Succeeded' &&
    activeTask.mediaVerified &&
    activeTask.resultUrls.length > 0 &&
    !mediaLoadError;

  const verifiedCount = categoryModels.filter((m) => m.verificationStatus === 'VERIFIED').length;
  const titleText = category === 'video' ? 'Video Generator' : 'Image Generator';

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Page Header & Sub-Navigation */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#C5A45A]/30 pb-5">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold tracking-tight text-[#170D2B] sm:text-2xl">
            {titleText}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#40205E]/80 tabular-nums">
            <span>{categoryModels.length} official {category} models</span>
            <span aria-hidden="true" className="text-[#C5A45A]">·</span>
            <span>{verifiedCount} verified &amp; callable</span>
            <span aria-hidden="true" className="text-[#C5A45A]">·</span>
            <span>
              Catalog synced: {syncedAt ? new Date(syncedAt).toLocaleString() : 'Syncing...'}
            </span>
            {catalogStale && (
              <>
                <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                <span className="font-mono font-semibold text-amber-700">STALE</span>
              </>
            )}
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto sm:gap-3">
          <div className="flex flex-1 items-center gap-1 rounded-xl border border-[#C5A45A]/30 bg-[#FAF6EC] p-1 sm:flex-initial">
            {(
              [
                { id: 'studio', label: 'Workspace' },
                { id: 'catalog', label: `Catalog (${categoryModels.length})` },
                { id: 'history', label: `History (${tasks.length})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSubView(tab.id)}
                className={`min-h-[38px] flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all whitespace-nowrap sm:flex-initial ${
                  subView === tab.id
                    ? 'bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                    : 'text-[#40205E]/80 hover:text-[#170D2B]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onSyncCatalog}
            disabled={catalogSyncing}
            className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border border-[#40205E]/25 bg-white px-3.5 py-2 text-xs font-semibold text-[#40205E] transition-colors hover:border-[#C5A45A] hover:bg-[#FAF6EC] disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-[#C5A45A] ${catalogSyncing ? 'animate-spin' : ''}`} />
            <span>{catalogSyncing ? 'Syncing...' : 'Sync Catalog'}</span>
          </button>
        </div>
      </div>

      {catalogError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">
            Live catalog sync warning ({catalogError}). Showing last verified catalog; unverified or stale pricing remains protected.
          </span>
        </div>
      )}

      {subView === 'catalog' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#C5A45A]/30 bg-white p-3.5 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.08)]">
            <div className="flex flex-wrap items-center gap-2.5">
              <select
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value)}
                aria-label="Filter by mode"
                className="min-h-[40px] rounded-lg border border-[#40205E]/25 bg-white px-3 py-1.5 text-xs font-semibold text-[#170D2B] focus:border-[#7650A6] focus:outline-none"
              >
                <option value="all">All {category === 'video' ? 'Video' : 'Image'} Modes</option>
                {allModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 px-2 text-xs font-semibold text-[#40205E]">
                <input
                  type="checkbox"
                  checked={verifiedOnly}
                  onChange={(e) => setVerifiedOnly(e.target.checked)}
                  className="h-4 w-4 rounded border-[#40205E]/30 accent-[#40205E]"
                />
                <span>Verified Only</span>
              </label>
            </div>
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#7650A6]" />
              <input
                type="search"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder={`Search ${category} models...`}
                className="min-h-[40px] w-full rounded-lg border border-[#40205E]/20 bg-[#FAF6EC]/60 py-1.5 pr-3 pl-8 text-xs text-[#170D2B] placeholder:text-[#7650A6]/65 focus:border-[#7650A6] focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filteredModels.map((model) => {
              const verified = model.verificationStatus === 'VERIFIED';
              return (
                <div
                  key={model.id}
                  className="flex min-w-0 flex-col justify-between rounded-xl border border-[#C5A45A]/30 bg-white p-5 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.08)] transition-colors hover:border-[#C5A45A]/70"
                >
                  <div className="min-w-0">
                    <div className="flex items-center justify-between gap-2 text-xs text-[#40205E]/75">
                      <div className="flex min-w-0 items-center gap-1.5 truncate">
                        <span className="font-semibold text-[#40205E]">{model.provider}</span>
                        <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                        <span className="truncate font-mono text-[11px]">{model.id}</span>
                      </div>
                      <span
                        className={`font-mono text-[11px] font-bold whitespace-nowrap ${
                          verified ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {model.verificationStatus}
                      </span>
                    </div>
                    <h2 className="mt-2 font-display text-base font-bold text-[#170D2B]">{model.title}</h2>
                    {model.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-[#40205E]/80">
                        {model.description}
                      </p>
                    )}
                    <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-[#C5A45A]/20 pt-3 text-xs">
                      <div>
                        <dt className="text-[#40205E]/70">Supported Modes</dt>
                        <dd className="mt-0.5 font-medium text-[#170D2B] break-words">
                          {model.modes.join(' · ')}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[#40205E]/70">Verified Starting Price</dt>
                        <dd className="mt-0.5 font-mono font-semibold text-[#170D2B] tabular-nums">
                          {model.pricingVerified && model.startingCredits !== null
                            ? `${model.startingCredits} cr ${model.pricingUnitLabel || ''}`
                            : 'Unavailable'}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-2 border-t border-[#C5A45A]/20 pt-3">
                    <a
                      href={model.docUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-[36px] items-center gap-1 text-xs font-semibold text-[#7650A6] hover:text-[#40205E]"
                    >
                      <span>Docs</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <button
                      type="button"
                      disabled={!verified}
                      onClick={() => {
                        setSelectedModelId(model.id);
                        setSubView('studio');
                      }}
                      className="min-h-[38px] rounded-lg border border-[#C5A45A] bg-[#C5A45A] px-3.5 py-1.5 text-xs font-semibold text-[#170D2B] transition-colors hover:bg-[#b5944c] disabled:cursor-not-allowed disabled:border-[#40205E]/15 disabled:bg-[#FAF6EC] disabled:text-[#40205E]/45 whitespace-nowrap"
                    >
                      {verified ? 'Select Model' : 'Unavailable'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {subView === 'history' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[#40205E]/80">
              {category === 'video' ? 'Video' : 'Image'} generation history stored locally on this device.
            </p>
            {tasks.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onTasksChange([]);
                  setActiveTaskId(null);
                }}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear {category === 'video' ? 'Video' : 'Image'} History</span>
              </button>
            )}
          </div>

          {tasks.length === 0 ? (
            <div className="rounded-xl border border-[#C5A45A]/30 bg-white p-10 text-center shadow-[0_4px_18px_-8px_rgba(23,13,43,0.06)]">
              <p className="text-sm font-semibold text-[#170D2B]">
                No {category} tasks recorded yet
              </p>
              <p className="mt-1 text-xs text-[#40205E]/75">
                Submitted {category} generations will appear here with real Kie.ai task IDs and outputs.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {tasks.map((t) => {
                const isTerminal =
                  t.status === 'Succeeded' || t.status === 'Failed' || t.status === 'Cancelled';
                const hasMedia =
                  t.status === 'Succeeded' && t.mediaVerified && t.resultUrls.length > 0;
                return (
                  <div
                    key={t.id}
                    className="rounded-xl border border-[#C5A45A]/30 bg-white p-4 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.08)] space-y-3 sm:p-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[#40205E]/75">
                          <span className="font-semibold text-[#40205E]">{t.generationMode}</span>
                          <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                          <span className="font-mono break-all">{t.modelId}</span>
                          <span aria-hidden="true" className="text-[#C5A45A]">·</span>
                          <span className="tabular-nums">
                            {new Date(t.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <h3 className="mt-1 font-display text-base font-bold text-[#170D2B]">
                          {t.modelTitle}
                        </h3>
                        {typeof t.input.prompt === 'string' && (
                          <p className="mt-1 max-w-3xl text-xs text-[#40205E]/85 break-words">
                            {t.input.prompt}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5">
                        {renderTaskStatusBadge(t.status)}
                        {!isTerminal && t.kieTaskId && (
                          <button
                            type="button"
                            onClick={() => void pollSpecificTask(t)}
                            className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-[#40205E]/25 bg-white px-2.5 py-1 text-xs font-semibold text-[#40205E] hover:bg-[#FAF6EC]"
                          >
                            <RefreshCw className="h-3 w-3" />
                            <span>Refresh</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <dl className="grid grid-cols-2 gap-3 border-t border-[#C5A45A]/20 pt-3 text-xs sm:grid-cols-4">
                      <div className="min-w-0">
                        <dt className="text-[#40205E]/70">Kie.ai Task ID</dt>
                        <dd className="mt-0.5 font-mono text-[#170D2B] break-all">
                          {t.kieTaskId || 'Not assigned'}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-[#40205E]/70">Key Used</dt>
                        <dd className="mt-0.5 font-mono text-[#170D2B] break-words">
                          {t.keyLabelUsed ? `${t.keyLabelUsed} (${t.maskedKeyUsed})` : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[#40205E]/70">Verified Cost</dt>
                        <dd className="mt-0.5 font-mono font-semibold text-[#170D2B] tabular-nums">
                          {t.creditsConsumed ?? t.verifiedCost} cr
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[#40205E]/70">API Raw State</dt>
                        <dd className="mt-0.5 font-mono text-[#40205E]">
                          {t.rawState || t.status}
                        </dd>
                      </div>
                    </dl>

                    {t.errorMessage && (
                      <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 break-words">{t.errorMessage}</span>
                      </div>
                    )}

                    {hasMedia && (
                      <div className="grid grid-cols-1 gap-4 border-t border-[#C5A45A]/20 pt-3 sm:grid-cols-2">
                        {t.resultUrls.map((url, idx) => (
                          <div
                            key={url}
                            className="overflow-hidden rounded-lg border border-[#C5A45A]/30 bg-[#FAF6EC]/40"
                          >
                            {t.category === 'image' ? (
                              <img
                                src={url}
                                alt={`Output ${idx + 1}`}
                                referrerPolicy="no-referrer"
                                className="max-h-80 w-full object-contain bg-[#FAF6EC]"
                              />
                            ) : (
                              <video
                                src={url}
                                controls
                                playsInline
                                className="max-h-80 w-full bg-[#170D2B]"
                              />
                            )}
                            <div className="flex items-center justify-between gap-2 border-t border-[#C5A45A]/25 bg-white px-3 py-2 text-xs">
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[#7650A6] hover:text-[#40205E]"
                              >
                                <ExternalLink className="h-3 w-3 shrink-0" />
                                <span className="truncate">Source URL</span>
                              </a>
                              <button
                                type="button"
                                disabled={downloadingKey === `${t.id}-${idx}`}
                                onClick={() => void handleDownload(t, url, idx)}
                                className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-[#40205E] px-3 py-1.5 font-semibold text-[#F4E8C9] hover:bg-[#170D2B] whitespace-nowrap shrink-0"
                              >
                                <Download className="h-3.5 w-3.5 text-[#C5A45A]" />
                                <span>
                                  {downloadingKey === `${t.id}-${idx}`
                                    ? 'Downloading...'
                                    : 'Download'}
                                </span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {subView === 'studio' && (
        <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-12">
          {/* Left Column: Model Selection & OpenAPI Parameters */}
          <div className="min-w-0 space-y-5 sm:space-y-6 lg:col-span-7">
            <div className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] sm:p-6">
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-12">
                <div className="min-w-0 sm:col-span-5">
                  <label htmlFor={`${category}-model-search`} className="block text-xs font-semibold text-[#170D2B]">
                    Search {category === 'video' ? 'Video' : 'Image'} Models
                  </label>
                  <input
                    id={`${category}-model-search`}
                    type="search"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder={
                      category === 'video' ? 'Search Veo, Kling, Seedance...' : 'Search Flux, Imagen, Ideogram...'
                    }
                    className="mt-1.5 min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
                  />
                </div>
                <div className="min-w-0 sm:col-span-7">
                  <label htmlFor={`${category}-model-select`} className="block text-xs font-semibold text-[#170D2B]">
                    Selected Model ({filteredModels.length})
                  </label>
                  <select
                    id={`${category}-model-select`}
                    value={activeModel?.id || ''}
                    onChange={(e) => setSelectedModelId(e.target.value)}
                    className="mt-1.5 min-h-[42px] w-full max-w-full min-w-0 rounded-lg border border-[#40205E]/30 bg-white px-3 py-2 text-xs font-semibold text-[#170D2B] focus:border-[#7650A6] focus:outline-none sm:text-sm"
                  >
                    {filteredModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title} —{' '}
                        {m.verificationStatus === 'VERIFIED' && m.startingCredits !== null
                          ? `${m.startingCredits} cr ${m.pricingUnitLabel || ''}`
                          : `[${m.verificationStatus}]`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {activeModel && (
                <div className="mt-4 border-t border-[#C5A45A]/20 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#40205E]/80">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-semibold text-[#40205E]">{activeModel.provider}</span>
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
                    </div>
                    <span className="font-mono text-[11px] text-[#40205E]/70 break-all">
                      {activeModel.endpointPath}
                    </span>
                  </div>

                  {activeModel.modes.length > 0 && (
                    <div className="mt-3.5">
                      <span className="block text-xs font-semibold text-[#170D2B]">
                        Generation Mode
                      </span>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {activeModel.modes.map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setSelectedMode(mode)}
                            className={`min-h-[38px] rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                              selectedMode === mode
                                ? 'border-[#40205E] bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                                : 'border-[#40205E]/20 bg-white text-[#170D2B] hover:border-[#C5A45A] hover:bg-[#FAF6EC]'
                            }`}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Dynamic OpenAPI Parameter Form */}
            <form
              onSubmit={handleGenerate}
              className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] space-y-5 sm:p-6"
            >
              <div className="flex items-center justify-between border-b border-[#C5A45A]/25 pb-3">
                <h2 className="font-display text-sm font-bold text-[#170D2B]">
                  Official OpenAPI Parameters
                </h2>
                {loadingSpec && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#7650A6]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Loading schema...</span>
                  </span>
                )}
              </div>

              {!activeModel ? (
                <p className="text-sm text-[#40205E]/75">Synchronizing live Kie.ai catalog...</p>
              ) : activeModel.fields.length === 0 ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900">
                  OpenAPI input parameters could not be verified for this model. Generation is disabled.
                </div>
              ) : (
                <div className="space-y-4">
                  {category === 'video' && !hasImageInputSupport(activeModel) && (
                    <div className="rounded-lg border border-[#C5A45A]/30 bg-[#FAF6EC] px-3.5 py-2.5 text-xs text-[#40205E]">
                      This model does not support Image-to-Video.
                    </div>
                  )}
                  {activeModel.fields.map((f) => renderFieldControl(f))}
                </div>
              )}

              {submitError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-xs text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">{submitError}</span>
                </div>
              )}

              {rotationNotice && (
                <div className="flex items-start gap-2 rounded-lg border border-[#C5A45A]/45 bg-[#F4E8C9]/55 px-3.5 py-3 text-xs text-[#170D2B]">
                  <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-[#40205E]" />
                  <span className="min-w-0 break-words">{rotationNotice}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#C5A45A]/25 pt-4">
                <div className="min-w-0 flex-1 text-xs">
                  {paramValidationError ? (
                    <span className="font-medium text-red-700">{paramValidationError}</span>
                  ) : !keyEligibility.eligible ? (
                    <span className="font-medium text-red-700">{keyEligibility.reason}</span>
                  ) : keyEligibility.willRotate ? (
                    <span className="font-medium text-[#7650A6]">
                      Active key has insufficient credits — will rotate to {keyEligibility.targetKey?.label}.
                    </span>
                  ) : (
                    <span className="font-medium text-emerald-700">
                      All pre-generation checks passed. Ready for real Kie.ai API call.
                    </span>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-[#C5A45A] bg-[#C5A45A] px-5 py-2.5 text-sm font-bold text-[#170D2B] shadow-xs transition-colors hover:bg-[#b5944c] disabled:cursor-not-allowed disabled:border-[#40205E]/15 disabled:bg-[#F4E8C9]/50 disabled:text-[#40205E]/45 whitespace-nowrap sm:w-auto sm:shrink-0"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span>
                    {localPhase !== 'idle'
                      ? `${localPhase}...`
                      : costResult?.verified && costResult.exactCredits !== null
                        ? `Generate ${category === 'video' ? 'Video' : 'Image'} (${costResult.exactCredits} cr)`
                        : 'Generate'}
                  </span>
                </button>
              </div>
            </form>
          </div>

          {/* Right Column: Live Balance, Cost, Affordability & Real Output */}
          <div className="min-w-0 space-y-5 sm:space-y-6 lg:col-span-5">
            <div className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] space-y-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-sm font-bold text-[#170D2B]">Balance &amp; Exact Cost</h2>
                <button
                  type="button"
                  onClick={onGoToKeys}
                  className="min-h-[34px] text-xs font-semibold text-[#7650A6] hover:text-[#40205E] hover:underline whitespace-nowrap"
                >
                  API Key Manager ({keys.length}/10)
                </button>
              </div>

              <div>
                <label htmlFor={`${category}-key-select`} className="block text-xs font-semibold text-[#170D2B]">
                  API Key Selection {autoRotateEnabled ? '· Auto-Rotation On' : '· Manual'}
                </label>
                <select
                  id={`${category}-key-select`}
                  value={preferredKeyId}
                  onChange={(e) => setPreferredKeyId(e.target.value)}
                  className="mt-1.5 min-h-[42px] w-full max-w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs text-[#170D2B] focus:border-[#7650A6] focus:outline-none"
                >
                  <option value="">
                    Active Key ({selectedKey ? `${selectedKey.label}` : 'None saved'})
                  </option>
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label} ({k.maskedKey}) —{' '}
                      {k.balance !== null ? `${k.balance} credits` : k.status}
                    </option>
                  ))}
                </select>
              </div>

              <dl className="grid grid-cols-3 gap-2 border-t border-[#C5A45A]/20 pt-4 sm:gap-3">
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[#40205E]/75">Current Balance</dt>
                  <dd className="mt-1 font-mono text-sm font-bold text-[#170D2B] tabular-nums sm:text-base">
                    {activeBalance !== null ? `${activeBalance} cr` : '—'}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[#40205E]/75">Exact Cost</dt>
                  <dd className="mt-1 font-mono text-sm font-bold text-[#40205E] tabular-nums sm:text-base">
                    {costResult?.verified && costResult.exactCredits !== null
                      ? `${costResult.exactCredits} cr`
                      : 'Unavailable'}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[#40205E]/75">Est. Remaining</dt>
                  <dd
                    className={`mt-1 font-mono text-sm font-bold tabular-nums sm:text-base ${
                      remainingBalance !== null && remainingBalance < 0
                        ? 'text-red-700'
                        : 'text-[#170D2B]'
                    }`}
                  >
                    {remainingBalance !== null ? `${remainingBalance} cr` : '—'}
                  </dd>
                </div>
              </dl>

              {costResult?.verified && costResult.breakdown.length > 0 && (
                <div className="border-t border-[#C5A45A]/20 pt-3 text-xs text-[#40205E]/85">
                  {costResult.breakdown.map((line, i) => (
                    <div key={i} className="font-mono text-[11px] break-words">
                      {line}
                    </div>
                  ))}
                </div>
              )}

              {costResult && !costResult.verified && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">
                    {costResult.reason || 'Pricing unavailable — generation temporarily disabled.'}
                  </span>
                </div>
              )}
            </div>

            {/* Affordability Matrix (Current Balance vs 80-Credit Benchmark) */}
            <div className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] space-y-3 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-sm font-bold text-[#170D2B]">Affordability Calculator</h2>
                <div className="flex items-center gap-1 rounded-lg border border-[#C5A45A]/30 bg-[#FAF6EC] p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setAffordMode('balance')}
                    className={`min-h-[32px] rounded-md px-2.5 py-1 font-semibold transition-colors ${
                      affordMode === 'balance'
                        ? 'bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                        : 'text-[#40205E]/80 hover:text-[#170D2B]'
                    }`}
                  >
                    Live Balance ({activeBalance ?? '—'})
                  </button>
                  <button
                    type="button"
                    onClick={() => setAffordMode('benchmark80')}
                    className={`min-h-[32px] rounded-md px-2.5 py-1 font-semibold transition-colors ${
                      affordMode === 'benchmark80'
                        ? 'bg-[#40205E] text-[#F4E8C9] shadow-2xs'
                        : 'text-[#40205E]/80 hover:text-[#170D2B]'
                    }`}
                  >
                    80-Credit Reference
                  </button>
                </div>
              </div>

              {!affordability?.verified ? (
                <p className="text-xs text-[#40205E]/75">
                  {affordability?.reason || 'Pricing unavailable for affordability calculation.'}
                </p>
              ) : (
                <>
                  <div className="divide-y divide-[#C5A45A]/20 border-t border-b border-[#C5A45A]/20 text-xs">
                    {affordability.options.map((opt) => (
                      <div
                        key={String(opt.value)}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <span className="font-medium text-[#170D2B]">{opt.label}</span>
                        <div className="flex items-center gap-2.5 font-mono tabular-nums">
                          <span className="text-[#170D2B]">{opt.credits} credits</span>
                          {effectiveAffordBalance !== null && (
                            <span
                              className={
                                opt.affordable ? 'font-semibold text-emerald-700' : 'font-semibold text-red-600'
                              }
                            >
                              {opt.affordable ? 'Affordable' : 'Exceeds balance'}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1 text-xs">
                    <span className="text-[#40205E]/80">
                      {category === 'video'
                        ? 'Max affordable duration:'
                        : 'Max affordable output count:'}
                    </span>
                    <span className="font-mono font-bold text-[#170D2B] tabular-nums">
                      {affordability.maxAffordableLabel || 'Verify API key'}
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Real Active Task Status & Output Panel */}
            <div className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] space-y-4 sm:p-6">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-sm font-bold text-[#170D2B]">
                  Real Task Status &amp; Output
                </h2>
                {activeTask && activeTask.kieTaskId && (
                  <button
                    type="button"
                    onClick={() => void pollSpecificTask(activeTask)}
                    className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-[#40205E]/20 bg-white px-2.5 py-1 text-xs font-semibold text-[#40205E] hover:bg-[#FAF6EC]"
                  >
                    <RefreshCw className="h-3 w-3 text-[#C5A45A]" />
                    <span>Refresh</span>
                  </button>
                )}
              </div>

              {localPhase !== 'idle' ? (
                <div className="flex items-center gap-3 rounded-lg border border-[#C5A45A]/40 bg-[#FAF6EC] p-4 text-xs font-medium text-[#170D2B]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#40205E]" />
                  <span>{localPhase} real request against Kie.ai API...</span>
                </div>
              ) : !activeTask ? (
                <div className="rounded-lg border border-[#C5A45A]/25 bg-[#FAF6EC]/60 p-6 text-center text-xs text-[#40205E]/80">
                  Submit a validated {category} generation request to receive a real Kie.ai task ID and live output.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C5A45A]/20 pb-3">
                    {renderTaskStatusBadge(activeTask.status)}
                    <span className="font-mono text-[11px] text-[#40205E]/75">
                      {activeTask.rawState ? `API state: ${activeTask.rawState}` : ''}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-3 text-xs">
                    <div className="min-w-0">
                      <dt className="text-[#40205E]/70">Kie.ai Task ID</dt>
                      <dd className="mt-0.5 font-mono text-[#170D2B] break-all">
                        {activeTask.kieTaskId || 'Not assigned'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[#40205E]/70">API Key Used</dt>
                      <dd className="mt-0.5 font-mono text-[#170D2B] break-words">
                        {activeTask.keyLabelUsed
                          ? `${activeTask.keyLabelUsed} (${activeTask.maskedKeyUsed})`
                          : '—'}
                      </dd>
                    </div>
                  </dl>

                  {(activeTask.status === 'Queued' || activeTask.status === 'Processing') && (
                    <div className="flex items-center gap-2.5 rounded-lg border border-[#7650A6]/30 bg-[#FAF6EC] px-3.5 py-3 text-xs font-medium text-[#40205E]">
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#7650A6]" />
                      <span>
                        Task is {activeTask.status.toLowerCase()} on Kie.ai. Polling official recordInfo endpoint...
                      </span>
                    </div>
                  )}

                  {activeTask.errorMessage && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-xs text-red-700">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div className="min-w-0 break-words">
                        {activeTask.errorCode && (
                          <span className="mr-1.5 font-mono font-semibold">
                            [{activeTask.errorCode}]
                          </span>
                        )}
                        <span>{activeTask.errorMessage}</span>
                      </div>
                    </div>
                  )}

                  {canShowOutput && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <span>Generation completed successfully.</span>
                      </div>
                      {activeTask.resultUrls.map((url, idx) => (
                        <div
                          key={url}
                          className="overflow-hidden rounded-lg border border-[#C5A45A]/35 bg-[#FAF6EC]/40"
                        >
                          {category === 'image' ? (
                            <img
                              src={url}
                              alt={`Generated image ${idx + 1}`}
                              referrerPolicy="no-referrer"
                              onError={() => setMediaLoadError(true)}
                              className="max-h-[420px] w-full object-contain bg-[#FAF6EC]"
                            />
                          ) : (
                            <video
                              src={url}
                              controls
                              playsInline
                              onError={() => setMediaLoadError(true)}
                              className="max-h-[420px] w-full bg-[#170D2B]"
                            />
                          )}
                          <div className="flex items-center justify-between gap-2 border-t border-[#C5A45A]/25 bg-white px-3 py-2 text-xs">
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[#7650A6] hover:text-[#40205E]"
                            >
                              <ExternalLink className="h-3 w-3 shrink-0" />
                              <span className="truncate">Source URL</span>
                            </a>
                            <button
                              type="button"
                              disabled={downloadingKey === `${activeTask.id}-${idx}`}
                              onClick={() => void handleDownload(activeTask, url, idx)}
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-[#40205E] px-3 py-1.5 font-semibold text-[#F4E8C9] hover:bg-[#170D2B] whitespace-nowrap shrink-0"
                            >
                              <Download className="h-3.5 w-3.5 text-[#C5A45A]" />
                              <span>
                                {downloadingKey === `${activeTask.id}-${idx}`
                                  ? 'Downloading...'
                                  : 'Download'}
                              </span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {mediaLoadError && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        Unable to load returned media preview. Use Download or inspect Source URL.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
