import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, History, Landmark, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageTransition, EmptyState, Disclaimer, formatChips } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/api";
import { clearFinancialIntent, financialIntentKey } from "@/lib/financialIntent";
import { payments } from "@/lib/paymentApi";
import { isFinancialFeatureAvailable, normalizeWallet, rupeesToPaise } from "@/lib/walletUtils";
import { PaymentRow, WalletBalanceCard } from "@/pages/app/wallet/WalletBits";

const QUICK_DEPOSITS = [500, 1000, 2500, 5000];
const TAB_PATH = { deposit: "/chips/deposit", withdraw: "/chips/withdraw", activity: "/chips/activity" };

function tabForPath(pathname) {
  if (pathname.endsWith("/withdraw")) return "withdraw";
  if (pathname.endsWith("/activity") || pathname.endsWith("/history")) return "activity";
  return "deposit";
}

export default function ChipsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const [tab, setTab] = useState(tabForPath(location.pathname));
  const [wallet, setWallet] = useState(() => normalizeWallet(null, user?.chip_balance));
  const [financial, setFinancial] = useState(null);
  const [deposits, setDeposits] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [banks, setBanks] = useState([]);
  const [selectedBankId, setSelectedBankId] = useState("");
  const [loading, setLoading] = useState(true);
  const [depositAmount, setDepositAmount] = useState("1000");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([payments.wallet(), payments.deposits(), payments.withdrawals(), payments.bankDetails()]);
    if (results[0].status === "fulfilled") {
      setWallet(normalizeWallet(results[0].value, user?.chip_balance));
      setFinancial(results[0].value?.financial || null);
    }
    if (results[1].status === "fulfilled") setDeposits(results[1].value);
    if (results[2].status === "fulfilled") setWithdrawals(results[2].value);
    if (results[3].status === "fulfilled") {
      const methods = results[3].value;
      setBanks(methods);
      setSelectedBankId((current) => methods.some((method) => method.id === current) ? current : (methods[0]?.id || ""));
    }
    setLoading(false);
  }, [user?.chip_balance]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const next = tabForPath(location.pathname); setTab(next); }, [location.pathname]);

  const activity = useMemo(() => [
    ...deposits.map((item) => ({ ...item, _kind: "deposit" })),
    ...withdrawals.map((item) => ({ ...item, _kind: "withdrawal" })),
  ].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)), [deposits, withdrawals]);
  const depositsAvailable = isFinancialFeatureAvailable(financial, "deposits");
  const withdrawalsAvailable = isFinancialFeatureAvailable(financial, "withdrawals");
  const selectedBank = banks.find((method) => method.id === selectedBankId) || null;

  const startDeposit = async (event) => {
    event.preventDefault();
    if (!depositsAvailable) return toast.info("Deposits are temporarily unavailable while the payment provider is being prepared.");
    const paise = rupeesToPaise(depositAmount);
    if (!paise) return toast.error("Enter a valid INR amount with no more than two decimal places");
    const idempotencyKey = financialIntentKey("deposit", user?.id, `amount_paise=${paise}`);
    setBusy(true);
    try {
      const response = await payments.createDeposit(paise, idempotencyKey);
      const checkoutUrl = response.checkout_url;
      if (!checkoutUrl) throw new Error("The payment provider did not return a checkout link");
      const target = new URL(checkoutUrl, window.location.origin);
      if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname))) {
        throw new Error("The payment provider returned an unsafe checkout link");
      }
      clearFinancialIntent("deposit", user?.id, idempotencyKey);
      window.location.assign(target.toString());
    } catch (error) {
      toast.error(errMsg(error));
      setBusy(false);
    }
  };

  const requestWithdrawal = async (event) => {
    event.preventDefault();
    if (!withdrawalsAvailable) return toast.info("Withdrawals are temporarily unavailable while the payment provider is being prepared.");
    const amount = Number(withdrawAmount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return toast.error("Enter a whole-number chip amount");
    if (amount > wallet.withdrawable_chips) return toast.error("Amount exceeds your withdrawable chips");
    if (!selectedBank?.id) return navigate("/profile/bank-details", { state: { returnTo: "/chips/withdraw" } });
    const idempotencyKey = financialIntentKey(
      "withdrawal",
      user?.id,
      `amount_chips=${amount}|bank_detail_id=${selectedBank.id}`,
    );
    setBusy(true);
    try {
      await payments.createWithdrawal(amount, selectedBank.id, idempotencyKey);
      clearFinancialIntent("withdrawal", user?.id, idempotencyKey);
      toast.success("Withdrawal request submitted");
      setWithdrawAmount("");
      await Promise.all([load(), refreshUser()]);
      navigate("/chips/activity", { replace: true });
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  const changeTab = (value) => { setTab(value); navigate(TAB_PATH[value], { replace: true }); };

  return (
    <PageTransition className="space-y-5" data-testid="wallet-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Chips wallet</h1>
        <p className="mt-1 text-sm text-white/50">Secure INR deposits, chip balances and withdrawal tracking.</p>
      </div>
      <WalletBalanceCard wallet={wallet} />
      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="grid h-12 w-full grid-cols-3 rounded-xl border border-white/10 bg-white/5">
          <TabsTrigger value="deposit" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><ArrowDownToLine className="mr-1 h-4 w-4" />Deposit</TabsTrigger>
          <TabsTrigger value="withdraw" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><ArrowUpFromLine className="mr-1 h-4 w-4" />Withdraw</TabsTrigger>
          <TabsTrigger value="activity" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><History className="mr-1 h-4 w-4" />Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="deposit" className="mt-4">
          <form onSubmit={startDeposit} className="space-y-4 rounded-2xl border border-white/10 bg-card/55 p-4" data-testid="deposit-form">
            <div><p className="font-semibold">Add chips</p><p className="mt-1 text-xs leading-relaxed text-white/50">You will complete payment on the provider's secure checkout. Chips are credited only after the server verifies the provider webhook.</p></div>
            {!loading && !depositsAvailable && <UnavailableNotice noun="Deposits" />}
            <div className="grid grid-cols-4 gap-2">
              {QUICK_DEPOSITS.map((value) => <button key={value} type="button" disabled={!depositsAvailable} onClick={() => setDepositAmount(String(value))} className={`min-h-11 rounded-xl border text-xs font-bold tabular-nums disabled:cursor-not-allowed disabled:opacity-40 ${depositAmount === String(value) ? "border-primary/55 bg-primary/15 text-primary" : "border-white/10 bg-white/5 text-white/65"}`}>₹{value.toLocaleString("en-IN")}</button>)}
            </div>
            <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/45">₹</span><Input aria-label="Deposit amount in INR" disabled={!depositsAvailable} inputMode="decimal" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} className="h-12 rounded-xl border-white/12 bg-white/5 pl-9 tabular-nums" /></div>
            <Button type="submit" disabled={busy || loading || !depositsAvailable} className="h-12 w-full rounded-xl text-base font-bold">{busy ? "Opening secure checkout…" : depositsAvailable ? "Continue to payment" : "Deposits temporarily unavailable"}</Button>
            <p className="flex items-center gap-1.5 text-[11px] text-white/40"><ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />A browser return page never credits chips. Only a verified server webhook can do that.</p>
          </form>
        </TabsContent>

        <TabsContent value="withdraw" className="mt-4">
          <form onSubmit={requestWithdrawal} className="space-y-4 rounded-2xl border border-white/10 bg-card/55 p-4" data-testid="withdrawal-form">
            <div><p className="font-semibold">Withdraw chips</p><p className="mt-1 text-xs text-white/50">Available to withdraw: <strong className="text-emerald-300 tabular-nums">{formatChips(wallet.withdrawable_chips)}</strong> chips.</p></div>
            {!loading && !withdrawalsAvailable && <UnavailableNotice noun="Withdrawals" />}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-semibold"><Landmark className="h-4 w-4 text-primary" />Payout account</span>
                <button type="button" onClick={() => navigate("/profile/bank-details", { state: { returnTo: "/chips/withdraw" } })} className="inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-primary"><Plus className="h-3.5 w-3.5" />Manage</button>
              </div>
              {banks.length ? (
                <div className="mt-2 space-y-2" role="radiogroup" aria-label="Payout bank account">
                  {banks.map((method) => {
                    const selected = method.id === selectedBankId;
                    return <button key={method.id} type="button" role="radio" aria-checked={selected} disabled={!withdrawalsAvailable} onClick={() => setSelectedBankId(method.id)} className={`flex min-h-12 w-full items-center justify-between rounded-lg border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45 ${selected ? "border-primary/45 bg-primary/10" : "border-white/10 bg-white/[0.03]"}`}>
                      <span className="min-w-0"><span className="block truncate text-xs font-semibold">{method.bank_name || "Saved bank account"}</span><span className="block truncate font-mono text-[10px] text-white/45">{method.account_number_masked || method.masked_account_number || "Account secured"}{method.payout_identifier_masked ? ` · ${method.payout_identifier_masked}` : ""}</span></span>
                      <CheckCircle2 className={`h-4 w-4 shrink-0 ${selected ? "text-primary" : "text-white/20"}`} />
                    </button>;
                  })}
                </div>
              ) : <button type="button" disabled={!withdrawalsAvailable} onClick={() => navigate("/profile/bank-details", { state: { returnTo: "/chips/withdraw" } })} className="mt-2 flex min-h-12 w-full items-center justify-center rounded-lg border border-dashed border-primary/35 bg-primary/5 text-xs font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-45">Add bank details</button>}
            </div>
            <Input aria-label="Withdrawal amount in chips" disabled={!withdrawalsAvailable} type="number" min="1" step="1" max={wallet.withdrawable_chips || undefined} placeholder="Amount in chips" value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} className="h-12 rounded-xl border-white/12 bg-white/5 tabular-nums" />
            <Button type="submit" disabled={busy || loading || !withdrawalsAvailable} className="h-12 w-full rounded-xl text-base font-bold">{busy ? "Submitting…" : !withdrawalsAvailable ? "Withdrawals temporarily unavailable" : selectedBank ? "Request withdrawal" : "Add bank details to continue"}</Button>
            <p className="text-[11px] leading-relaxed text-white/40">Requests may require review and remain pending until approved or submitted to the payment provider. Held chips cannot be used while the request is open.</p>
          </form>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          {loading ? <div className="h-40 rounded-2xl fg-shimmer border border-white/5" /> : activity.length === 0 ? <EmptyState icon={History} title="No wallet activity" subtitle="Your deposits and withdrawals will appear here." /> : <div className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-card/55">{activity.map((item) => <PaymentRow key={`${item._kind}-${item.id}`} item={item} kind={item._kind} />)}</div>}
        </TabsContent>
      </Tabs>
      <Disclaimer />
    </PageTransition>
  );
}

function UnavailableNotice({ noun }) {
  return <div className="flex items-start gap-2.5 rounded-xl border border-amber-300/25 bg-amber-300/8 p-3 text-xs leading-relaxed text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><span><strong>{noun} are temporarily unavailable.</strong> Payment-provider approval and production configuration must be completed before this service opens.</span></div>;
}
