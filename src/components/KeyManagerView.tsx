import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import {
  MAX_LOCAL_KEYS,
  addLocalKeyEntry,
  removeLocalKeyEntry,
  replaceLocalKeyEntry,
  setActiveLocalKey,
  updateLocalKeyVerification,
} from '../storage/localVault';
import type { KeyStatus, LocalApiKey } from '../types';

interface KeyManagerViewProps {
  deviceId: string;
  keys: LocalApiKey[];
  autoRotateEnabled: boolean;
  onKeysChange: (keys: LocalApiKey[]) => void;
  onToggleAutoRotate: (enabled: boolean) => void;
  onClearAllLocalData: () => void;
}

function renderKeyStatus(status: KeyStatus) {
  switch (status) {
    case 'Valid':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>Valid</span>
        </span>
      );
    case 'Insufficient Balance':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Insufficient Balance</span>
        </span>
      );
    case 'Invalid':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Invalid</span>
        </span>
      );
    case 'Restricted':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <span>Restricted</span>
        </span>
      );
    case 'Rate Limited':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Rate Limited</span>
        </span>
      );
    case 'Balance Unavailable':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#40205E]/75">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Balance Unavailable</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#7650A6]">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Unknown</span>
        </span>
      );
  }
}

export function KeyManagerView({
  deviceId,
  keys,
  autoRotateEnabled,
  onKeysChange,
  onToggleAutoRotate,
  onClearAllLocalData,
}: KeyManagerViewProps) {
  const [label, setLabel] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [replacingKeyId, setReplacingKeyId] = useState<string | null>(null);
  const [replaceLabel, setReplaceLabel] = useState('');
  const [replaceSecret, setReplaceSecret] = useState('');
  const [confirmClearData, setConfirmClearData] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'info'; message: string } | null>(
    null
  );

  const totalBalance = keys.reduce(
    (sum, k) => (typeof k.balance === 'number' ? sum + k.balance : sum),
    0
  );
  const validCount = keys.filter((k) => k.status === 'Valid').length;

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const verify = await api.verifyKey(trimmed);
      const next = addLocalKeyEntry(keys, label, trimmed, {
        status: verify.status,
        balance: verify.balance,
        error: verify.error,
        checkedAt: verify.checkedAt,
      });
      setLabel('');
      setApiKeyInput('');
      onKeysChange(next);
      setFeedback({
        type: verify.ok ? 'info' : 'error',
        message: verify.ok
          ? `Key saved locally and verified (${verify.balance} credits).`
          : `Key saved with status "${verify.status}": ${verify.error || 'Verification failed.'}`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to add API key.',
      });
    } finally {
      setAdding(false);
    }
  }

  async function handleVerifyOne(key: LocalApiKey) {
    setFeedback(null);
    setBusyKeyId(key.id);
    try {
      const res = await api.verifyKey(key.apiKey);
      const next = updateLocalKeyVerification(keys, key.id, {
        status: res.status,
        balance: res.balance,
        lastError: res.error ?? null,
        checkedAt: res.checkedAt,
      });
      onKeysChange(next);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Balance check failed.',
      });
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleVerifyAll() {
    if (keys.length === 0) return;
    setFeedback(null);
    setVerifyingAll(true);
    try {
      let current = [...keys];
      for (const k of keys) {
        const res = await api.verifyKey(k.apiKey).catch((err) => ({
          ok: false,
          status: 'Balance Unavailable' as KeyStatus,
          balance: null,
          error: err instanceof Error ? err.message : 'Network error',
          checkedAt: Date.now(),
        }));
        current = updateLocalKeyVerification(current, k.id, {
          status: res.status,
          balance: res.balance,
          lastError: res.error ?? null,
          checkedAt: res.checkedAt,
        });
      }
      onKeysChange(current);
      setFeedback({
        type: 'info',
        message: `Refreshed live balances for ${keys.length} local key${keys.length === 1 ? '' : 's'}.`,
      });
    } finally {
      setVerifyingAll(false);
    }
  }

  function handleSetActive(id: string) {
    setFeedback(null);
    const next = setActiveLocalKey(keys, id);
    onKeysChange(next);
  }

  function handleRemove(id: string) {
    setFeedback(null);
    const next = removeLocalKeyEntry(keys, id);
    onKeysChange(next);
  }

  async function handleReplaceSubmit(e: React.FormEvent, id: string) {
    e.preventDefault();
    setFeedback(null);
    const trimmed = replaceSecret.trim();
    if (!trimmed) return;
    setBusyKeyId(id);
    try {
      const verify = await api.verifyKey(trimmed);
      const next = replaceLocalKeyEntry(keys, id, replaceLabel, trimmed, {
        status: verify.status,
        balance: verify.balance,
        error: verify.error,
        checkedAt: verify.checkedAt,
      });
      setReplaceSecret('');
      setReplaceLabel('');
      setReplacingKeyId(null);
      onKeysChange(next);
      setFeedback({
        type: verify.ok ? 'info' : 'error',
        message: verify.ok
          ? `Replacement key verified (${verify.balance} credits).`
          : `Replacement key saved with status "${verify.status}": ${verify.error || ''}`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to replace API key.',
      });
    } finally {
      setBusyKeyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#C5A45A]/30 pb-5">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold tracking-tight text-[#170D2B] sm:text-2xl">
            API Key Manager
          </h1>
          <p className="mt-1.5 text-xs text-[#40205E]/85 sm:text-sm">
            Manage up to 10 Kie.ai API keys on this browser installation. No login or account required.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
          <button
            type="button"
            onClick={handleVerifyAll}
            disabled={verifyingAll || keys.length === 0}
            className="inline-flex min-h-[42px] flex-1 items-center justify-center gap-2 rounded-lg border border-[#40205E]/25 bg-white px-4 py-2 text-xs font-semibold text-[#40205E] transition-colors hover:border-[#C5A45A] hover:bg-[#FAF6EC] disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap sm:flex-initial"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-[#C5A45A] ${verifyingAll ? 'animate-spin' : ''}`} />
            <span>Refresh All Balances</span>
          </button>

          {!confirmClearData ? (
            <button
              type="button"
              onClick={() => setConfirmClearData(true)}
              className="inline-flex min-h-[42px] flex-1 items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 whitespace-nowrap sm:flex-initial"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Clear Local Data</span>
            </button>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 sm:w-auto">
              <span className="text-xs font-medium text-red-800">
                Wipe all local keys &amp; histories?
              </span>
              <button
                type="button"
                onClick={() => {
                  onClearAllLocalData();
                  setConfirmClearData(false);
                  setFeedback({
                    type: 'info',
                    message: 'All local keys, preferences, and histories cleared from this device.',
                  });
                }}
                className="min-h-[36px] rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800 whitespace-nowrap"
              >
                Confirm Wipe
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearData(false)}
                className="min-h-[36px] rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-[#170D2B] hover:bg-slate-50 whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Summary Metrics Strip */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-[#C5A45A]/30 bg-white p-4 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.08)] sm:p-5">
          <div className="text-xs font-medium text-[#40205E]/75">Local Key Slots</div>
          <div className="mt-1.5 font-mono text-xl font-bold text-[#170D2B] tabular-nums sm:mt-2 sm:text-2xl">
            {keys.length} / {MAX_LOCAL_KEYS}
          </div>
          <div className="mt-1 text-[11px] text-[#40205E]/70">Stored locally on this device</div>
        </div>
        <div className="rounded-xl border border-[#C5A45A]/30 bg-white p-4 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.08)] sm:p-5">
          <div className="text-xs font-medium text-[#40205E]/75">Valid Keys</div>
          <div className="mt-1.5 font-mono text-xl font-bold text-[#40205E] tabular-nums sm:mt-2 sm:text-2xl">
            {validCount}
          </div>
          <div className="mt-1 text-[11px] text-[#40205E]/70">Verified balance &gt; 0 credits</div>
        </div>
        <div className="rounded-xl border border-[#C5A45A]/30 bg-white p-4 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.08)] sm:p-5">
          <div className="text-xs font-medium text-[#40205E]/75">Combined Balance</div>
          <div className="mt-1.5 font-mono text-xl font-bold text-[#170D2B] tabular-nums sm:mt-2 sm:text-2xl">
            {totalBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} cr
          </div>
          <div className="mt-1 text-[11px] text-[#40205E]/70">Across saved keys</div>
        </div>
        <div className="rounded-xl border border-[#C5A45A]/30 bg-[#FAF6EC]/65 p-4 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.08)] sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[#40205E]/80">Automatic Rotation</span>
            <input
              id="toggle-auto-rotate"
              type="checkbox"
              checked={autoRotateEnabled}
              onChange={(e) => onToggleAutoRotate(e.target.checked)}
              className="h-4 w-4 rounded border-[#40205E]/30 accent-[#40205E]"
            />
          </div>
          <label
            htmlFor="toggle-auto-rotate"
            className="mt-1.5 block cursor-pointer font-mono text-base font-bold text-[#170D2B] sm:mt-2"
          >
            {autoRotateEnabled ? 'Enabled' : 'Disabled'}
          </label>
          <div className="mt-1 text-[11px] text-[#40205E]/70">
            Rotates only on insufficient credits
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs sm:text-sm ${
            feedback.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-[#C5A45A]/45 bg-[#FAF6EC] text-[#170D2B]'
          }`}
        >
          {feedback.type === 'error' ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#40205E]" />
          )}
          <span className="min-w-0 break-words">{feedback.message}</span>
        </div>
      )}

      {/* Add Key Form */}
      <form
        onSubmit={handleAddKey}
        className="rounded-xl border border-[#C5A45A]/35 bg-white p-4 shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)] sm:p-6"
      >
        <div className="flex items-center gap-2 font-display text-sm font-bold text-[#170D2B]">
          <KeyRound className="h-4 w-4 text-[#C5A45A]" />
          <span>Add Kie.ai API Key</span>
        </div>
        <p className="mt-1 text-xs text-[#40205E]/80">
          Keys are checked live against <span className="font-mono text-[#170D2B]">GET /api/v1/chat/credit</span> through our stateless proxy before saving locally.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-4">
            <label htmlFor="key-label" className="block text-xs font-semibold text-[#170D2B]">
              Key Label
            </label>
            <input
              id="key-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`API KEY ${String(keys.length + 1).padStart(2, '0')} — Main`}
              maxLength={48}
              className="mt-1.5 min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-sm text-[#170D2B] placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
            />
          </div>
          <div className="md:col-span-6">
            <label htmlFor="key-secret" className="block text-xs font-semibold text-[#170D2B]">
              Kie.ai Bearer API Key
            </label>
            <input
              id="key-secret"
              type="password"
              required
              autoComplete="off"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Paste your Kie.ai API key"
              className="mt-1.5 min-h-[42px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 font-mono text-sm text-[#170D2B] placeholder:font-sans placeholder:text-[#7650A6]/60 focus:border-[#7650A6] focus:outline-none"
            />
          </div>
          <div className="flex items-end md:col-span-2">
            <button
              type="submit"
              disabled={adding || keys.length >= MAX_LOCAL_KEYS || !apiKeyInput.trim()}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-[#C5A45A] bg-[#C5A45A] px-4 py-2 text-sm font-semibold text-[#170D2B] shadow-xs transition-colors hover:bg-[#b5944c] disabled:cursor-not-allowed disabled:border-[#40205E]/15 disabled:bg-[#F4E8C9]/50 disabled:text-[#40205E]/45 whitespace-nowrap"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span>Add Key</span>
            </button>
          </div>
        </div>
      </form>

      {/* Keys Vault Container */}
      <div className="overflow-hidden rounded-xl border border-[#C5A45A]/35 bg-white shadow-[0_4px_20px_-8px_rgba(23,13,43,0.08)]">
        {keys.length === 0 ? (
          <div className="p-8 text-center sm:p-10">
            <p className="text-sm font-semibold text-[#170D2B]">No API keys configured on this device</p>
            <p className="mt-1 text-xs text-[#40205E]/80">
              Add your Kie.ai API key above to verify your live balance and unlock Image, Video, and Chat generation.
            </p>
          </div>
        ) : (
          <>
            {/* Android / Mobile Cards */}
            <div className="divide-y divide-[#C5A45A]/20 md:hidden">
              {keys.map((k) => (
                <div key={k.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 font-semibold text-[#170D2B]">
                        <span className="truncate">{k.label}</span>
                        {k.isActive && (
                          <span className="font-mono text-[11px] font-bold text-[#7650A6]">
                            · Active
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-[#40205E]/80 break-all">
                        {k.maskedKey}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm font-bold text-[#170D2B] tabular-nums">
                        {k.balance !== null
                          ? `${k.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} cr`
                          : '—'}
                      </div>
                      <div className="mt-0.5">{renderKeyStatus(k.status)}</div>
                    </div>
                  </div>

                  {k.lastError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {k.lastError}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#40205E]/70 tabular-nums">
                    <span>
                      Checked: {k.lastCheckedAt ? new Date(k.lastCheckedAt).toLocaleString() : 'Never'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {!k.isActive && (
                      <button
                        type="button"
                        onClick={() => handleSetActive(k.id)}
                        disabled={busyKeyId === k.id}
                        className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-[#C5A45A] bg-[#F4E8C9]/55 px-3 py-2 text-xs font-semibold text-[#170D2B] hover:bg-[#F4E8C9]"
                      >
                        <Star className="h-3.5 w-3.5 text-[#40205E]" />
                        <span>Set Active</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleVerifyOne(k)}
                      disabled={busyKeyId === k.id}
                      className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-[#40205E]/20 bg-white px-3 py-2 text-xs font-semibold text-[#40205E] hover:bg-[#FAF6EC]"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${busyKeyId === k.id ? 'animate-spin' : ''}`}
                      />
                      <span>Validate</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (replacingKeyId === k.id) {
                          setReplacingKeyId(null);
                          setReplaceSecret('');
                        } else {
                          setReplacingKeyId(k.id);
                          setReplaceLabel(k.label);
                          setReplaceSecret('');
                        }
                      }}
                      className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-[#40205E]/20 bg-white px-3 py-2 text-xs font-semibold text-[#40205E] hover:bg-[#FAF6EC]"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(k.id)}
                      disabled={busyKeyId === k.id}
                      aria-label={`Remove ${k.label}`}
                      className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Remove</span>
                    </button>
                  </div>

                  {replacingKeyId === k.id && (
                    <form
                      onSubmit={(e) => handleReplaceSubmit(e, k.id)}
                      className="space-y-3 rounded-lg border border-[#C5A45A]/35 bg-[#FAF6EC] p-3"
                    >
                      <div>
                        <label className="block text-xs font-semibold text-[#170D2B]">
                          Updated Label
                        </label>
                        <input
                          type="text"
                          value={replaceLabel}
                          onChange={(e) => setReplaceLabel(e.target.value)}
                          className="mt-1 min-h-[40px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-1.5 text-sm text-[#170D2B]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[#170D2B]">
                          Replacement Kie.ai API Key
                        </label>
                        <input
                          type="password"
                          required
                          autoComplete="off"
                          value={replaceSecret}
                          onChange={(e) => setReplaceSecret(e.target.value)}
                          placeholder="Paste replacement API key"
                          className="mt-1 min-h-[40px] w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-1.5 font-mono text-sm text-[#170D2B]"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={busyKeyId === k.id || !replaceSecret.trim()}
                          className="min-h-[40px] flex-1 rounded-lg bg-[#40205E] px-3 py-2 text-xs font-semibold text-[#F4E8C9] hover:bg-[#170D2B]"
                        >
                          Save Replacement
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReplacingKeyId(null);
                            setReplaceSecret('');
                          }}
                          className="min-h-[40px] rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs font-semibold text-[#40205E]"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              ))}
            </div>

            {/* Desktop Table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[#C5A45A]/30 bg-[#FAF6EC] text-xs font-semibold text-[#40205E]">
                    <th className="px-4 py-3">Label</th>
                    <th className="px-4 py-3">Masked Identifier</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Verified Balance</th>
                    <th className="px-4 py-3">Last Checked</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#C5A45A]/20">
                  {keys.map((k) => (
                    <React.Fragment key={k.id}>
                      <tr className="transition-colors hover:bg-[#FAF6EC]/50">
                        <td className="px-4 py-3.5 align-top">
                          <div className="font-semibold text-[#170D2B]">
                            {k.label}
                            {k.isActive && (
                              <span className="ml-2 text-xs font-bold text-[#7650A6]">
                                · Active
                              </span>
                            )}
                          </div>
                          {k.lastError && (
                            <div className="mt-1 max-w-xs text-xs text-red-700">{k.lastError}</div>
                          )}
                        </td>
                        <td className="px-4 py-3.5 align-top font-mono text-xs text-[#40205E]">
                          {k.maskedKey}
                        </td>
                        <td className="px-4 py-3.5 align-top whitespace-nowrap">
                          {renderKeyStatus(k.status)}
                        </td>
                        <td className="px-4 py-3.5 align-top text-right font-mono text-sm font-semibold text-[#170D2B] tabular-nums">
                          {k.balance !== null
                            ? `${k.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} cr`
                            : '—'}
                        </td>
                        <td className="px-4 py-3.5 align-top text-xs text-[#40205E]/75 tabular-nums">
                          {k.lastCheckedAt ? new Date(k.lastCheckedAt).toLocaleString() : 'Never'}
                        </td>
                        <td className="px-4 py-3.5 align-top text-right">
                          <div className="inline-flex items-center justify-end gap-2">
                            {!k.isActive && (
                              <button
                                type="button"
                                onClick={() => handleSetActive(k.id)}
                                disabled={busyKeyId === k.id}
                                className="inline-flex items-center gap-1 rounded-md border border-[#C5A45A]/55 bg-[#F4E8C9]/45 px-2.5 py-1.5 text-xs font-semibold text-[#170D2B] hover:bg-[#F4E8C9] whitespace-nowrap"
                              >
                                <Star className="h-3 w-3 text-[#40205E]" />
                                <span>Set Active</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleVerifyOne(k)}
                              disabled={busyKeyId === k.id}
                              className="inline-flex items-center gap-1 rounded-md border border-[#40205E]/20 bg-white px-2.5 py-1.5 text-xs font-medium text-[#40205E] hover:bg-[#FAF6EC] whitespace-nowrap"
                            >
                              <RefreshCw
                                className={`h-3 w-3 ${busyKeyId === k.id ? 'animate-spin' : ''}`}
                              />
                              <span>Validate</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (replacingKeyId === k.id) {
                                  setReplacingKeyId(null);
                                  setReplaceSecret('');
                                } else {
                                  setReplacingKeyId(k.id);
                                  setReplaceLabel(k.label);
                                  setReplaceSecret('');
                                }
                              }}
                              className="rounded-md border border-[#40205E]/20 bg-white px-2.5 py-1.5 text-xs font-medium text-[#40205E] hover:bg-[#FAF6EC] whitespace-nowrap"
                            >
                              Replace
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemove(k.id)}
                              disabled={busyKeyId === k.id}
                              aria-label={`Remove ${k.label}`}
                              className="rounded-md border border-red-200 p-1.5 text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {replacingKeyId === k.id && (
                        <tr className="bg-[#FAF6EC]">
                          <td colSpan={6} className="px-4 py-4">
                            <form
                              onSubmit={(e) => handleReplaceSubmit(e, k.id)}
                              className="flex flex-wrap items-end gap-3"
                            >
                              <div className="min-w-[180px] flex-1">
                                <label className="block text-xs font-semibold text-[#170D2B]">
                                  Updated Label
                                </label>
                                <input
                                  type="text"
                                  value={replaceLabel}
                                  onChange={(e) => setReplaceLabel(e.target.value)}
                                  className="mt-1 w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-1.5 text-sm text-[#170D2B]"
                                />
                              </div>
                              <div className="min-w-[260px] flex-[2]">
                                <label className="block text-xs font-semibold text-[#170D2B]">
                                  Replacement Kie.ai API Key
                                </label>
                                <input
                                  type="password"
                                  required
                                  autoComplete="off"
                                  value={replaceSecret}
                                  onChange={(e) => setReplaceSecret(e.target.value)}
                                  placeholder="Paste replacement API key"
                                  className="mt-1 w-full rounded-lg border border-[#40205E]/25 bg-white px-3 py-1.5 font-mono text-sm text-[#170D2B]"
                                />
                              </div>
                              <button
                                type="submit"
                                disabled={busyKeyId === k.id || !replaceSecret.trim()}
                                className="rounded-lg bg-[#40205E] px-4 py-2 text-xs font-semibold text-[#F4E8C9] hover:bg-[#170D2B] whitespace-nowrap"
                              >
                                Save Replacement
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setReplacingKeyId(null);
                                  setReplaceSecret('');
                                }}
                                className="rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs font-medium text-[#40205E] hover:bg-slate-50 whitespace-nowrap"
                              >
                                Cancel
                              </button>
                            </form>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Local Storage Security Notice & Rotation Policy */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-[#C5A45A]/30 bg-white p-5 text-xs leading-relaxed text-[#40205E]/85 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.06)]">
          <div className="flex items-center gap-2 font-display font-bold text-[#170D2B]">
            <ShieldCheck className="h-4 w-4 text-[#C5A45A]" />
            <span>Local Device Storage &amp; Security Notice</span>
          </div>
          <p className="mt-2">
            Because login and user accounts are removed, your API keys, preferences, and generation histories are stored locally in this browser&apos;s <span className="font-mono text-[#170D2B]">localStorage</span> under installation profile <span className="font-mono text-[#170D2B]">{deviceId.slice(0, 8)}…</span>.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Keys never sync across devices or different browsers and are never persisted or logged on the server.</li>
            <li>Requests pass through our stateless server proxy over HTTPS/local origin using <span className="font-mono text-[#170D2B]">X-Kie-Api-Key</span>.</li>
            <li>Browser <span className="font-mono text-[#170D2B]">localStorage</span> is readable by JavaScript or extensions running on the same origin. Use <strong>Clear Local Data</strong> on shared machines.</li>
          </ul>
        </div>

        <div className="rounded-xl border border-[#C5A45A]/30 bg-[#FAF6EC]/55 p-5 text-xs leading-relaxed text-[#40205E]/85 shadow-[0_4px_18px_-8px_rgba(23,13,43,0.06)]">
          <div className="font-display font-bold text-[#170D2B]">Automatic Key Rotation Policy</div>
          <p className="mt-2">
            When Automatic Rotation is enabled and your active or selected key has insufficient credits for a verified generation cost (or returns 402 Insufficient Balance), the app verifies remaining local keys in priority order against <span className="font-mono text-[#170D2B]">GET /api/v1/chat/credit</span> and submits using the first key with enough verified credits.
          </p>
          <p className="mt-2">
            Rotation <strong>never</strong> triggers on invalid parameters, unavailable models, invalid/restricted keys, or API server errors.
          </p>
        </div>
      </div>
    </div>
  );
}
