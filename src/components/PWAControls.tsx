import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWA';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs font-semibold text-[#40205E] transition-colors hover:border-[#C5A45A] hover:bg-[#FAF6EC] whitespace-nowrap shrink-0"
        title="Install Kie Studio as an app"
      >
        <Download className="h-3.5 w-3.5 text-[#C5A45A]" />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#40205E]/25 bg-white px-3 py-2 text-xs font-semibold text-[#40205E] transition-colors hover:border-[#C5A45A] hover:bg-[#FAF6EC] whitespace-nowrap shrink-0"
        >
          <Download className="h-3.5 w-3.5 text-[#C5A45A]" />
          <span>Install</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#170D2B]/55 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-xl border border-[#C5A45A]/50 bg-white p-5 shadow-xl">
              <h3 className="font-display text-sm font-bold text-[#170D2B]">Install Kie Studio</h3>
              <p className="mt-2 text-xs leading-relaxed text-[#40205E]">
                1. Tap the <strong>Share</strong> icon in Safari.<br />
                2. Scroll down and select <strong>Add to Home Screen</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 min-h-[42px] w-full rounded-lg bg-[#40205E] py-2 text-xs font-semibold text-[#F4E8C9] transition-colors hover:bg-[#170D2B]"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-[#C5A45A] bg-[#F4E8C9] px-3.5 py-2 text-xs font-semibold text-[#170D2B] shadow-md">
      <span className="h-2 w-2 rounded-full bg-[#40205E]" />
      Offline — Reconnect to generate with Kie.ai
    </div>
  );
};
