import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { errMsg } from "@/lib/api";
import { promoApi } from "@/lib/promoApi";
import chestImg from "@/assets/promo/free-cash-chest.webp";
import coinsImg from "@/assets/promo/free-cash-coins.webp";
import fabImg from "@/assets/promo/free-cash-fab.webp";
import "./freeCashArt.css";

function formatInr(paise) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format((Number(paise) || 0) / 100);
}

export function ChestArt({ size = "hero" }) {
  const hero = size === "hero";
  if (!hero) {
    return (
      <img src={fabImg} alt="" className="chakri-chest-bob h-11 w-11 object-contain" />
    );
  }
  return (
    <div className="relative flex h-44 w-52 items-center justify-center" aria-hidden>
      <div className="pointer-events-none absolute left-1/2 top-8 h-28 w-28 -translate-x-1/2 rounded-full bg-amber-400/20 blur-3xl" />
      <img
        src={coinsImg}
        alt=""
        className="chakri-coin-glow pointer-events-none absolute left-1/2 top-16 w-44 max-w-none"
      />
      <img
        src={chestImg}
        alt=""
        className="chakri-chest-bob relative z-10 h-40 w-40 object-contain drop-shadow-[0_12px_28px_rgba(16,185,129,0.55)]"
      />
    </div>
  );
}

export default function FreeCash({ open, onClose, initial }) {
  const [state, setState] = useState(initial || null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    promoApi.state().then((data) => { if (!cancelled) setState(data?.free_cash || data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  if (!open) return null;
  const wallet = state || initial || {};
  const pct = Math.max(0, Math.min(100, Number(wallet.progress_pct) || 0));
  const share = async () => {
    const url = wallet.share_url || window.location.origin;
    try {
      if (navigator.share) await navigator.share({ title: "Chakri Free Cash", url });
      else {
        await navigator.clipboard.writeText(url);
        toast.success("Invite link copied");
      }
    } catch (_error) { /* player cancelled share */ }
  };
  const claim = async () => {
    setBusy(true);
    try {
      const next = await promoApi.claimFreeCash();
      setState(next);
      toast.success("Free Cash claimed");
    } catch (error) {
      toast.error(errMsg(error, "Free Cash is not ready to claim yet."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4" data-testid="free-cash-modal">
      <div className="chakri-free-cash-sheet relative flex w-full max-w-md flex-col overflow-hidden rounded-t-[32px] border border-amber-200/20 bg-gradient-to-b from-[#0c2418] via-[#07150f] to-[#04110c] px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] pt-6 shadow-[0_20px_80px_rgba(0,0,0,0.55)] sm:rounded-[32px] sm:px-6 sm:pb-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white hover:bg-black/65"
        >
          <X className="h-4 w-4" strokeWidth={2.6} />
        </button>
        <div className="flex flex-col items-center text-center">
          <ChestArt />
          <p className="font-display mt-1 text-[1.65rem] leading-none text-amber-200">Free Cash</p>
          <p className="mt-3 text-4xl font-black tabular-nums tracking-tight text-white">{formatInr(wallet.balance_paise)}</p>
          <div className="mt-4 h-3.5 w-full overflow-hidden rounded-full bg-emerald-950/90 ring-1 ring-amber-200/25">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-200 shadow-[0_0_12px_rgba(251,191,36,0.65)]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-sm font-semibold leading-snug text-emerald-100/90">{wallet.copy}</p>
          <button
            type="button"
            disabled={!wallet.can_claim || busy}
            onClick={claim}
            className="mt-5 w-full rounded-2xl bg-gradient-to-r from-[#f8e38a] via-[#f5c518] to-[#e0a106] py-3.5 text-sm font-black uppercase tracking-[0.22em] text-[#1a1204] shadow-[0_10px_28px_rgba(245,197,24,0.45)] disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? "Claiming…" : "Claim"}
          </button>
          <div className="mt-3 grid w-full grid-cols-2 gap-2">
            <button type="button" onClick={share} className="rounded-xl border border-white/20 bg-black/30 py-2.5 text-xs font-bold text-white">Share</button>
            <a href={wallet.whatsapp_url || "#"} target="_blank" rel="noreferrer" className="rounded-xl bg-[#25D366] py-2.5 text-center text-xs font-bold text-emerald-950">WhatsApp</a>
          </div>
        </div>
        <ol className="mt-5 space-y-2 text-left text-[11px] leading-relaxed text-white/55">
          {(wallet.rules || []).map((rule) => <li key={rule}>• {rule}</li>)}
        </ol>
      </div>
    </div>
  );
}

export function FreeCashFab({ onClick, remainingPaise }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="free-cash-fab"
      aria-label="Free Cash"
      className="chakri-fab-pulse chakri-free-cash-fab flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-amber-300/50 bg-[#062016]"
    >
      <img src={fabImg} alt="" className="h-14 w-14 object-contain" />
      {remainingPaise > 0 && <span className="sr-only">{formatInr(remainingPaise)} to claim</span>}
    </button>
  );
}
