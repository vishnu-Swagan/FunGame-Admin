import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CircleCheck, CircleX, Clock3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageTransition } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { payments } from "@/lib/paymentApi";
import { TERMINAL_DEPOSIT_STATUSES } from "@/lib/walletUtils";
import { PaymentStatus } from "@/pages/app/wallet/WalletBits";

export default function DepositReturn() {
  const { depositId: pathId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const depositId = pathId || search.get("deposit_id") || search.get("order_id");
  const [deposit, setDeposit] = useState(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);

  const check = useCallback(async () => {
    if (!depositId) { setError("No deposit reference was supplied. Check wallet activity for the latest status."); setChecking(false); return; }
    setChecking(true);
    try {
      const result = await payments.deposit(depositId);
      setDeposit(result);
      setError("");
      if (String(result.status).toUpperCase() === "CREDITED") await refreshUser();
    } catch (requestError) {
      setError("We could not verify this deposit yet. Your wallet remains unchanged until the provider webhook is confirmed.");
    } finally {
      setChecking(false);
    }
  }, [depositId, refreshUser]);

  useEffect(() => { check(); }, [check]);
  useEffect(() => {
    if (!deposit || TERMINAL_DEPOSIT_STATUSES.has(String(deposit.status).toUpperCase())) return undefined;
    const timer = window.setInterval(check, 3000);
    return () => window.clearInterval(timer);
  }, [deposit, check]);

  const status = String(deposit?.status || "PENDING").toUpperCase();
  const Icon = status === "CREDITED" ? CircleCheck : ["FAILED", "EXPIRED", "REFUNDED", "RECONCILIATION_REQUIRED"].includes(status) ? CircleX : Clock3;
  return (
    <PageTransition className="space-y-5 py-8 text-center" data-testid="deposit-return-page">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/30 bg-primary/10"><Icon className={`h-8 w-8 ${status === "CREDITED" ? "text-emerald-300" : ["FAILED", "EXPIRED", "RECONCILIATION_REQUIRED"].includes(status) ? "text-red-300" : "text-primary"}`} /></div>
      <div><h1 className="text-2xl font-bold">{status === "CREDITED" ? "Chips credited" : ["CREATED", "PENDING"].includes(status) ? "Payment being verified" : status === "RECONCILIATION_REQUIRED" ? "Payment needs review" : "Deposit update"}</h1><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">{error || (status === "CREDITED" ? "The provider payment was verified by our server and your wallet is updated." : status === "RECONCILIATION_REQUIRED" ? "The provider details did not reconcile with the deposit order. No chips were credited; support can review the reference safely." : "Returning from checkout does not credit chips. We are waiting for the verified provider webhook.")}</p></div>
      {deposit && <div className="mx-auto flex max-w-sm items-center justify-between rounded-xl border border-white/10 bg-card/55 p-4 text-left"><div><p className="text-xs text-white/45">Deposit reference</p><p className="mt-1 max-w-[210px] truncate font-mono text-xs">{deposit.id}</p></div><PaymentStatus status={deposit.status} /></div>}
      <div className="grid grid-cols-2 gap-3"><Button type="button" variant="outline" onClick={check} disabled={checking} className="h-12 rounded-xl border-white/15"><RefreshCw className={`mr-2 h-4 w-4 ${checking ? "animate-spin" : ""}`} />Check status</Button><Button type="button" onClick={() => navigate("/chips/activity", { replace: true })} className="h-12 rounded-xl font-bold">Wallet activity</Button></div>
    </PageTransition>
  );
}
