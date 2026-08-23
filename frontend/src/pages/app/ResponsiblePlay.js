import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, ShieldCheck, Clock, Ban, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";

/**
 * The player's own controls: limits, and a way to stop.
 *
 * Three things about how this reads rather than how it works.
 *
 * Usage is shown for every period whether or not a limit is set on it. A page
 * that stays blank until you already care is a page for people who already
 * care; seeing "you have lost 4,200 this week" is what prompts somebody to set
 * the limit in the first place.
 *
 * A queued increase is shown as what it is — the old limit still in force, with
 * the new one waiting and a button to call it off. Presenting it as done, with
 * a note that it starts tomorrow, is how a player ends up believing they have
 * more room than they have.
 *
 * Taking a break is not buried under a confirmation that talks the player out
 * of it. It sits on the same screen as the limits, at the same size.
 */
const PERIODS = [
  { key: "DAY", label: "Daily" },
  { key: "WEEK", label: "Weekly" },
  { key: "MONTH", label: "Monthly" },
];

const BREAKS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 182, label: "6 months" },
];

export default function ResponsiblePlay() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/responsible/me");
      setData(data);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const limitFor = (kind, period) =>
    (data?.limits || []).find((l) => l.kind === kind && l.period === period) || null;

  const save = async (kind, period, raw) => {
    const amount = raw === "" || raw === null ? null : parseInt(raw, 10);
    if (amount !== null && (isNaN(amount) || amount < 0)) return toast.error("Enter a number of chips");
    setBusy(true);
    try {
      const { data } = await api.post("/responsible/limits", { kind, period, amount });
      toast[data.outcome === "IMMEDIATE" ? "success" : "info"](data.message);
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const cancelPending = async (kind, period) => {
    try {
      const { data } = await api.delete(`/responsible/limits/${kind}/${period}/pending`);
      toast.success(data.message);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const takeBreak = async (days, label) => {
    if (!window.confirm(
      `Close your account to play for ${label}?\n\n` +
      `You will be signed out. It cannot be ended early — that is what makes it ` +
      `a break. Your chips stay where they are.`)) return;
    try {
      const { data } = await api.post("/responsible/exclusion", { kind: "BREAK", days });
      toast.success(data.message);
      navigate("/account-closed", { replace: true });
    } catch (e) { toast.error(errMsg(e)); }
  };

  const selfExclude = async () => {
    const typed = window.prompt(
      `This closes your account to play permanently. It cannot be undone by you — ` +
      `only the operator can reopen it, and only after speaking to you.\n\n` +
      `Type the phrase below to confirm:\n${data.permanent_phrase}`);
    if (!typed) return;
    try {
      const { data: res } = await api.post("/responsible/exclusion", {
        kind: "SELF_EXCLUSION", days: null, confirm: typed });
      toast.success(res.message);
      navigate("/account-closed", { replace: true });
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (!data) return <div className="min-h-dvh bg-background p-5 text-sm text-white/50">Loading…</div>;

  return (
    <div className="App fg-noise min-h-dvh bg-background pb-24" data-testid="responsible-play">
      <header className="sticky top-0 z-30 bg-[hsl(var(--background)/0.85)] backdrop-blur-xl border-b border-border/60">
        <div className="h-14 px-4 flex items-center gap-3">
          <button onClick={() => navigate(-1)} data-testid="responsible-back"
            className="h-9 w-9 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="font-bold">Responsible play</h1>
        </div>
      </header>

      <div className="px-4 py-5 space-y-5 max-w-[560px] mx-auto">
        <p className="text-xs text-white/55 leading-relaxed flex items-start gap-2">
          <ShieldCheck className="h-4 w-4 mt-px shrink-0 text-primary" />
          Set a limit and it applies straight away. Raising or removing one takes
          {" "}{data.increase_delay_hours} hours, so a change of mind in the moment
          cannot undo a decision you made calmly.
        </p>

        {data.exclusion && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-400/8 p-4" data-testid="responsible-active-exclusion">
            <p className="text-sm font-bold text-amber-200">Your account is closed to play</p>
            <p className="text-xs text-amber-200/75 mt-1">
              {data.exclusion.ends_at
                ? `It reopens after ${String(data.exclusion.ends_at).slice(0, 10)}.`
                : "This closure is permanent. Contact support if you need to discuss it."}
            </p>
          </div>
        )}

        <LimitBlock
          title="Play-result limits"
          hint="Chips played minus chips returned. A round that would take you past the limit is refused."
          kind="LOSS"
          usageKey="lost"
          data={data}
          limitFor={limitFor}
          onSave={save}
          onCancel={cancelPending}
          busy={busy}
        />

        <section className="rounded-2xl border border-white/10 bg-card/55 p-4" data-testid="responsible-break">
          <h2 className="text-sm font-bold text-white/85 flex items-center gap-2">
            <Clock className="h-4 w-4 text-white/45" /> Take a break
          </h2>
          <p className="text-[11px] text-white/45 mt-1">
            Closes your account to play for a fixed period. Your chips stay where
            they are, and it cannot be ended early.
          </p>
          <div className="grid grid-cols-2 gap-2 mt-3">
            {BREAKS.map((b) => (
              <button key={b.days} onClick={() => takeBreak(b.days, b.label)}
                data-testid={`responsible-break-${b.days}`}
                className="rounded-xl border border-white/12 bg-white/5 px-3 py-2.5 text-sm font-semibold min-h-[44px]">
                {b.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-rose-400/25 bg-rose-400/[0.06] p-4" data-testid="responsible-exclude">
          <h2 className="text-sm font-bold text-rose-200 flex items-center gap-2">
            <Ban className="h-4 w-4" /> Self-exclude permanently
          </h2>
          <p className="text-[11px] text-rose-200/65 mt-1">
            Closes your account to play for good. Only the operator can reopen it,
            after speaking to you.
          </p>
          <button onClick={selfExclude} data-testid="responsible-self-exclude"
            className="mt-3 rounded-xl border border-rose-400/35 bg-rose-400/10 px-4 py-2.5 text-sm font-bold text-rose-200 min-h-[44px]">
            Close my account permanently
          </button>
        </section>
      </div>
    </div>
  );
}

const LimitBlock = ({ title, hint, kind, usageKey, data, limitFor, onSave, onCancel, busy }) => (
  <section className="rounded-2xl border border-white/10 bg-card/55 p-4" data-testid={`responsible-${kind.toLowerCase()}`}>
    <h2 className="text-sm font-bold text-white/85">{title}</h2>
    <p className="text-[11px] text-white/45 mt-0.5">{hint}</p>
    <div className="mt-3 space-y-3">
      {PERIODS.map(({ key, label }) => {
        const limit = limitFor(kind, key);
        const used = data.usage?.[key]?.[usageKey] ?? 0;
        return (
          <Row key={key} label={label} used={used} limit={limit} kind={kind} period={key}
               onSave={onSave} onCancel={onCancel} busy={busy} />
        );
      })}
    </div>
  </section>
);

const Row = ({ label, used, limit, kind, period, onSave, onCancel, busy }) => {
  const [value, setValue] = useState(limit?.amount ?? "");
  useEffect(() => { setValue(limit?.amount ?? ""); }, [limit?.amount]);

  const cap = limit?.amount ?? null;
  const shown = Math.max(0, used);
  const ratio = cap ? Math.min(1, shown / cap) : 0;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-white">{label}</span>
        <span className="text-[11px] text-white/50 tabular-nums">
          {formatChips(shown)} used{cap != null ? ` of ${formatChips(cap)}` : ""}
        </span>
      </div>

      {cap != null && (
        <div className="mt-2 h-1.5 rounded-full bg-white/8 overflow-hidden">
          <div className={`h-full rounded-full ${ratio >= 1 ? "bg-rose-400" : ratio > 0.8 ? "bg-amber-400" : "bg-emerald-400"}`}
               style={{ width: `${ratio * 100}%` }} />
        </div>
      )}

      <div className="mt-2.5 flex gap-2">
        <input
          type="number"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="No limit"
          data-testid={`limit-${kind}-${period}`}
          className="flex-1 h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white"
        />
        <button onClick={() => onSave(kind, period, value)} disabled={busy}
          data-testid={`limit-save-${kind}-${period}`}
          className="rounded-xl bg-primary text-primary-foreground font-bold px-4 text-sm min-h-[40px] disabled:opacity-50">
          Set
        </button>
      </div>

      {limit?.pending_effective_from && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/8 px-2.5 py-1.5">
          <span className="text-[11px] text-amber-200/85">
            Change to {limit.pending_amount == null ? "no limit" : formatChips(limit.pending_amount)}
            {" "}starts {String(limit.pending_effective_from).slice(0, 16).replace("T", " ")}
          </span>
          <button onClick={() => onCancel(kind, period)} data-testid={`limit-cancel-${kind}-${period}`}
            className="flex items-center gap-1 text-[11px] font-semibold text-amber-200">
            <X className="h-3 w-3" /> Cancel
          </button>
        </div>
      )}
    </div>
  );
};
