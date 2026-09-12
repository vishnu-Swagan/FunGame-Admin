import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, BadgeIndianRupee, Gift, Sparkles, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export const OFFER_POPUP_SESSION_KEYS = {
  website: "chakri:new-offers:website:v1",
  lobby: "chakri:new-offers:lobby:v1",
};

const offerItems = [
  {
    icon: Gift,
    eyebrow: "Signup bonus",
    value: "1,000",
    title: "Playing Chips",
    copy: "New accounts receive 1,000 non-withdrawable Playing Chips. Each settled bonus chip wagered unlocks up to one remaining Playing Chip as a Real Chip.",
  },
  {
    icon: BadgeIndianRupee,
    eyebrow: "First deposit",
    value: "100%",
    title: "Bonus Chips",
    copy: "Once your Playing Chips are finished: ₹100 gives 100 extra; ₹5,000 gives 5,000 extra. One eligible deposit match per account.",
  },
  {
    icon: Users,
    eyebrow: "Referral rewards",
    value: "10% + 5%",
    title: "Real Chips",
    copy: "Get 10% of your friend’s first deposit (up to 500 Real Chips), plus 5% when their friend makes a first deposit.",
  },
];

function markPopupSeen(surface) {
  try {
    window.sessionStorage.setItem(OFFER_POPUP_SESSION_KEYS[surface], "seen");
  } catch (_error) {
    // Storage can be unavailable in strict privacy modes. Closing still works.
  }
}

function OfferAction({ signedIn, onNavigate, compact = false }) {
  const primaryTarget = signedIn ? "/wallet/deposit" : "/register";
  const secondaryTarget = signedIn ? "/referral-rewards" : "/legal/bonuses";

  return (
    <div className={`grid gap-2.5 ${compact ? "" : "sm:grid-cols-[1.2fr_.8fr]"}`}>
      <button
        type="button"
        data-testid={signedIn ? "offers-deposit-cta" : "offers-signup-cta"}
        onClick={() => onNavigate(primaryTarget)}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground shadow-[0_12px_30px_rgba(255,199,64,.22)] transition-[filter,transform] duration-200 hover:brightness-110 active:scale-[.98]"
      >
        {signedIn ? "Check my deposit offer" : "Sign up and get 1,000"}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid={signedIn ? "offers-referral-cta" : "offers-terms-cta"}
        onClick={() => onNavigate(secondaryTarget)}
        className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/15 bg-white/[.05] px-4 py-3 text-sm font-bold text-white/80 transition-[background-color,color,transform] duration-200 hover:bg-white/[.1] hover:text-white active:scale-[.98]"
      >
        {signedIn ? "Invite and earn" : "See offer terms"}
      </button>
    </div>
  );
}

export function NewPlayerOffersSpotlight({ signedIn = false }) {
  const navigate = useNavigate();

  return (
    <section
      aria-labelledby={`new-player-offers-${signedIn ? "lobby" : "website"}`}
      className="relative isolate overflow-hidden rounded-[26px] border border-primary/30 bg-card px-5 pb-5 pt-6 shadow-2xl"
      data-testid={signedIn ? "lobby-offers-spotlight" : "website-offers-spotlight"}
    >
      <div aria-hidden="true" className="absolute -right-20 -top-24 -z-10 h-64 w-64 rounded-full bg-primary/15 blur-3xl" />
      <div aria-hidden="true" className="absolute -bottom-28 -left-20 -z-10 h-56 w-56 rounded-full bg-emerald-400/10 blur-3xl" />
      <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.24em] text-primary">
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        New player offers
      </div>

      <div className="mt-4 border-b border-white/10 pb-5">
        <p className="font-tech text-[clamp(2.7rem,13vw,4.5rem)] font-black leading-none tracking-[-.07em] text-white tabular-nums">
          1,000
        </p>
        <h2 id={`new-player-offers-${signedIn ? "lobby" : "website"}`} className="mt-1 text-xl font-extrabold tracking-tight text-primary">
          Playing Chips on signup
        </h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-6 text-white/65">
          Each settled bonus chip wagered unlocks up to one remaining Playing Chip as a withdrawable Real Chip.
        </p>
      </div>

      <div className="grid gap-3 py-5 md:grid-cols-2">
        <article className="rounded-2xl bg-primary/[.08] p-4 ring-1 ring-inset ring-primary/20">
          <p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-primary">Once Playing Chips are finished</p>
          <p className="mt-2 text-2xl font-black tracking-tight text-white tabular-nums">100% first deposit bonus</p>
          <p className="mt-2 text-xs leading-5 text-white/60">
            Deposit ₹100–₹5,000 once and get the same amount in bonus Playing Chips. ₹100 gives 100 extra; ₹5,000 gives 5,000 extra.
          </p>
        </article>
        <article className="rounded-2xl bg-white/[.04] p-4 ring-1 ring-inset ring-white/10">
          <p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-emerald-300">Paid as Real Chips</p>
          <p className="mt-2 text-2xl font-black tracking-tight text-white tabular-nums">10% + 5% referrals</p>
          <p className="mt-2 text-xs leading-5 text-white/60">
            Get 10% of your direct referral’s first deposit, capped at 500, and 5% from their referral’s first deposit.
          </p>
        </article>
      </div>

      <OfferAction signedIn={signedIn} onNavigate={navigate} />
      <p className="mt-3 text-center text-[10px] leading-4 text-white/40">
        18+ only. Playing Chips are non-withdrawable until converted. Maximum withdrawal requests: ₹500 per day.
      </p>
    </section>
  );
}

export function NewPlayerOffersPopup({ signedIn = false, surface = "website", enabled = true }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !OFFER_POPUP_SESSION_KEYS[surface]) {
      setOpen(false);
      return;
    }
    try {
      if (window.sessionStorage.getItem(OFFER_POPUP_SESSION_KEYS[surface])) return;
    } catch (_error) {
      // The offer remains usable when session storage is unavailable.
    }
    markPopupSeen(surface);
    setOpen(true);
  }, [enabled, surface]);

  useEffect(() => {
    // Reserve this surface while the lobby waits for its promotion response,
    // so a slower request cannot let the install prompt open underneath it.
    document.documentElement.dataset.chakriOffersSurface = "true";
    return () => {
      delete document.documentElement.dataset.chakriOffersSurface;
    };
  }, []);

  const updateOpen = (nextOpen) => {
    if (!nextOpen) markPopupSeen(surface);
    setOpen(nextOpen);
  };

  const go = (target) => {
    markPopupSeen(surface);
    setOpen(false);
    navigate(target);
  };

  return (
    <Dialog open={open} onOpenChange={updateOpen}>
      <DialogContent
        data-testid={`${surface}-offers-popup`}
        overlayClassName="z-[100]"
        className="z-[100] max-h-[calc(var(--fg-usable-h,100dvh)-2rem)] w-[calc(100%-2rem)] max-w-[470px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-[28px] border-primary/35 bg-background p-0 text-foreground shadow-2xl [@media(max-height:420px)]:block [@media(max-height:420px)]:overflow-y-auto [&>button]:right-2 [&>button]:top-2 [&>button]:z-10 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-full [&>button]:bg-card [&>button]:text-foreground"
      >
        <div className="relative isolate overflow-hidden px-5 pb-4 pt-5 text-center">
          <div aria-hidden="true" className="absolute -top-20 left-1/2 -z-10 h-64 w-64 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
          <span className="inline-flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.25em] text-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> {signedIn ? "Chakri rewards" : "Welcome offers"}
          </span>
          <DialogTitle className="mt-3 text-balance font-tech text-[1.75rem] font-black uppercase leading-[1.02] tracking-[-.04em] text-white">
            {signedIn ? <>Your next <span className="text-primary">bonus</span> starts here</> : <>Start with <span className="text-primary">1,000</span> Playing Chips</>}
          </DialogTitle>
          <DialogDescription className="mx-auto mt-2 max-w-[34ch] text-xs leading-5 text-white/65">
            Signup chips. Deposit bonus. Referral rewards.
          </DialogDescription>
        </div>

        <div className="min-h-0 space-y-2 overflow-y-auto overscroll-contain border-y border-white/10 bg-card/50 px-4 py-3">
          {offerItems.map(({ icon: Icon, eyebrow, value, title, copy }) => (
            <article key={eyebrow} className="grid grid-cols-[38px_1fr] gap-3 rounded-2xl bg-white/[.045] p-3 ring-1 ring-inset ring-white/[.08]">
              <span className="flex h-[38px] w-[38px] items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[9px] font-extrabold uppercase tracking-[.18em] text-white/45">{eyebrow}</p>
                <p className="mt-0.5 text-base font-black tracking-tight text-white tabular-nums">
                  <span className="text-primary">{value}</span> {title}
                </p>
                <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">{copy}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="p-3.5">
          <OfferAction signedIn={signedIn} onNavigate={go} compact />
          <p className="mt-3 text-center text-[9px] leading-4 text-white/40">
            18+ only · Terms apply · Maximum withdrawal requests: ₹500 per day
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
