import { useEffect, useState } from "react";
import { toast } from "sonner";
import { errMsg } from "@/lib/api";
import { promoApi } from "@/lib/promoApi";
import "./freeCashArt.css";

function formatInr(paise) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format((Number(paise) || 0) / 100);
}

export function ChestArt({ size = "hero" }) {
  const hero = size === "hero";
  return (
    <div className={`relative flex items-center justify-center ${hero ? "h-36 w-40" : "h-12 w-12"}`} aria-hidden>
      {hero && (
        <img
          src="/promo/free-cash-coins.png"
          alt=""
          className="chakri-coin-glow pointer-events-none absolute left-1/2 top-16 w-36 max-w-none"
        />
      )}
      <img
        src={hero ? "/promo/free-cash-chest.png" : "/promo/free-cash-fab.png"}
        alt=""
        className={`chakri-chest-bob relative z-10 object-contain drop-shadow-[0_12px_28px_rgba(16,185,129,0.55)] ${hero ? "h-32 w-32" : "h-11 w-11"}`}
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
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-3 sm:items-center" data-testid="free-cash-modal">
      <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-emerald-300/25 bg-[#07150f] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.55)]">
        <button type="button" onClick={onClose} className="absolute right-4 top-4 text-white/45">Close</button>
        <div className="flex flex-col items-center">
          <ChestArt />
          <p className="mt-2 text-lg font-black tracking-wide text-amber-200">Free Cash</p>
          <p className="text-3xl font-black tabular-nums text-white">{formatInr(wallet.balance_paise)}</p>
          <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-black/50">
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-amber-300" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-sm font-semibold text-emerald-200">{wallet.copy}</p>
          <button type="button" disabled={!wallet.can_claim || busy} onClick={claim} className="mt-4 w-full rounded-2xl bg-gradient-to-r from-amber-300 to-yellow-500 py-3 text-sm font-black uppercase text-emerald-950 disabled:opacity-40">
            {busy ? "Claiming…" : "Claim"}
          </button>
          <div className="mt-3 grid w-full grid-cols-2 gap-2">
            <button type="button" onClick={share} className="rounded-xl border border-white/15 py-2 text-xs font-bold">Share</button>
            <a href={wallet.whatsapp_url || "#"} target="_blank" rel="noreferrer" className="rounded-xl bg-[#25D366] py-2 text-center text-xs font-bold text-emerald-950">WhatsApp</a>
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
    <button type="button" onClick={onClick} data-testid="free-cash-fab" className="chakri-fab-pulse fixed bottom-24 right-4 z-40 flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-amber-300/40 bg-[#062016]">
      <img src="/promo/free-cash-fab.png" alt="Free Cash" className="h-14 w-14 object-contain" />
      {remainingPaise > 0 && <span className="sr-only">{formatInr(remainingPaise)} to claim</span>}
    </button>
  );
}
