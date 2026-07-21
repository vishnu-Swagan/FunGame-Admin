import { useState, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Coins, ArrowDownToLine, ArrowUpFromLine, History, CircleCheck, CircleX, CircleEllipsis } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { PageTransition, Disclaimer, formatChips, timeAgo, EmptyState } from "@/components/common";

const QUICK_AMOUNTS = [500, 1000, 2500, 5000];

const REQ_STATUS = {
  PENDING: { icon: CircleEllipsis, cls: "text-primary border-primary/35 bg-primary/10" },
  APPROVED: { icon: CircleCheck, cls: "text-[hsl(var(--emerald))] border-[hsl(var(--emerald)/0.35)] bg-[hsl(var(--emerald)/0.1)]" },
  DENIED: { icon: CircleX, cls: "text-red-400 border-destructive/40 bg-destructive/10" },
};

export default function ChipsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const initialTab = location.pathname.endsWith("/request") ? "request" : location.pathname.endsWith("/history") ? "history" : "request";
  const [tab, setTab] = useState(initialTab);
  const [balance, setBalance] = useState(user?.chip_balance ?? 0);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [returnAmt, setReturnAmt] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, r, t] = await Promise.all([
        api.get("/chips/balance"),
        api.get("/chips/requests"),
        api.get("/chips/transactions"),
      ]);
      setBalance(b.data.balance);
      setRequests(r.data.requests || []);
      setTransactions(t.data.transactions || []);
    } catch (e) {
      // silent
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) {
      toast.error("Enter a valid chip amount");
      return;
    }
    setBusy(true);
    try {
      await api.post("/chips/request", { amount: amt, note: note || null });
      toast.success("Request submitted — an operator will review it.");
      setAmount("");
      setNote("");
      await load();
      await refreshUser();
      setTab("history");
      navigate("/chips/history", { replace: true });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const submitReturn = async (e) => {
    e.preventDefault();
    const amt = parseInt(returnAmt, 10);
    if (!amt || amt <= 0) {
      toast.error("Enter a valid amount to return");
      return;
    }
    if (amt > balance) {
      toast.error("You can only return up to your current balance");
      return;
    }
    setReturnBusy(true);
    try {
      await api.post("/chips/return-request", { amount: amt, note: returnNote || null });
      toast.success("Return request submitted — chips are deducted only on approval.");
      setReturnAmt("");
      setReturnNote("");
      await load();
      setTab("history");
      navigate("/chips/history", { replace: true });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setReturnBusy(false);
    }
  };

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Chips wallet</h1>

      {/* Balance card */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/30 bg-card/60 backdrop-blur-md p-5 shadow-[0_0_0_1px_rgba(255,199,64,0.15),0_10px_30px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0 fg-aurora pointer-events-none" />
        <span className="fg-glint absolute top-3 right-5 text-xs text-primary">✦</span>
        <p className="text-xs text-white/55">Current balance</p>
        <div className="mt-1 flex items-center gap-2.5">
          <div className="h-10 w-10 rounded-full bg-primary/15 border border-primary/40 flex items-center justify-center">
            <Coins className="h-5 w-5 text-primary" />
          </div>
          <span data-testid="chips-balance-value" className="tabular-nums text-4xl font-extrabold text-primary">{formatChips(balance)}</span>
        </div>
        <Disclaimer className="mt-3" />
      </div>

      <Tabs value={tab} onValueChange={(v) => { setTab(v); if (v !== "return") navigate(v === "request" ? "/chips/request" : "/chips/history", { replace: true }); }} data-testid="chips-wallet-tabs">
        <TabsList className="w-full grid grid-cols-3 bg-white/5 border border-white/10 rounded-xl h-11">
          <TabsTrigger value="request" data-testid="chips-tab-request" className="rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-semibold text-xs sm:text-sm">
            <ArrowDownToLine className="h-4 w-4 mr-1" /> Request
          </TabsTrigger>
          <TabsTrigger value="return" data-testid="chips-tab-return" className="rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-semibold text-xs sm:text-sm">
            <ArrowUpFromLine className="h-4 w-4 mr-1" /> Return
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="chips-tab-history" className="rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-semibold text-xs sm:text-sm">
            <History className="h-4 w-4 mr-1" /> History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="request" className="mt-4">
          <form data-testid="chips-request-form" onSubmit={submit} className="rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold">Request play chips</p>
              <p className="text-xs text-white/55 mt-0.5">An operator reviews every request.</p>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {QUICK_AMOUNTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  data-testid={`chips-quick-amount-${q}`}
                  onClick={() => setAmount(String(q))}
                  className={`rounded-xl border px-2 py-2.5 min-h-[44px] text-sm font-bold tabular-nums transition-[background-color,border-color] duration-150 ${
                    amount === String(q) ? "bg-primary/15 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/75 hover:bg-white/10"
                  }`}
                >
                  {formatChips(q)}
                </button>
              ))}
            </div>
            <Input
              data-testid="chips-request-amount-input"
              type="number"
              min="1"
              max="1000000"
              placeholder="Custom amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-12 rounded-xl bg-white/5 border-white/12 tabular-nums"
              aria-label="Chip amount"
            />
            <Textarea
              data-testid="chips-request-note-input"
              placeholder="Note for the operator (optional)"
              value={note}
              maxLength={280}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-xl bg-white/5 border-white/12 min-h-[70px]"
              aria-label="Request note"
            />
            <Button data-testid="chips-request-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
              {busy ? "Submitting…" : "Submit request"}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="return" className="mt-4">
          <form data-testid="chips-return-form" onSubmit={submitReturn} className="rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold">Return chips to the operator</p>
              <p className="text-xs text-white/55 mt-0.5">Request to return chips. An operator reviews it, and chips are deducted only when approved.</p>
            </div>
            <Input
              data-testid="chips-return-amount-input"
              type="number"
              min="1"
              max={balance || undefined}
              placeholder={`Amount to return (max ${formatChips(balance)})`}
              value={returnAmt}
              onChange={(e) => setReturnAmt(e.target.value)}
              className="h-12 rounded-xl bg-white/5 border-white/12 tabular-nums"
              aria-label="Return amount"
            />
            <Textarea
              data-testid="chips-return-note-input"
              placeholder="Reason / note for the operator (optional)"
              value={returnNote}
              maxLength={280}
              onChange={(e) => setReturnNote(e.target.value)}
              className="rounded-xl bg-white/5 border-white/12 min-h-[70px]"
              aria-label="Return note"
            />
            <Button data-testid="chips-return-submit-button" type="submit" disabled={returnBusy || !returnAmt} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
              {returnBusy ? "Submitting…" : "Request return"}
            </Button>
            <p className="text-[11px] text-white/40">Your chips stay in your balance until the operator approves the return.</p>
          </form>
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-5">
          {/* Requests */}
          <section>
            <p className="text-sm font-semibold mb-2.5">Chip requests</p>
            {requests.length === 0 ? (
              <EmptyState icon={ArrowDownToLine} title="No requests yet" subtitle="Your chip requests will appear here." />
            ) : (
              <div data-testid="chips-requests-list" className="space-y-2.5">
                {requests.filter((r) => r.type !== "SELL").map((r) => {
                  const S = REQ_STATUS[r.status] || REQ_STATUS.PENDING;
                  const SIcon = S.icon;
                  return (
                    <div key={r.id} data-testid="chips-request-item" className="flex items-center justify-between rounded-xl bg-card/55 border border-white/10 p-3.5">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[9px] font-bold tracking-wider rounded-full border px-1.5 py-0.5 ${r.type === "RETURN" ? "text-[hsl(var(--magenta))] border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.1)]" : "text-[hsl(var(--emerald))] border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)]"}`}>
                            {r.type === "RETURN" ? "RETURN" : "BUY"}
                          </span>
                          <p className="tabular-nums font-bold">{formatChips(r.amount)} chips</p>
                        </div>
                        <p className="text-[11px] text-white/45 mt-0.5">{timeAgo(r.created_at)}{r.admin_note ? ` · ${r.admin_note}` : ""}</p>
                      </div>
                      <Badge variant="outline" className={`rounded-full border text-[10px] font-bold px-2.5 py-1 flex items-center gap-1 ${S.cls}`}>
                        <SIcon className="h-3 w-3" /> {r.status}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Ledger */}
          <section>
            <p className="text-sm font-semibold mb-2.5">Transaction ledger</p>
            {transactions.length === 0 ? (
              <EmptyState icon={History} title="No transactions yet" subtitle="Approved chips and game settlements appear here." />
            ) : (
              <div data-testid="chips-ledger-table" className="rounded-2xl bg-card/55 border border-white/10 divide-y divide-white/5">
                {transactions.map((t) => (
                  <div key={t.id} data-testid="chips-ledger-row" className="flex items-center justify-between p-3.5">
                    <div>
                      <p className="text-sm font-medium">{t.note || t.type}</p>
                      <p className="text-[11px] text-white/45 mt-0.5">{timeAgo(t.created_at)}</p>
                    </div>
                    <div className="text-right">
                      <p className={`tabular-nums font-bold ${t.type === "CREDIT" ? "text-[hsl(var(--emerald))]" : "text-red-400"}`}>
                        {t.type === "CREDIT" ? "+" : "-"}{formatChips(t.amount)}
                      </p>
                      <p className="text-[11px] text-white/45 tabular-nums">bal {formatChips(t.balance_after)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </PageTransition>
  );
}
