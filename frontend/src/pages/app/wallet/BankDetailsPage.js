import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Landmark, LockKeyhole, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageTransition } from "@/components/common";
import { payments } from "@/lib/paymentApi";
import { errMsg } from "@/lib/api";
import { isFinancialFeatureAvailable } from "@/lib/walletUtils";

export default function BankDetailsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = location.state?.returnTo || "/wallet/withdraw";
  const [methods, setMethods] = useState([]);
  const [available, setAvailable] = useState(null);
  const [form, setForm] = useState({ account_holder_name: "", bank_name: "", account_number: "", confirm_account_number: "", ifsc_code: "", payout_identifier: "" });
  const [busy, setBusy] = useState(false);
  const [removeBusy, setRemoveBusy] = useState("");

  useEffect(() => {
    Promise.allSettled([payments.wallet(), payments.bankDetails()]).then(([walletResult, bankResult]) => {
      if (walletResult.status === "fulfilled") {
        const financial = walletResult.value?.financial;
        setAvailable(isFinancialFeatureAvailable(financial, "withdrawals"));
      } else {
        setAvailable(false);
      }
      if (bankResult.status === "fulfilled") setMethods(bankResult.value);
    });
  }, []);
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!available) return toast.info("Bank details are unavailable until withdrawals are enabled.");
    if (form.account_number !== form.confirm_account_number) return toast.error("Account numbers do not match");
    if (!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(form.ifsc_code.trim())) return toast.error("Enter a valid 11-character IFSC code");
    setBusy(true);
    try {
      const detail = await payments.saveBankDetail({
        account_holder_name: form.account_holder_name.trim(),
        bank_name: form.bank_name.trim(),
        account_number: form.account_number.trim(),
        ifsc_code: form.ifsc_code.trim().toUpperCase(),
        payout_identifier: form.payout_identifier.trim() || null,
      });
      setMethods((current) => [detail, ...current.filter((method) => method.id !== detail.id)]);
      setForm({ account_holder_name: "", bank_name: "", account_number: "", confirm_account_number: "", ifsc_code: "", payout_identifier: "" });
      toast.success("Bank account saved securely");
      navigate(returnTo, { replace: true });
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (method) => {
    if (!method?.id || !window.confirm("Remove this bank account from your profile? Existing withdrawal records keep only their masked snapshot.")) return;
    setRemoveBusy(method.id);
    try {
      await payments.removeBankDetail(method.id);
      setMethods((current) => current.filter((item) => item.id !== method.id));
      toast.success("Bank account removed");
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setRemoveBusy("");
    }
  };

  return (
    <PageTransition className="space-y-5">
      <button type="button" onClick={() => navigate(-1)} aria-label="Go back" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/5"><ArrowLeft className="h-4 w-4" /></button>
      <div><h1 className="text-2xl font-bold tracking-tight">Bank details</h1><p className="mt-1 text-sm text-white/50">Used only for approved withdrawals.</p></div>
      {available === false && <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-xs leading-relaxed text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><span><strong>Bank details are temporarily unavailable.</strong> This section opens after payment-provider approval and withdrawal readiness checks are complete.</span></div>}
      {methods.length > 0 && <section className="space-y-2" aria-labelledby="saved-bank-accounts"><h2 id="saved-bank-accounts" className="text-sm font-semibold text-white/70">Saved bank accounts</h2>{methods.map((method) => <div key={method.id} className="flex items-center gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/8 p-4"><Landmark className="h-5 w-5 shrink-0 text-emerald-300" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{method.bank_name || "Saved bank account"}</p><p className="truncate text-xs text-white/50">{method.account_number_masked || method.masked_account_number || "Account saved"} · {method.ifsc_masked || method.masked_ifsc_code || method.ifsc_code_masked || "IFSC secured"}</p>{method.payout_identifier_masked && <p className="mt-1 truncate font-mono text-[10px] text-white/40">Payout ID {method.payout_identifier_masked}</p>}</div><button type="button" onClick={() => remove(method)} disabled={Boolean(removeBusy)} aria-label={`Remove ${method.bank_name || "saved bank"} account`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-400/25 bg-red-400/10 text-red-300 disabled:opacity-45"><Trash2 className="h-4 w-4" /></button></div>)}</section>}
      <form onSubmit={submit} autoComplete="off" className="space-y-4 rounded-2xl border border-white/10 bg-card/55 p-4" data-testid="bank-details-form">
        <Field label="Account holder name" id="bank-holder"><Input id="bank-holder" disabled={!available} required autoComplete="off" value={form.account_holder_name} onChange={update("account_holder_name")} className="h-12 rounded-xl border-white/12 bg-white/5" /></Field>
        <Field label="Bank name" id="bank-name"><Input id="bank-name" disabled={!available} required autoComplete="off" value={form.bank_name} onChange={update("bank_name")} className="h-12 rounded-xl border-white/12 bg-white/5" /></Field>
        <Field label="Account number" id="bank-account"><Input id="bank-account" disabled={!available} required inputMode="numeric" autoComplete="off" value={form.account_number} onChange={update("account_number")} className="h-12 rounded-xl border-white/12 bg-white/5" /></Field>
        <Field label="Confirm account number" id="bank-confirm"><Input id="bank-confirm" disabled={!available} required inputMode="numeric" autoComplete="off" value={form.confirm_account_number} onChange={update("confirm_account_number")} className="h-12 rounded-xl border-white/12 bg-white/5" /></Field>
        <Field label="IFSC code" id="bank-ifsc"><Input id="bank-ifsc" disabled={!available} required autoCapitalize="characters" maxLength={11} autoComplete="off" value={form.ifsc_code} onChange={update("ifsc_code")} className="h-12 rounded-xl border-white/12 bg-white/5 uppercase" /></Field>
        <Field label="Payout ID (optional)" id="bank-payout-id"><Input id="bank-payout-id" disabled={!available} maxLength={100} autoComplete="off" placeholder="UPI or provider beneficiary ID" value={form.payout_identifier} onChange={update("payout_identifier")} className="h-12 rounded-xl border-white/12 bg-white/5" /></Field>
        <Button type="submit" disabled={busy || !available} className="h-12 w-full rounded-xl font-bold">{busy ? "Saving securely…" : !available ? "Withdrawals temporarily unavailable" : "Add bank account"}</Button>
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-white/40"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />Full account details are sent directly to the secure server and are never stored in this browser. Only masked values return to this screen.</p>
      </form>
    </PageTransition>
  );
}

function Field({ label, id, children }) { return <div className="space-y-1.5"><Label htmlFor={id}>{label}</Label>{children}</div>; }
