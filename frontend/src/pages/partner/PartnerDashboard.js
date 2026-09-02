import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Handshake, Percent, Users, ArrowRight, Clock } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";
import { Card, Metric, Money, Pill, pct } from "./partnerBits";

/**
 * What a partner sees first.
 *
 * The screen answers three questions in the order they are actually asked: how
 * is today going, what have I earned, and when do I get it. The third one is
 * where portals normally go quiet — a balance with no explanation of why it has
 * not been paid generates a support message every week — so the holdback and
 * the minimum are stated on the screen rather than left to be discovered.
 */
export default function PartnerDashboard() {
  const [me, setMe] = useState(null);
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.get("/distributor/me"), api.get("/distributor/summary")]);
      setMe(a.data);
      setS(b.data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-white/50">Loading…</p>;
  if (!me || !s) return <p className="text-sm text-white/50">Could not load your account.</p>;

  const d = me.distributor;

  return (
    <div className="space-y-5" data-testid="partner-dashboard">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <Handshake className="h-5 w-5 text-primary" /> {d.name}
        </h1>
        <p className="text-xs text-white/55 mt-1 flex flex-wrap items-center gap-2">
          <span>Referral code <span className="font-mono text-primary">{d.code}</span></span>
          <Pill>{d.status}</Pill>
          <span className="inline-flex items-center gap-1 text-white/45">
            <Percent className="h-3 w-3" /> {pct(me.rate_bps)}% commission
          </span>
        </p>
      </div>

      {/* What is owed comes before what was earned: it is the number a partner
          opens the portal to check. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="ACCRUED" value={formatChips(s.accrued)} hint="Settled commission units" tone={s.accrued < 0 ? "loss" : "win"} />
        <Metric label="IN REVIEW" value={formatChips(s.in_flight)} hint="Awaiting operator review" />
        <Metric label="RECORDED TO DATE" value={formatChips(s.paid_to_date)} />
        <Metric label="THIS MONTH" value={formatChips(s.month_commission_settled)} hint="Settled commission units" />
      </div>

      <Card
        title="Today"
        subtitle={`${s.today.day} · ${me.settlement_timezone}`}
        testId="partner-today"
        action={<span className="text-[10px] text-amber-300 flex items-center gap-1"><Clock className="h-3 w-3" /> Provisional</span>}
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="SETTLED STAKES" value={formatChips(s.today.turnover)} provisional />
          <Metric label="GROSS RESULT" value={<Money value={s.today.ggr} />} provisional />
          <Metric label="NET RESULT" value={<Money value={s.today.ngr} />} tone={s.today.ngr < 0 ? "loss" : "win"} provisional />
          <Metric label="PLAYERS" value={s.today.players} hint={`${s.today.bets} rounds`} provisional />
        </div>
        <p className="text-[10px] text-white/35 mt-2">
          Today is still running and is rebuilt overnight. Commission is calculated
          on the settled day, so these figures can still move.
        </p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Yesterday" subtitle={s.yesterday.day} testId="partner-yesterday">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="SETTLED STAKES" value={formatChips(s.yesterday.turnover)} />
            <Metric label="NET RESULT" value={<Money value={s.yesterday.ngr} />} tone={s.yesterday.ngr < 0 ? "loss" : "win"} />
          </div>
        </Card>
        <Card title="Month to date" subtitle={`${s.month.from} → ${s.month.to}`} testId="partner-month">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="SETTLED STAKES" value={formatChips(s.month.turnover)} />
            <Metric label="NET RESULT" value={<Money value={s.month.ngr} />} tone={s.month.ngr < 0 ? "loss" : "win"} />
          </div>
        </Card>
      </div>

      <Card testId="partner-players-teaser">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Users className="h-4 w-4 text-white/45" />
            <div>
              <p className="text-sm font-bold text-white">{s.total_players} player{s.total_players === 1 ? "" : "s"}</p>
              <p className="text-[11px] text-white/45">{s.month.players} played this month</p>
            </div>
          </div>
          <Link to="/distributor/my-players" className="text-xs font-semibold text-primary flex items-center gap-1">
            View <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </Card>

      <p className="text-[11px] text-white/40 leading-relaxed">
        Commission records settle nightly from attributed player activity. Cash deposits,
        bonus balances, player withdrawals, and partner commission remain separate in the
        platform ledger. Period detail appears under{" "}
        <Link to="/distributor/my-commission" className="text-primary">My commission</Link>.
      </p>
    </div>
  );
}
