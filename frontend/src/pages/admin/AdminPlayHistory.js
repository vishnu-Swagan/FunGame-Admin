import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { History, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTransition, EmptyState, formatChips } from "@/components/common";
import { adminPayments } from "@/lib/paymentApi";
import { errMsg } from "@/lib/api";
import { formatPaymentTime } from "@/lib/walletUtils";
import {
  classifyChipTransaction,
  matchesHistoryScope,
  playOutcomeLabel,
  playSummary,
  walletKindLabel,
} from "@/lib/historyUtils";

const PLAY_KINDS_SET = new Set(["STAKE", "PAYOUT", "REFUND"]);

const SCOPES = [
  { id: "play", label: "Play" },
  { id: "wallet", label: "Buy & withdraw" },
  { id: "all", label: "All" },
];

function playerLabel(item) {
  return item.user_name || item.user_email || item.user_phone || item.user_id || "—";
}

function amountClass(kind) {
  if (kind === "PAYOUT" || kind === "DEPOSIT" || kind === "BONUS" || kind === "REFUND") return "text-emerald-300";
  if (kind === "STAKE" || kind === "WITHDRAWAL") return "text-red-300";
  return "text-white/70";
}

function signedChips(kind, amount) {
  const n = Number(amount) || 0;
  const credit = kind === "PAYOUT" || kind === "DEPOSIT" || kind === "BONUS" || kind === "REFUND";
  return `${credit ? "+" : "−"}${formatChips(n)}`;
}


export default function AdminPlayHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const userFilter = searchParams.get("user") || "";
  const [userInput, setUserInput] = useState(userFilter);
  const [scope, setScope] = useState(searchParams.get("scope") || "play");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (userFilter) params.user_id = userFilter;
      setRows(await adminPayments.chipTransactions(params));
    } catch (error) {
      toast.error(errMsg(error, "Could not load chip history."));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [userFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setUserInput(userFilter); }, [userFilter]);

  const visible = useMemo(
    () => (rows || []).filter((row) => matchesHistoryScope(row, scope)),
    [rows, scope],
  );
  const summary = useMemo(() => playSummary(visible), [visible]);

  const applyUser = (event) => {
    event.preventDefault();
    const next = userInput.trim();
    const params = {};
    if (next) params.user = next;
    if (scope && scope !== "play") params.scope = scope;
    setSearchParams(params);
  };

  return (
    <PageTransition className="space-y-4" data-testid="admin-play-history">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/30 bg-primary/10">
            <History className="h-5 w-5 text-primary" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Player history</h1>
            <p className="mt-1 text-sm text-white/50">
              Virtual-chip play results (won, lost, returned) plus buy and withdraw movements. No cash value.
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" onClick={load} disabled={loading} data-testid="admin-play-history-refresh">
          Refresh
        </Button>
      </div>

      <form onSubmit={applyUser} className="flex flex-wrap items-center gap-2" data-testid="admin-play-history-filter">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
          <Input
            value={userInput}
            onChange={(event) => setUserInput(event.target.value)}
            placeholder="Filter by player id"
            aria-label="Filter by player id"
            className="h-11 rounded-xl border-white/12 bg-white/5 pl-9"
            data-testid="admin-play-history-user"
          />
        </div>
        <Button type="submit" className="h-11 rounded-xl">Show</Button>
        {userFilter ? (
          <Button type="button" variant="outline" className="h-11 rounded-xl" onClick={() => { setUserInput(""); setSearchParams({}); }}>
            All players
          </Button>
        ) : null}
      </form>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="History scope">
        {SCOPES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={scope === item.id}
            data-testid={`admin-history-scope-${item.id}`}
            onClick={() => setScope(item.id)}
            className={`h-10 rounded-xl border px-3 text-xs font-semibold ${scope === item.id ? "border-primary/55 bg-primary/15 text-primary" : "border-white/10 bg-white/5 text-white/65"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {scope !== "wallet" && visible.length > 0 && (
        <div className="grid grid-cols-3 gap-2" data-testid="admin-play-summary">
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/8 p-3">
            <p className="text-[10px] uppercase tracking-wider text-white/45">Won</p>
            <p className="tabular-nums text-lg font-bold text-emerald-300">{formatChips(summary.won)}</p>
          </div>
          <div className="rounded-xl border border-red-400/20 bg-red-400/8 p-3">
            <p className="text-[10px] uppercase tracking-wider text-white/45">Lost</p>
            <p className="tabular-nums text-lg font-bold text-red-300">{formatChips(summary.lost)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-[10px] uppercase tracking-wider text-white/45">Net</p>
            <p className={`tabular-nums text-lg font-bold ${summary.net >= 0 ? "text-emerald-300" : "text-red-300"}`}>
              {summary.net >= 0 ? "+" : ""}{formatChips(summary.net)}
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-40 rounded-2xl fg-shimmer border border-white/5" />
      ) : visible.length === 0 ? (
        <EmptyState icon={History} title="No history yet" subtitle="Play results and chip purchases appear here after the first movement." />
      ) : (
        <section className="overflow-hidden rounded-2xl border border-white/10 bg-card/55" aria-label="Chip history">
          <div className="divide-y divide-white/5">
            {visible.map((item) => {
              const kind = classifyChipTransaction(item);
              const label = PLAY_KINDS_SET.has(kind) ? playOutcomeLabel(kind) : walletKindLabel(kind);
              return (
                <article key={item.id} className="grid gap-2 p-4 sm:grid-cols-[1.2fr_.8fr_.7fr_1fr] sm:items-center" data-testid="admin-history-row">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{playerLabel(item)}</p>
                    <p className="font-mono text-[10px] text-white/35">{item.user_id}</p>
                  </div>
                  <div>
                    <p className={`tabular-nums font-bold ${amountClass(kind)}`}>{signedChips(kind, item.amount)}</p>
                    <p className="text-[10px] text-white/35">balance {formatChips(item.balance_after)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-white/80">{label}</p>
                    <p className="truncate text-[11px] text-white/45">{item.game || item.note || "—"}</p>
                  </div>
                  <p className="text-[11px] text-white/40">{formatPaymentTime(item.created_at)}</p>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </PageTransition>
  );
}

