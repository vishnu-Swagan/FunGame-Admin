import { Check, CircleDollarSign, Clock3, Gamepad2, Info, ShieldCheck, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { formatChips } from "@/components/common";
import { formatInrPaise } from "@/lib/walletUtils";
import { isPromotionPolicyVersion } from "@/lib/promotionApi";
import { formatPromotionDate, rewardLabel } from "./PromotionProgress";

function contributionPercent(bps) {
  const value = Number(bps) || 0;
  return `${value / 100}%`;
}

export default function OfferReview({ offers = [], selectedOfferId, onSelect, accepted, onAcceptedChange, depositPaise }) {
  if (!offers.length) return null;
  const selected = offers.find((offer) => offer.id === selectedOfferId) || null;
  const quoteMatches = Boolean(selected && selected.deposit_amount_paise === Number(depositPaise) && selected.target_chips > 0 && selected.rate_version && selected.quote_token && Number.isFinite(new Date(selected.deadline_at).getTime()) && Number.isFinite(new Date(selected.quote_expires_at).getTime()));
  const termsComplete = Boolean(selected?.terms_version && /^[A-Z]{2}$/.test(selected?.jurisdiction) && Number.isSafeInteger(Number(selected?.claim_finality_hours)) && Number(selected?.claim_finality_hours) >= 1 && Number(selected?.claim_finality_hours) <= 720 && isPromotionPolicyVersion(selected?.settlement_finality_policy_version));
  const eligible = quoteMatches && termsComplete;
  const rules = selected?.contribution_rules || {};

  return (
    <section className="space-y-3 rounded-2xl border border-primary/25 bg-black/15 p-4" data-testid="promotion-offer-review">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/10"><CircleDollarSign className="h-5 w-5 text-primary" /></span>
        <div>
          <p className="font-bold">Optional bonus mission</p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">Choose deliberately. Your deposit remains cash; completing qualifying play unlocks a separate reward.</p>
        </div>
      </div>

      <div className="space-y-2" role="radiogroup" aria-label="Available bonus offers">
        {offers.map((offer) => {
          const isSelected = offer.id === selectedOfferId;
          const canSelect = offer.deposit_amount_paise === Number(depositPaise) && offer.target_chips > 0 && Boolean(offer.rate_version) && Boolean(offer.quote_token) && Number.isFinite(new Date(offer.deadline_at).getTime()) && Number.isFinite(new Date(offer.quote_expires_at).getTime());
          return (
            <button
              key={offer.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={!canSelect}
              onClick={() => { onSelect(isSelected ? "" : offer.id); onAcceptedChange(false); }}
              className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45 ${isSelected ? "border-primary/55 bg-primary/12" : "border-white/10 bg-white/[.035]"}`}
            >
              <span>
                <strong className="block text-sm">{offer.name}</strong>
                <span className="mt-1 block text-xs text-white/50">Reward {rewardLabel(offer.reward)}{offer.target_chips ? ` · Target ${formatChips(offer.target_chips)} settled stake` : ""}</span>
                {!canSelect && <span className="mt-1 block text-[11px] text-amber-200">A current server quote is unavailable for this deposit amount.</span>}
              </span>
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-white/20"}`}>{isSelected && <Check className="h-4 w-4" />}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-background/60 p-3" data-testid="selected-offer-terms">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-white/8 bg-white/[.035] p-2.5"><Clock3 className="h-4 w-4 text-primary" /><span className="mt-1 block text-white/45">Deadline</span><strong className="mt-0.5 block leading-snug">{selected.deadline_at ? formatPromotionDate(selected.deadline_at, selected.timezone) : selected.duration_hours ? `${selected.duration_hours} hours after activation` : "Shown before activation"}</strong></div>
            <div className="rounded-lg border border-white/8 bg-white/[.035] p-2.5"><Gamepad2 className="h-4 w-4 text-primary" /><span className="mt-1 block text-white/45">Default contribution</span><strong className="mt-0.5 block">{contributionPercent(rules.default_bps || 10000)} of qualifying stake</strong></div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg border border-white/8 bg-white/[.035] p-2.5"><span className="block text-white/45">Quoted deposit</span><strong className="mt-1 block tabular-nums">{formatInrPaise(selected.deposit_amount_paise)}</strong><span className="mt-0.5 block text-[10px] text-white/40">Balance credit {formatChips(selected.deposit_chips)}</span></div><div className="rounded-lg border border-white/8 bg-white/[.035] p-2.5"><span className="block text-white/45">Exact target</span><strong className="mt-1 block tabular-nums text-primary">{formatChips(selected.target_chips)} settled stake</strong>{selected.wager_multiplier_bps > 0 && <span className="mt-0.5 block tabular-nums text-[10px] text-white/40">{selected.wager_multiplier_bps / 10000}× quoted balance credit</span>}</div></div>
          <p className="text-[11px] leading-relaxed text-white/45">Quote valid until {formatPromotionDate(selected.quote_expires_at, selected.timezone)}. If it expires, the server will require a refreshed target before payment.</p>
          <dl className="space-y-2 text-xs leading-relaxed">
            <div><dt className="font-bold text-white/80">Qualifying games</dt><dd className="text-white/55">{rules.allowed_games?.length ? rules.allowed_games.join(", ") : "Eligible games listed in the accepted campaign rules."}</dd></div>
            {Object.keys(rules.game_bps || {}).length > 0 && <div><dt className="font-bold text-white/80">Game contribution rates</dt><dd className="text-white/55">{Object.entries(rules.game_bps).map(([game, bps]) => `${game}: ${contributionPercent(bps)}`).join(" · ")}</dd></div>}
            {rules.excluded_games?.length > 0 && <div><dt className="font-bold text-white/80">Excluded games</dt><dd className="text-white/55">{rules.excluded_games.join(", ")}</dd></div>}
            <div><dt className="font-bold text-white/80">Qualifying wallet sources</dt><dd className="text-white/55">{rules.eligible_source_buckets?.length ? rules.eligible_source_buckets.join(", ") : "The accepted campaign source rules apply."}</dd></div>
            <div><dt className="font-bold text-white/80">Maximum qualifying stake</dt><dd className="text-white/55">{rules.max_qualifying_stake_chips ? `${formatChips(rules.max_qualifying_stake_chips)} per settled wager` : "The accepted campaign limit applies."}</dd></div>
            <div><dt className="font-bold text-white/80">Voids and refunds</dt><dd className="text-white/55">Cancelled, void or refunded wagers contribute zero. Only server-confirmed settled stake progresses the mission.</dd></div>
            <div><dt className="font-bold text-white/80">Settlement-finality review</dt><dd className="text-white/55">After the target reaches 100%, settled wagers enter a {selected.claim_finality_hours}-hour server verification window under policy {selected.settlement_finality_policy_version || "not supplied"}. The reward can be claimed only after the mission is server-confirmed as claimable.</dd></div>
            <div><dt className="font-bold text-white/80">Withdrawal</dt><dd className="text-white/55">{selected.withdrawal_consequence}</dd></div>
          </dl>
          {(selected.significant_terms || []).map((term) => <p key={term} className="flex items-start gap-2 text-xs leading-relaxed text-white/55"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />{term}</p>)}
          {!termsComplete && <p role="alert" className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-100">This offer is missing its terms version, jurisdiction, settlement-finality window or immutable finality policy version. It cannot be accepted until the server publishes complete terms.</p>}
          {!quoteMatches && <p role="alert" className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-100">The deposit amount changed or its server quote expired. Wait for the refreshed exact target before accepting.</p>}
          <label className={`flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border p-3 ${accepted ? "border-primary/45 bg-primary/10" : "border-white/12 bg-white/[.025]"}`}>
            <Checkbox checked={accepted} onCheckedChange={(checked) => onAcceptedChange(checked === true)} disabled={!eligible} className="mt-0.5 h-5 w-5" aria-label="Accept the displayed bonus terms" />
            <span className="text-xs leading-relaxed text-white/70">I choose this optional bonus and accept campaign version {selected.campaign_version}, terms {selected.terms_version || "shown above"}, and settlement-finality policy {selected.settlement_finality_policy_version || "not supplied"}, including the deadline and qualifying-game rules.</span>
          </label>
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-emerald-200/80"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />Your deposited cash is not locked by this mission. The reward remains separate until earned.</p>
        </div>
      )}

      <button type="button" onClick={() => { onSelect(""); onAcceptedChange(false); }} className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border text-xs font-bold ${selectedOfferId ? "border-white/12 bg-white/[.025] text-white/65" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"}`}>
        {selectedOfferId ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />} Continue without bonus
      </button>
    </section>
  );
}
