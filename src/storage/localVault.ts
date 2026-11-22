import type {
  ChatConversation,
  KeyStatus,
  LocalApiKey,
  LocalMediaTask,
} from '../types';

const STORAGE_KEYS = {
  deviceId: 'kie_studio_v2_device_id',
  keys: 'kie_studio_v2_keys',
  prefs: 'kie_studio_v2_prefs',
  videoTasks: 'kie_studio_v2_video_tasks',
  imageTasks: 'kie_studio_v2_image_tasks',
  chats: 'kie_studio_v2_chat_conversations',
} as const;

export const MAX_LOCAL_KEYS = 10;

export interface LocalPreferences {
  autoRotateEnabled: boolean;
}

export function maskApiKey(rawKey: string): string {
  const cleaned = rawKey.trim();
  if (cleaned.length <= 8) {
    return `${cleaned.slice(0, 2)}••••${cleaned.slice(-2)}`;
  }
  return `${cleaned.slice(0, 4)}••••${cleaned.slice(-4)}`;
}

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.deviceId);
    if (existing && existing.trim()) return existing.trim();
    const fresh = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEYS.deviceId, fresh);
    return fresh;
  } catch {
    return 'local-browser-session';
  }
}

export function loadLocalKeys(): LocalApiKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.keys);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as LocalApiKey[])
      .filter((k) => k && typeof k.id === 'string' && typeof k.apiKey === 'string')
      .sort((a, b) => a.priorityOrder - b.priorityOrder);
  } catch {
    return [];
  }
}

export function saveLocalKeys(keys: LocalApiKey[]): LocalApiKey[] {
  // Ensure exactly one active key if any keys exist
  let hasActive = keys.some((k) => k.isActive);
  const normalized = keys.slice(0, MAX_LOCAL_KEYS).map((k, idx) => {
    const isActive = hasActive ? k.isActive : idx === 0;
    if (isActive) hasActive = true;
    return {
      ...k,
      priorityOrder: idx,
      isActive,
    };
  });
  try {
    localStorage.setItem(STORAGE_KEYS.keys, JSON.stringify(normalized));
  } catch {
    // storage quota ignored gracefully
  }
  return normalized;
}

export function addLocalKeyEntry(
  existingKeys: LocalApiKey[],
  label: string,
  rawKey: string,
  verification: {
    status: KeyStatus;
    balance: number | null;
    error?: string;
    checkedAt: number;
  }
): LocalApiKey[] {
  if (existingKeys.length >= MAX_LOCAL_KEYS) {
    throw new Error(`Maximum of ${MAX_LOCAL_KEYS} local API keys reached.`);
  }
  const trimmedKey = rawKey.trim();
  if (!trimmedKey || trimmedKey.length < 10) {
    throw new Error('Please enter a valid Kie.ai API key.');
  }
  if (existingKeys.some((k) => k.apiKey === trimmedKey)) {
    throw new Error('This API key is already saved on this device.');
  }

  const slotNum = existingKeys.length + 1;
  const padded = String(slotNum).padStart(2, '0');
  const cleanLabel = label.trim() || `API KEY ${padded}`;

  const entry: LocalApiKey = {
    id: crypto.randomUUID(),
    label: cleanLabel,
    apiKey: trimmedKey,
    maskedKey: maskApiKey(trimmedKey),
    status: verification.status,
    balance: verification.balance,
    lastCheckedAt: verification.checkedAt,
    lastError: verification.error ?? null,
    isActive: existingKeys.length === 0,
    priorityOrder: existingKeys.length,
    createdAt: Date.now(),
  };

  return saveLocalKeys([...existingKeys, entry]);
}

export function replaceLocalKeyEntry(
  existingKeys: LocalApiKey[],
  id: string,
  label: string | undefined,
  rawKey: string,
  verification: {
    status: KeyStatus;
    balance: number | null;
    error?: string;
    checkedAt: number;
  }
): LocalApiKey[] {
  const trimmedKey = rawKey.trim();
  if (!trimmedKey || trimmedKey.length < 10) {
    throw new Error('Please enter a valid replacement Kie.ai API key.');
  }
  if (existingKeys.some((k) => k.id !== id && k.apiKey === trimmedKey)) {
    throw new Error('That API key is already stored in another slot on this device.');
  }

  const updated = existingKeys.map((k) =>
    k.id === id
      ? {
          ...k,
          label: label?.trim() ? label.trim() : k.label,
          apiKey: trimmedKey,
          maskedKey: maskApiKey(trimmedKey),
          status: verification.status,
          balance: verification.balance,
          lastCheckedAt: verification.checkedAt,
          lastError: verification.error ?? null,
        }
      : k
  );
  return saveLocalKeys(updated);
}

export function updateLocalKeyVerification(
  existingKeys: LocalApiKey[],
  id: string,
  patch: {
    status: KeyStatus;
    balance: number | null;
    lastError?: string | null;
    checkedAt?: number;
  }
): LocalApiKey[] {
  const updated = existingKeys.map((k) =>
    k.id === id
      ? {
          ...k,
          status: patch.status,
          balance: patch.balance !== null ? patch.balance : k.balance,
          lastError: patch.lastError !== undefined ? patch.lastError : null,
          lastCheckedAt: patch.checkedAt ?? Date.now(),
        }
      : k
  );
  return saveLocalKeys(updated);
}

export function setActiveLocalKey(existingKeys: LocalApiKey[], id: string): LocalApiKey[] {
  const updated = existingKeys.map((k) => ({
    ...k,
    isActive: k.id === id,
  }));
  return saveLocalKeys(updated);
}

export function removeLocalKeyEntry(existingKeys: LocalApiKey[], id: string): LocalApiKey[] {
  const filtered = existingKeys.filter((k) => k.id !== id);
  return saveLocalKeys(filtered);
}

export function getCandidateKeysInOrder(
  keys: LocalApiKey[],
  preferredKeyId?: string
): LocalApiKey[] {
  const primary =
    (preferredKeyId ? keys.find((k) => k.id === preferredKeyId) : undefined) ||
    keys.find((k) => k.isActive) ||
    keys[0];
  if (!primary) return [];
  return [primary, ...keys.filter((k) => k.id !== primary.id)];
}

export function loadPreferences(): LocalPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.prefs);
    if (!raw) return { autoRotateEnabled: true };
    const parsed = JSON.parse(raw) as Partial<LocalPreferences>;
    return {
      autoRotateEnabled:
        typeof parsed.autoRotateEnabled === 'boolean' ? parsed.autoRotateEnabled : true,
    };
  } catch {
    return { autoRotateEnabled: true };
  }
}

export function savePreferences(prefs: LocalPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEYS.prefs, JSON.stringify(prefs));
  } catch {
    // ignore storage quota errors
  }
}

export function loadMediaHistory(category: 'video' | 'image'): LocalMediaTask[] {
  const key = category === 'video' ? STORAGE_KEYS.videoTasks : STORAGE_KEYS.imageTasks;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocalMediaTask[]) : [];
  } catch {
    return [];
  }
}

export function saveMediaHistory(category: 'video' | 'image', tasks: LocalMediaTask[]): void {
  const key = category === 'video' ? STORAGE_KEYS.videoTasks : STORAGE_KEYS.imageTasks;
  try {
    localStorage.setItem(key, JSON.stringify(tasks.slice(0, 80)));
  } catch {
    // ignore
  }
}

export function loadChatConversations(): ChatConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.chats);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatConversation[]) : [];
  } catch {
    return [];
  }
}

export function saveChatConversations(conversations: ChatConversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.chats, JSON.stringify(conversations.slice(0, 100)));
  } catch {
    // ignore
  }
}

export function clearAllLocalData(): void {
  try {
    Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}
