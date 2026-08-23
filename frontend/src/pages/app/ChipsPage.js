import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { HandCoins, History } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageTransition, EmptyState, Disclaimer, formatChips } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, errMsg } from "@/lib/api";
import { normalizeWallet } from "@/lib/walletUtils";
import { WalletBalanceCard } from "@/pages/app/wallet/WalletBits";

const QUICK_AMOUNTS = [500, 1000, 2500, 5000];

export default function ChipsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState(location.pathname.endsWith("/activity") ? "activity" : "request");
  const [requests, setRequests] = useState([]);
  const [amount, setAmount] = useState("1000");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const wallet = normalizeWallet(null, user?.chip_balance);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/chips/requests");
      setRequests(data.requests || []);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTab(location.pathname.endsWith("/activity") ? "activity" : "request"); }, [location.pathname]);

  const submit = async (event) => {
    event.preventDefault();
    const requested = Number(amount);
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > 1_000_000) {
      return toast.error("Enter a whole-number chip amount between 1 and 1,000,000");
    }
    setBusy(true);
    try {
      const { data } = await api.post("/chips/request", { amount: requested, note: note.trim() || null });
      toast.success(data?.message || "Chip request submitted for operator review");
      setNote("");
      await load();
      setTab("activity");
      navigate("/chips/activity", { replace: true });
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  const changeTab = (next) => {
    setTab(next);
    navigate(next === "activity" ? "/chips/activity" : "/chips", { replace: true });
  };

  return (
    <PageTransition className="space-y-5" data-testid="wallet-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Play chips</h1>
        <p className="mt-1 text-sm text-white/50">Virtual-chip balance and operator-reviewed chip requests.</p>
      </div>
      <WalletBalanceCard wallet={wallet} />

      <div className="rounded-2xl border border-primary/25 bg-primary/8 p-4 text-xs leading-relaxed text-white/65">
        Virtual chips are for in-app entertainment only. They have no cash value and cannot be purchased, withdrawn, transferred, exchanged, or redeemed.
      </div>

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="grid h-12 w-full grid-cols-2 rounded-xl border border-white/10 bg-white/5">
          <TabsTrigger value="request" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><HandCoins className="mr-1 h-4 w-4" />Request chips</TabsTrigger>
          <TabsTrigger value="activity" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><History className="mr-1 h-4 w-4" />Request activity</TabsTrigger>
        </TabsList>

        <TabsContent value="request" className="mt-4">
          <form onSubmit={submit} className="space-y-4 rounded-2xl border border-primary/25 bg-card/55 p-4" data-testid="manual-chip-request-form">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10"><HandCoins className="h-5 w-5 text-primary" /></div>
              <div><p className="font-semibold">Request play chips</p><p className="mt-1 text-xs leading-relaxed text-white/50">An administrator reviews each request. Your balance changes only after approval.</p></div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {QUICK_AMOUNTS.map((value) => <button key={value} type="button" onClick={() => setAmount(String(value))} className={`min-h-11 rounded-xl border text-xs font-bold tabular-nums ${amount === String(value) ? "border-primary/55 bg-primary/15 text-primary" : "border-white/10 bg-white/5 text-white/65"}`}>{value.toLocaleString("en-IN")}</button>)}
            </div>
            <Input data-testid="manual-chip-request-amount" aria-label="Requested chips" type="number" min="1" max="1000000" step="1" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} className="h-12 rounded-xl border-white/12 bg-white/5 tabular-nums" />
            <Textarea data-testid="manual-chip-request-note" aria-label="Request note" maxLength={280} placeholder="Note to the operator (optional)" value={note} onChange={(event) => setNote(event.target.value)} className="min-h-20 rounded-xl border-white/12 bg-white/5" />
            <Button data-testid="manual-chip-request-submit" type="submit" disabled={busy} className="h-12 w-full rounded-xl text-base font-bold">{busy ? "Submitting…" : "Submit chip request"}</Button>
          </form>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          {loading ? <div className="h-40 rounded-2xl fg-shimmer border border-white/5" /> : requests.length === 0 ? (
            <EmptyState icon={History} title="No chip requests" subtitle="Operator-reviewed requests will appear here." />
          ) : (
            <section aria-label="Chip request activity" className="overflow-hidden rounded-2xl border border-white/10 bg-card/55">
              <div className="divide-y divide-white/5">{requests.map((item) => <ChipRequestRow key={item.id} item={item} />)}</div>
            </section>
          )}
        </TabsContent>
      </Tabs>
      <Disclaimer />
    </PageTransition>
  );
}

function ChipRequestRow({ item }) {
  const status = String(item.status || "PENDING").toUpperCase();
  const statusClass = status === "APPROVED" ? "text-emerald-300 bg-emerald-300/10 border-emerald-300/25" : status === "DENIED" ? "text-red-300 bg-red-300/10 border-red-300/25" : "text-amber-300 bg-amber-300/10 border-amber-300/25";
  return (
    <div data-testid="manual-chip-request-row" className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0"><p className="text-sm font-semibold tabular-nums">{formatChips(item.amount)} chips</p><p className="truncate text-[11px] text-white/45">{item.admin_note || item.note || "Operator review"}</p></div>
      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusClass}`}>{status}</span>
    </div>
  );
}
