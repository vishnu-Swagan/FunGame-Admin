import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Download, Laptop, Smartphone, X, Share, Plus } from "lucide-react";

const STORAGE_KEY = "fg_app_install_prompt_dismissed";
const DISMISS_FOR_MS = 7 * 24 * 60 * 60 * 1000;
export const APP_INSTALL_REQUEST_EVENT = "chakri:request-app-install";

const isIos = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iPhone = /iphone|ipod/i.test(ua);
  const iPad = /ipad/i.test(ua);
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iPhone || iPad || iPadOS;
};

export const isAppStandalone = () => {
  if (typeof window === "undefined") return false;
  return (
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.matchMedia && window.matchMedia("(display-mode: fullscreen)").matches)
  );
};

const isDesktopLike = () => {
  if (typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  return !/iphone|ipod|ipad|android|mobile/i.test(ua) && (typeof window === "undefined" || window.innerWidth >= 768);
};

const isSafari = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /safari/i.test(ua) && !/chrome|crios|android|edg|opr|fxios/i.test(ua);
};

const isGameRoute = (pathname) =>
  /\/games\/[^/]+\/play\/?$/i.test(pathname) || pathname.startsWith("/__preview/");

const shouldAutoOffer = (pathname) => ["/", "/welcome", "/home", "/games"].includes(pathname);

const wasRecentlyDismissed = () => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    // Migrate the previous permanent-dismiss value so existing users get the
    // improved prompt again instead of losing the install option forever.
    if (!value || value === "1") return false;
    return Number(value) > Date.now();
  } catch (error) {
    return false;
  }
};

const rememberDismissal = () => {
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now() + DISMISS_FOR_MS));
  } catch (error) {
    // Storage can be unavailable in private browsing. The prompt still works.
  }
};

/** Cross-device app install sheet shown when app is not yet installed.
    - iOS: manual "Add to Home Screen" steps (no auto prompt on Safari)
    - Chrome/Edge/desktop browsers: beforeinstallprompt + manual fallback
*/
export default function IosInstallHint() {
  const location = useLocation();
  const firstActionRef = useRef(null);
  const previousFocusRef = useRef(null);
  const [show, setShow] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installed, setInstalled] = useState(isAppStandalone);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredPrompt(event);
      if (!wasRecentlyDismissed() && shouldAutoOffer(window.location.pathname)) {
        setShow(true);
      }
    };

    const onAppInstalled = () => {
      setInstalled(true);
      setShow(false);
      setDeferredPrompt(null);
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        // ignore
      }
    };

    const onInstallRequested = () => {
      if (!isAppStandalone()) setShow(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    window.addEventListener(APP_INSTALL_REQUEST_EVENT, onInstallRequested);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      window.removeEventListener(APP_INSTALL_REQUEST_EVENT, onInstallRequested);
    };
  }, []);

  useEffect(() => {
    if (installed || isAppStandalone() || isGameRoute(location.pathname)) {
      setShow(false);
      return undefined;
    }

    if (wasRecentlyDismissed() || !shouldAutoOffer(location.pathname)) return undefined;

    // A Chromium prompt can be captured on login or a live-game route. Offer it
    // when the player next reaches Home/Games instead of losing the one event.
    const delay = deferredPrompt ? 250 : 1600;
    // Browsers without native install prompting still receive accurate manual
    // guidance (Safari steps, or a clear Chrome/Edge compatibility message).
    const timer = window.setTimeout(() => setShow(true), delay);
    return () => window.clearTimeout(timer);
  }, [deferredPrompt, installed, location.pathname]);

  useEffect(() => {
    if (!show) return undefined;
    previousFocusRef.current = document.activeElement;
    const frame = window.requestAnimationFrame(() => firstActionRef.current?.focus());
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setShow(false);
        rememberDismissal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [show]);

  const onInstall = async () => {
    if (!deferredPrompt) return;
    const prompt = deferredPrompt;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setDeferredPrompt(null);
      setShow(false);
      if (choice?.outcome !== "accepted") rememberDismissal();
    } catch (error) {
      setDeferredPrompt(null);
      setShow(true);
    }
  };

  const dismiss = () => {
    setShow(false);
    rememberDismissal();
  };

  const platformCopy = useMemo(() => {
    if (isIos()) return "iPhone or iPad";
    if (isDesktopLike()) return "Desktop / Laptop";
    return "Mobile / Tablet";
  }, []);

  const manualCopy = useMemo(() => {
    if (isIos()) {
      return (
        <>
          On {platformCopy}, tap <Share className="inline h-4 w-4 -mt-0.5 text-primary" /> <span className="font-semibold text-white">Share</span>, choose{" "}
          <span className="font-semibold text-white">Add to Home Screen</span> <Plus className="inline h-3.5 w-3.5 -mt-0.5" />, then enable{" "}
          <span className="font-semibold text-white">Open as Web App</span> when shown.
        </>
      );
    }
    if (isSafari()) {
      return <>In Safari, choose <span className="font-semibold text-white">File → Add to Dock</span>, then open Chakri.Casino from the Dock.</>;
    }
    return <>For one-click installation, open Chakri.Casino in Chrome or Edge and choose <span className="font-semibold text-white">Install App</span>.</>;
  }, [platformCopy]);

  const isInstallSupported = deferredPrompt !== null;

  if (!show) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[80] px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      data-testid="app-install-hint"
      role="dialog"
      aria-labelledby="app-install-title"
      aria-describedby="app-install-description app-install-instructions"
    >
      <div className="mx-auto max-w-[540px] rounded-2xl border border-primary/30 bg-[#12101a]/95 backdrop-blur-xl shadow-2xl p-3.5 flex items-start gap-3">
        <img src="/chakri-app-icon-192.png" alt="" className="h-11 w-11 rounded-xl shrink-0" />
        <div className="min-w-0 flex-1 text-sm">
          <p id="app-install-title" className="font-bold text-white">Use Chakri.Casino like an app</p>
          <p id="app-install-description" className="text-white/70 text-[13px] mt-0.5 leading-snug">
            Install it on your {platformCopy} and launch without the browser address bar.
          </p>

          <p id="app-install-instructions" className="text-white/70 text-[13px] mt-2 leading-snug">
            {isInstallSupported ? (
              <>Tap <span className="font-semibold text-white">Install App</span> to add it to your {platformCopy}.</>
            ) : manualCopy}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isInstallSupported ? (
              <button
                type="button"
                onClick={onInstall}
                data-testid="install-app-button"
                ref={firstActionRef}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-[hsl(var(--primary-foreground))]"
              >
                <Download className="h-4 w-4" />
                Install App
              </button>
            ) : (
              <div className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-primary/25 bg-primary/10 px-3.5 py-2 text-sm font-semibold text-primary">
                {isDesktopLike() ? <Laptop className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
                {isDesktopLike() ? "Desktop / Laptop" : "Mobile / Tablet"}
              </div>
            )}
            <button
              type="button"
              onClick={dismiss}
              ref={isInstallSupported ? undefined : firstActionRef}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-white/85"
            >
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 h-11 w-11 -mr-2 -mt-2 flex items-center justify-center rounded-full text-white/50 hover:text-white/80"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
