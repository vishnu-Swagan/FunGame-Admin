import { useState, useEffect } from "react";
import { X, Share, Plus } from "lucide-react";

// iOS (incl. iPadOS which reports as Mac + touch)
const isIos = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iphone = /iphone|ipad|ipod/i.test(ua);
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iphone || iPadOS;
};

const isStandalone = () =>
  window.navigator.standalone === true ||
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

/** iOS "Add to Home Screen" nudge — iOS Safari has no auto install prompt, so we
    explain it. Shows once per device (dismiss persists), only when not installed. */
export default function IosInstallHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (!isIos() || isStandalone()) return;
      if (localStorage.getItem("fg_ios_install_dismissed") === "1") return;
    } catch (e) {
      return;
    }
    const t = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem("fg_ios_install_dismissed", "1"); } catch (e) { /* ignore */ }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[80] px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" data-testid="ios-install-hint">
      <div className="mx-auto max-w-[430px] rounded-2xl border border-primary/30 bg-[#12101a]/95 backdrop-blur-xl shadow-2xl p-3.5 flex items-start gap-3">
        <img src="/icon-192.png" alt="" className="h-11 w-11 rounded-xl shrink-0" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-bold text-white">Install FunGame on your iPhone</p>
          <p className="text-white/70 text-[13px] mt-0.5 leading-snug">
            Tap <Share className="inline h-4 w-4 -mt-0.5 text-primary" /> <span className="font-semibold text-white">Share</span>, then{" "}
            <span className="font-semibold text-white">"Add to Home Screen"</span> <Plus className="inline h-3.5 w-3.5 -mt-0.5" /> — it opens fullscreen, just like an app.
          </p>
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 h-7 w-7 flex items-center justify-center rounded-full text-white/50 hover:text-white/80">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
