import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, KeyRound, Sparkles } from 'lucide-react';
import { api } from './api';
import { ChatGeneratorView } from './components/ChatGeneratorView';
import { KeyManagerView } from './components/KeyManagerView';
import { MediaGeneratorView } from './components/MediaGeneratorView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAControls';
import {
  clearAllLocalData,
  getOrCreateDeviceId,
  loadChatConversations,
  loadLocalKeys,
  loadMediaHistory,
  loadPreferences,
  saveChatConversations,
  saveLocalKeys,
  saveMediaHistory,
  savePreferences,
  updateLocalKeyVerification,
} from './storage/localVault';
import type {
  CatalogModel,
  ChatConversation,
  KeyStatus,
  LocalApiKey,
  LocalMediaTask,
} from './types';

type GeneratorKind = 'image' | 'video' | 'chat';
type ActiveMenu = GeneratorKind | 'keys';

const GENERATOR_OPTIONS: Array<{ id: GeneratorKind; label: string }> = [
  { id: 'image', label: 'Image Generator' },
  { id: 'video', label: 'Video Generator' },
  { id: 'chat', label: 'Chat Generator' },
];

export default function App() {
  const [activeGenerator, setActiveGenerator] = useState<GeneratorKind>('image');
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>('image');
  const [deviceId] = useState<string>(() => getOrCreateDeviceId());

  const [models, setModels] = useState<CatalogModel[]>([]);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [catalogSyncing, setCatalogSyncing] = useState(false);
  const [catalogStale, setCatalogStale] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [keys, setKeys] = useState<LocalApiKey[]>(() => loadLocalKeys());
  const [autoRotateEnabled, setAutoRotateEnabled] = useState<boolean>(
    () => loadPreferences().autoRotateEnabled
  );
  const [videoTasks, setVideoTasks] = useState<LocalMediaTask[]>(() =>
    loadMediaHistory('video')
  );
  const [imageTasks, setImageTasks] = useState<LocalMediaTask[]>(() =>
    loadMediaHistory('image')
  );
  const [chatConversations, setChatConversations] = useState<ChatConversation[]>(() =>
    loadChatConversations()
  );

  const loadCatalog = useCallback(async () => {
    setCatalogSyncing(true);
    try {
      const cat = await api.getCatalog();
      setModels(cat.models);
      setSyncedAt(cat.syncedAt);
      setCatalogSyncing(cat.syncing);
      setCatalogStale(cat.stale);
      setCatalogError(cat.lastError);
    } catch (err) {
      setCatalogStale(true);
      setCatalogError(err instanceof Error ? err.message : 'Unable to fetch catalog.');
      setCatalogSyncing(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  async function handleSyncCatalog() {
    setCatalogSyncing(true);
    setCatalogError(null);
    try {
      const res = await api.syncCatalog(false);
      setModels(res.models);
      setSyncedAt(res.syncedAt);
      setCatalogStale(res.stale);
      setCatalogError(res.lastError);
    } catch (err) {
      setCatalogStale(true);
      setCatalogError(err instanceof Error ? err.message : 'Catalog sync failed.');
    } finally {
      setCatalogSyncing(false);
    }
  }

  function handleSelectGenerator(next: GeneratorKind) {
    setActiveGenerator(next);
    setActiveMenu(next);
  }

  function handleKeysChange(nextKeys: LocalApiKey[]) {
    const normalized = saveLocalKeys(nextKeys);
    setKeys(normalized);
  }

  function handleUpdateKeyVerification(
    keyId: string,
    patch: { status: KeyStatus; balance: number | null; lastError?: string | null }
  ) {
    setKeys((prev) => updateLocalKeyVerification(prev, keyId, patch));
  }

  function handleToggleAutoRotate(enabled: boolean) {
    setAutoRotateEnabled(enabled);
    savePreferences({ autoRotateEnabled: enabled });
  }

  function handleVideoTasksChange(next: LocalMediaTask[]) {
    setVideoTasks(next);
    saveMediaHistory('video', next);
  }

  function handleImageTasksChange(next: LocalMediaTask[]) {
    setImageTasks(next);
    saveMediaHistory('image', next);
  }

  function handleChatsChange(next: ChatConversation[]) {
    setChatConversations(next);
    saveChatConversations(next);
  }

  function handleClearAllLocalData() {
    clearAllLocalData();
    setKeys([]);
    setVideoTasks([]);
    setImageTasks([]);
    setChatConversations([]);
    setAutoRotateEnabled(true);
  }

  const activeKey = useMemo(
    () => keys.find((k) => k.isActive) || keys[0] || null,
    [keys]
  );

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#FCFBF7] text-[#170D2B] pwa-safe-bottom">
      {/* Subtle Imperial Amethyst Gold Ambient Header Strip */}
      <header className="sticky top-0 z-30 border-b border-[#C5A45A]/35 bg-[#FCFBF7]/95 backdrop-blur-md pwa-safe-top">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:flex-nowrap sm:gap-6 sm:px-6">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveMenu(activeGenerator)}
            className="inline-flex min-h-[40px] items-center gap-2.5 text-left shrink-0 group"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#C5A45A]/60 bg-[#40205E] text-[#F4E8C9] shadow-xs transition-colors group-hover:bg-[#170D2B]">
              <Sparkles className="h-4 w-4 text-[#C5A45A]" />
            </span>
            <span className="flex flex-col">
              <span className="font-display text-sm font-bold tracking-tight text-[#170D2B] sm:text-base whitespace-nowrap">
                Kie Studio
              </span>
              <span className="hidden text-[10px] font-medium tracking-wide text-[#7650A6] sm:block">
                Official Kie.ai Console
              </span>
            </span>
          </button>

          {/* Zone 2: Generator View Dropdown + API Key Manager Switch */}
          <div className="order-3 flex w-full items-center gap-2 border-t border-[#C5A45A]/20 pt-2.5 sm:order-2 sm:w-auto sm:flex-1 sm:justify-center sm:border-t-0 sm:pt-0">
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-initial">
              <label
                htmlFor="generator-view-select"
                className="hidden text-xs font-semibold tracking-wide text-[#40205E] md:inline whitespace-nowrap"
              >
                Generator View
              </label>
              <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-initial">
                <select
                  id="generator-view-select"
                  aria-label="Generator View"
                  value={activeMenu === 'keys' ? activeGenerator : activeMenu}
                  onChange={(e) => handleSelectGenerator(e.target.value as GeneratorKind)}
                  className={`min-h-[42px] w-full appearance-none rounded-lg border py-2 pr-9 pl-3.5 text-xs font-semibold shadow-2xs transition-colors focus:border-[#7650A6] focus:outline-none sm:text-sm ${
                    activeMenu !== 'keys'
                      ? 'border-[#40205E]/35 bg-white text-[#170D2B]'
                      : 'border-[#C5A45A]/45 bg-[#FAF6EC] text-[#40205E]'
                  }`}
                >
                  {GENERATOR_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-[#40205E]"
                />
              </div>
            </div>

            {activeMenu === 'keys' && (
              <button
                type="button"
                onClick={() => setActiveMenu(activeGenerator)}
                className="min-h-[42px] rounded-lg border border-[#C5A45A]/50 bg-[#F4E8C9]/55 px-3 py-2 text-xs font-semibold text-[#170D2B] transition-colors hover:bg-[#F4E8C9] whitespace-nowrap shrink-0"
              >
                Back to Studio
              </button>
            )}
          </div>

          {/* Zone 3: PWA Install + API Key Manager Action */}
          <div className="order-2 flex items-center gap-2 shrink-0 sm:order-3">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => setActiveMenu('keys')}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold whitespace-nowrap shrink-0 transition-all ${
                activeMenu === 'keys'
                  ? 'border border-[#C5A45A] bg-[#40205E] text-[#F4E8C9] shadow-xs'
                  : activeKey
                    ? 'border border-[#C5A45A]/50 bg-white text-[#170D2B] hover:border-[#40205E]/40 hover:bg-[#FAF6EC] font-mono tabular-nums'
                    : 'border border-[#C5A45A] bg-[#C5A45A] text-[#170D2B] hover:bg-[#b5944c]'
              }`}
            >
              <KeyRound className={`h-3.5 w-3.5 shrink-0 ${activeMenu === 'keys' ? 'text-[#C5A45A]' : 'text-[#40205E]'}`} />
              <span className="max-w-[140px] truncate sm:max-w-none">
                {activeKey
                  ? `${activeKey.label} · ${
                      activeKey.balance !== null ? `${activeKey.balance} cr` : activeKey.status
                    }`
                  : 'API Key Manager'}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 sm:py-8">
        {/* Keep generator views mounted across Generator View switches so draft inputs, selected models & uploads never get lost */}
        <section className={activeMenu === 'image' ? 'block' : 'hidden'} aria-hidden={activeMenu !== 'image'}>
          <MediaGeneratorView
            key="image"
            category="image"
            models={models}
            syncedAt={syncedAt}
            catalogSyncing={catalogSyncing}
            catalogStale={catalogStale}
            catalogError={catalogError}
            onSyncCatalog={handleSyncCatalog}
            keys={keys}
            autoRotateEnabled={autoRotateEnabled}
            onUpdateKeyVerification={handleUpdateKeyVerification}
            tasks={imageTasks}
            onTasksChange={handleImageTasksChange}
            onGoToKeys={() => setActiveMenu('keys')}
          />
        </section>

        <section className={activeMenu === 'video' ? 'block' : 'hidden'} aria-hidden={activeMenu !== 'video'}>
          <MediaGeneratorView
            key="video"
            category="video"
            models={models}
            syncedAt={syncedAt}
            catalogSyncing={catalogSyncing}
            catalogStale={catalogStale}
            catalogError={catalogError}
            onSyncCatalog={handleSyncCatalog}
            keys={keys}
            autoRotateEnabled={autoRotateEnabled}
            onUpdateKeyVerification={handleUpdateKeyVerification}
            tasks={videoTasks}
            onTasksChange={handleVideoTasksChange}
            onGoToKeys={() => setActiveMenu('keys')}
          />
        </section>

        <section className={activeMenu === 'chat' ? 'block' : 'hidden'} aria-hidden={activeMenu !== 'chat'}>
          <ChatGeneratorView
            models={models}
            syncedAt={syncedAt}
            catalogSyncing={catalogSyncing}
            catalogStale={catalogStale}
            catalogError={catalogError}
            onSyncCatalog={handleSyncCatalog}
            keys={keys}
            autoRotateEnabled={autoRotateEnabled}
            onUpdateKeyVerification={handleUpdateKeyVerification}
            conversations={chatConversations}
            onConversationsChange={handleChatsChange}
            onGoToKeys={() => setActiveMenu('keys')}
          />
        </section>

        {activeMenu === 'keys' && (
          <KeyManagerView
            deviceId={deviceId}
            keys={keys}
            autoRotateEnabled={autoRotateEnabled}
            onKeysChange={handleKeysChange}
            onToggleAutoRotate={handleToggleAutoRotate}
            onClearAllLocalData={handleClearAllLocalData}
          />
        )}
      </main>
      <OfflineIndicator />
    </div>
  );
}
