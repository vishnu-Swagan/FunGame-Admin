import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CircleCheck, CircleX, Clock3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTransition } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/api";
import { payments } from "@/lib/paymentApi";
import { TERMINAL_DEPOSIT_STATUSES } from "@/lib/walletUtils";
import { PaymentStatus } from "@/pages/app/wallet/WalletBits";
import { MissionReceipt } from "@/components/promotions";
import { promotions } from "@/lib/promotionApi";

export default function DepositReturn() {
  const { depositId: pathId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const depositId = pathId || search.get("deposit_id") || search.get("order_id");
  const [deposit, setDeposit] = useState(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [utr, setUtr] = useState("");
  const [utrBusy, setUtrBusy] = useState(false);
  const [utrError, setUtrError] = useState("");
  const [utrNotice, setUtrNotice] = useState("");
  const [overlay, setOverlay] = useState(null);
  const requestInFlight = useRef(false);

  const check = useCallback(async () => {
    if (!depositId) { setError("No deposit reference was supplied. Check wallet activity for the latest status."); setChecking(false); return; }
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setChecking(true);
    try {
      const result = await payments.deposit(depositId);
      let nextDeposit = result;
      if (String(result.status).toUpperCase() === "CREDITED" && !result.mission && result.mission_id) {
        try {
          const missionResult = await promotions.mission(result.mission_id);
          nextDeposit = { ...result, mission: missionResult.mission };
        } catch (_missionError) {
          // The credited cash receipt remains valid even if the optional mission
          // detail endpoint is briefly unavailable. A later retry can load it.
        }
      }
      setDeposit(nextDeposit);
      setError("");
      if (String(result?.status).toUpperCase() === "CREDITED") {
        try { await refreshUser(); } catch (_error) { /* Status remains authoritative if profile refresh fails. */ }
        try {
          const promo = result?.overlay ? { overlay: result.overlay } : await promoApi.state();
          const next = result?.overlay || promo?.wager?.overlay;
          if (next) setOverlay(next);
        } catch (_error) { /* Overlay is optional after credit. */ }
      }
    } catch (requestError) {
      setError("We could not refresh this payment yet. Your wallet changes only after the server verifies it with the payment provider; we will keep checking.");
    } finally {
      requestInFlight.current = false;
      setChecking(false);
    }
  }, [depositId, refreshUser]);

  const submitUtr = async (event) => {
    event.preventDefault();
    const normalizedUtr = utr.trim();
    if (!/^[A-Z0-9_-]{4,80}$/i.test(normalizedUtr)) {
      setUtrError("Enter the UTR shown in your UPI app (4–80 letters, numbers, hyphens, or underscores).");
      return;
    }
    setUtrBusy(true);
    setUtrError("");
    setUtrNotice("");
    try {
      const result = await payments.submitDepositUtr(depositId, normalizedUtr);
      setDeposit(result);
      setError("");
      setUtr("");
      if (String(result?.status).toUpperCase() === "CREDITED") {
        setUtrNotice("SgPay verified this UTR and the chips are credited.");
        try { await refreshUser(); } catch (_error) { /* Deposit status remains authoritative. */ }
      } else {
        setUtrNotice("UTR submitted. Our server is matching it with SgPay; this page will keep checking.");
      }
    } catch (requestError) {
      setUtrError(errMsg(requestError, "We could not verify that UTR. Check it in your UPI app and try again."));
    } finally {
      setUtrBusy(false);
    }
  };

  useEffect(() => { check(); }, [check]);
  useEffect(() => {
    if (!depositId || TERMINAL_DEPOSIT_STATUSES.has(String(deposit?.status || "").toUpperCase())) return undefined;
    const timer = window.setInterval(check, DEPOSIT_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [depositId, deposit?.status, check]);

  const status = String(deposit?.status || "PENDING").toUpperCase();
  const isHostedUpi = String(deposit?.source || "").toUpperCase() === "SGPAY24_UPI";
  const copy = (isHostedUpi ? UPI_STATUS_COPY : PAYMENT_STATUS_COPY)[status] || {
    title: isHostedUpi ? "UPI deposit update" : "Deposit update",
    detail: "Check Wallet activity for the latest server-verified payment status.",
  };
  const Icon = status === "CREDITED" ? CircleCheck : ["FAILED", "EXPIRED", "REFUNDED", "RECONCILIATION_REQUIRED"].includes(status) ? CircleX : Clock3;
  if (status === "CREDITED" && deposit?.mission) {
    return (
      <MissionReceipt
        mission={deposit.mission}
        deposit={deposit}
        onClose={() => navigate("/wallet/activity", { replace: true })}
        onStart={() => navigate("/games", { replace: true })}
        onHelp={() => navigate("/support")}
      />
    );
  }
  return (
    <PageTransition className="space-y-5 py-8 text-center" data-testid="deposit-return-page">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/30 bg-primary/10"><Icon className={`h-8 w-8 ${status === "CREDITED" ? "text-emerald-300" : ["FAILED", "EXPIRED", "RECONCILIATION_REQUIRED"].includes(status) ? "text-red-300" : "text-primary"}`} /></div>
      <div><h1 className="text-2xl font-bold">{status === "CREDITED" ? "Funds credited" : ["CREATED", "PENDING"].includes(status) ? "Payment being verified" : status === "RECONCILIATION_REQUIRED" ? "Payment needs review" : "Deposit update"}</h1><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">{error || (status === "CREDITED" ? "The provider payment was verified by our server and your wallet is updated." : status === "RECONCILIATION_REQUIRED" ? "The provider details did not reconcile with the deposit order. No funds were credited; support can review the reference safely." : "Returning from checkout does not credit funds. We are waiting for the verified provider webhook.")}</p></div>
      {deposit && <div className="mx-auto flex max-w-sm items-center justify-between rounded-xl border border-white/10 bg-card/55 p-4 text-left"><div><p className="text-xs text-white/45">Deposit reference</p><p className="mt-1 max-w-[210px] truncate font-mono text-xs">{deposit.id}</p></div><PaymentStatus status={deposit.status} /></div>}
      <div className="grid grid-cols-2 gap-3"><Button type="button" variant="outline" onClick={check} disabled={checking} className="h-12 rounded-xl border-white/15"><RefreshCw className={`mr-2 h-4 w-4 ${checking ? "animate-spin" : ""}`} />Check status</Button><Button type="button" onClick={() => navigate("/wallet/activity", { replace: true })} className="h-12 rounded-xl font-bold">Wallet activity</Button></div>
    </PageTransition>
  );
}
