import { useEffect } from "react";
import { ChestArt } from "./FreeCash";
import "./freeCashArt.css";

function formatInr(paise) {
  const value = Number(paise || 0) / 100;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(value);
}

export default function WagerBonusOverlay({ overlay, onClose }) {
  useEffect(() => {
    if (!overlay) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [overlay]);
  if (!overlay) return null;
  const pct = Math.max(0, Math.min(100, Number(overlay.progress_pct) || 0));
  const countdown = overlay.countdown || {};
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#04110c]/92 px-4" data-testid="wager-bonus-overlay" style={{ width: "100vw", height: "100vh" }}>
      <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-emerald-300/30 bg-gradient-to-b from-[#0b2a1c] via-[#082016] to-[#04140e] p-6 text-center shadow-[0_0_80px_rgba(16,185,129,0.35)]">
        <div aria-hidden className="pointer-events-none absolute -top-16 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full bg-emerald-400/20 blur-3xl" />
        <div className="mx-auto mb-1 flex justify-center">
          <ChestArt />
        </div>
        <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-amber-200/80">Cash guarantee</p>
        <p className="mt-3 text-5xl font-black tabular-nums text-amber-300 drop-shadow-[0_0_18px_rgba(251,191,36,0.55)]">{formatInr(overlay.bonus_paise)}</p>
        <p className="mt-2 text-sm text-emerald-100/80">Wager {formatInr(overlay.required_paise)} to unlock it</p>
        <div className="mt-6 h-3 overflow-hidden rounded-full bg-black/40">
          <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-amber-300 shadow-[0_0_18px_rgba(52,211,153,0.8)]" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-3 text-xs font-semibold text-white/70">{countdown.label || overlay.copy}</p>
        <p className="mt-5 text-sm leading-relaxed text-white/75">{overlay.copy}</p>
        <button type="button" onClick={onClose} className="mt-7 w-full rounded-2xl bg-gradient-to-r from-emerald-400 to-lime-300 py-3 text-sm font-black uppercase tracking-wide text-emerald-950">
          Start playing
        </button>
      </div>
    </div>
  );
}
