import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Users, Copy, ShieldCheck } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";
import { Card, Pill, Table, shortDate } from "./partnerBits";

/**
 * Who this partner introduced.
 *
 * The list is deliberately thin: Login ID, when they joined, whether the account
 * is live, and what they staked this month. No email, no phone, no date of
 * birth, no chip balance. The operator holds that data and the partner is an
 * introducer, not a joint holder of it — and a portal that leaked it would make
 * every distributor an unmanaged processor of the operator's player records.
 *
 * The figure a partner actually needs from this screen is which introductions
 * generate attributed activity, and month turnover answers that without exposing anybody.
 */
export default function PartnerPlayers() {
  const [rows, setRows] = useState([]);
  const [monthFrom, setMonthFrom] = useState(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, me] = await Promise.all([
        api.get("/distributor/players"),
        api.get("/distributor/me"),
      ]);
      setRows(p.data.players || []);
      setMonthFrom(p.data.month_from);
      setCode(me.data.distributor.code);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(`Code ${code} copied`);
    } catch (e) {
      toast.error("Could not copy — the code is " + code);
    }
  };

  const active = rows.filter((r) => r.status === "ACTIVE").length;

  return (
    <div className="space-y-5" data-testid="partner-players">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" /> My players
        </h1>
        <p className="text-xs text-white/55 mt-1">
          {rows.length} introduced · {active} active
        </p>
      </div>

      <Card testId="partner-code-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] tracking-wider text-white/45">YOUR REFERRAL CODE</p>
            <p className="font-mono text-xl font-bold text-primary">{code || "…"}</p>
            <p className="text-[11px] text-white/45 mt-1">
              A player enters this when they request an account. It cannot be applied
              afterwards, so it has to be given before they sign up.
            </p>
          </div>
          <button onClick={copyCode} data-testid="partner-copy-code"
            className="h-10 rounded-xl border border-white/12 bg-white/5 px-3 text-sm font-semibold flex items-center gap-1.5">
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </div>
      </Card>

      {loading ? <p className="text-sm text-white/50">Loading…</p> : (
        <Card title="Players" subtitle={monthFrom ? `Turnover shown from ${monthFrom}` : null} testId="partner-players-table">
          <Table
            head={["Login ID", "Joined", "Status", "Last seen", "Bets", "Turnover"]}
            right={[4, 5]}
            rows={rows.map((r) => [
              r.login_id,
              shortDate(r.joined),
              <Pill>{r.status}</Pill>,
              shortDate(r.last_login),
              r.month_bets || 0,
              formatChips(r.month_turnover || 0),
            ])}
            empty="Nobody has signed up with your code yet."
          />
        </Card>
      )}

      <p className="text-[11px] text-white/40 flex items-start gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 mt-px shrink-0 text-white/30" />
        Player contact details are held by the operator and are not shown here. If
        you need to reach a player, ask the operator through Support.
      </p>
    </div>
  );
}
