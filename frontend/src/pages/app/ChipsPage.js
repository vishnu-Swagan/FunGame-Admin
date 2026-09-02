import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowDownToLine, ArrowUpFromLine, CircleAlert, History, Landmark, LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageTransition, EmptyState, formatChips } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/api";
import { clearFinancialIntent, financialIntentKey } from "@/lib/financialIntent";
import { payments } from "@/lib/paymentApi";
import { isPromotionPolicyVersion, promotions } from "@/lib/promotionApi";
import { formatInrPaise, isFinancialFeatureAvailable, normalizeWallet, rupeesToPaise } from "@/lib/walletUtils";
import { PaymentRow, WalletBalanceCard } from "@/pages/app/wallet/WalletBits";
import { MissionCard, OfferReview } from "@/components/promotions";

const QUICK_BUY_AMOUNTS = [100, 500, 1000, 2500];
const QUICK_WITHDRAW_AMOUNTS = [1000, 2500, 5000, 10000];

function positiveInteger(...values) {
  const value = values.find((candidate) => Number.isSafeInteger(Number(candidate)) && Number(candidate) > 0);
  return value == null ? null : Number(value);
}

function inputRupees(paise) {
  if (!Number.isSafeInteger(paise) || paise <= 0) return "";
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/**
 * Payment limits and conversion are server-owned. The aliases allow an additive
 * rollout of the public configuration without coupling this screen to one DTO
 * nesting shape, but no money action is enabled if the values are absent.
 */
export function publicFinancialConfig(payload) {
  const financial = payload?.financial || {};
  const operator = financial.operator || {};
  const operatorLimits = operator.limits || {};
  const published = payload?.money_config || financial.public_config || financial.config || payload?.public_config || {};
  const limits = published.limits || financial.limits || published;
  const conversion = published.conversion || published.rate || financial.conversion || financial.rate || payload?.rate || {};
  const depositLimits = published.deposits || limits.deposits || {};
  const withdrawalLimits = published.withdrawals || limits.withdrawals || {};
  const chipsPerInr = positiveInteger(conversion.chips_per_inr, published.chips_per_inr, financial.chips_per_inr, operatorLimits.chips_per_inr);
  const minDepositPaise = positiveInteger(depositLimits.minimum_paise, limits.min_deposit_paise, published.min_deposit_paise, financial.min_deposit_paise, operatorLimits.min_deposit_paise);
  const maxDepositPaise = positiveInteger(depositLimits.maximum_paise, limits.max_deposit_paise, published.max_deposit_paise, financial.max_deposit_paise, operatorLimits.max_deposit_paise);
  let minWithdrawalChips = positiveInteger(withdrawalLimits.minimum_chips, limits.min_withdrawal_chips, published.min_withdrawal_chips, financial.min_withdrawal_chips, operatorLimits.min_withdrawal_chips);
  const maxWithdrawalChips = positiveInteger(withdrawalLimits.maximum_chips, limits.max_withdrawal_chips, published.max_withdrawal_chips, financial.max_withdrawal_chips, operatorLimits.max_withdrawal_chips);
  let minWithdrawalPaise = positiveInteger(withdrawalLimits.minimum_paise, limits.min_withdrawal_paise, published.min_withdrawal_paise, financial.min_withdrawal_paise, operatorLimits.min_withdrawal_paise);
  let maxWithdrawalPaise = positiveInteger(withdrawalLimits.maximum_paise, limits.max_withdrawal_paise, published.max_withdrawal_paise, financial.max_withdrawal_paise, operatorLimits.max_withdrawal_paise);

  if (!minWithdrawalChips && minWithdrawalPaise && chipsPerInr && (minWithdrawalPaise * chipsPerInr) % 100 === 0) {
    minWithdrawalChips = (minWithdrawalPaise * chipsPerInr) / 100;
  }

  if (!minWithdrawalPaise && minWithdrawalChips && chipsPerInr && (minWithdrawalChips * 100) % chipsPerInr === 0) {
    minWithdrawalPaise = (minWithdrawalChips * 100) / chipsPerInr;
  }
  if (!maxWithdrawalPaise && maxWithdrawalChips && chipsPerInr && (maxWithdrawalChips * 100) % chipsPerInr === 0) {
    maxWithdrawalPaise = (maxWithdrawalChips * 100) / chipsPerInr;
  }

  const publishedCheckoutHosts = Array.isArray(published.checkout_hosts) ? published.checkout_hosts : [];
  const financialCheckoutHosts = Array.isArray(financial.checkout_hosts) ? financial.checkout_hosts : [];
  const operatorCheckoutHosts = Array.isArray(operator.checkout_hosts) ? operator.checkout_hosts : [];
  const checkoutHosts = [...new Set([
    ...publishedCheckoutHosts,
    ...financialCheckoutHosts,
    ...operatorCheckoutHosts,
  ].map((host) => String(host || "").trim()).filter(Boolean))];
  return {
    chipsPerInr,
    minDepositPaise,
    maxDepositPaise,
    minWithdrawalChips,
    maxWithdrawalChips,
    minWithdrawalPaise,
    maxWithdrawalPaise,
    checkoutHosts,
    operatorCheckoutHosts,
  };
}

export function safeHostedCheckoutUrl(value, allowedHosts = []) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443")) return null;
    const hosts = allowedHosts.map((entry) => {
      try { return new URL(String(entry).includes("://") ? String(entry) : `https://${entry}`).hostname.toLowerCase(); }
      catch (_error) { return ""; }
    }).filter(Boolean);
    if (!hosts.length || !hosts.includes(parsed.hostname.toLowerCase())) return null;
    return parsed.href;
  } catch (_error) {
    return null;
  }
}

export function isServerPromotionOfferEligible(offer, depositPaise) {
  if (!offer) return true;
  const finalityHours = Number(offer.claim_finality_hours);
  return offer.deposit_amount_paise === depositPaise
    && offer.target_chips > 0
    && Boolean(offer.rate_version)
    && Boolean(offer.quote_token)
    && Number.isFinite(new Date(offer.deadline_at).getTime())
    && Number.isFinite(new Date(offer.quote_expires_at).getTime())
    && Boolean(offer.terms_version)
    && /^[A-Z]{2}$/.test(offer.jurisdiction)
    && Number.isSafeInteger(finalityHours)
    && finalityHours >= 1
    && finalityHours <= 720
    && isPromotionPolicyVersion(offer.settlement_finality_policy_version);
}

function tabForPath(pathname) {
  if (pathname.endsWith("/withdraw")) return "withdraw";
  if (pathname.endsWith("/activity")) return "activity";
  return "buy";
}

function defaultCheckoutNavigator(url) {
  window.location.assign(url);
}

export default function ChipsPage({ checkoutNavigator = defaultCheckoutNavigator }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const [tab, setTab] = useState(tabForPath(location.pathname));
  const [wallet, setWallet] = useState(() => normalizeWallet(null, user?.chip_balance));
  const [financial, setFinancial] = useState(null);
  const [config, setConfig] = useState(() => publicFinancialConfig(null));
  const [deposits, setDeposits] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [offers, setOffers] = useState([]);
  const [selectedOfferId, setSelectedOfferId] = useState("");
  const [bonusAccepted, setBonusAccepted] = useState(false);
  const [buyAmount, setBuyAmount] = useState("1000");
  const [withdrawAmount, setWithdrawAmount] = useState("1000");
  const [bankAccountId, setBankAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [withdrawalIssue, setWithdrawalIssue] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    const [walletResult, depositsResult, withdrawalsResult, banksResult] = await Promise.allSettled([
      payments.wallet(), payments.deposits(), payments.withdrawals(), payments.bankDetails(),
    ]);

    if (walletResult.status === "fulfilled") {
      const payload = walletResult.value;
      const nextConfig = publicFinancialConfig(payload);
      setWallet(normalizeWallet(payload, user?.chip_balance));
      setFinancial(payload?.financial || null);
      setConfig(nextConfig);
      if (nextConfig.minDepositPaise) {
        setBuyAmount((current) => {
          const paise = rupeesToPaise(current);
          return paise && paise >= nextConfig.minDepositPaise ? current : inputRupees(nextConfig.minDepositPaise);
        });
      }
      if (nextConfig.minWithdrawalPaise) {
        setWithdrawAmount((current) => {
          const paise = rupeesToPaise(current);
          return paise && paise >= nextConfig.minWithdrawalPaise ? current : inputRupees(nextConfig.minWithdrawalPaise);
        });
      }
    } else {
      setFinancial(null);
      toast.error(errMsg(walletResult.reason, "Wallet details are temporarily unavailable."));
    }
    if (depositsResult.status === "fulfilled") setDeposits(depositsResult.value);
    if (withdrawalsResult.status === "fulfilled") setWithdrawals(withdrawalsResult.value);
    if (banksResult.status === "fulfilled") setBankAccounts(banksResult.value);
    setLoading(false);
  }, [user?.chip_balance]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTab(tabForPath(location.pathname)); }, [location.pathname]);
  useEffect(() => {
    if (!bankAccountId && bankAccounts[0]?.id) setBankAccountId(bankAccounts[0].id);
    if (bankAccountId && !bankAccounts.some((account) => account.id === bankAccountId)) setBankAccountId(bankAccounts[0]?.id || "");
  }, [bankAccounts, bankAccountId]);

  const buyFeatureAvailable = isFinancialFeatureAvailable(financial, "deposits");
  const withdrawalFeatureAvailable = isFinancialFeatureAvailable(financial, "withdrawals");
  const providerReadinessCopy = buyFeatureAvailable && withdrawalFeatureAvailable
    ? "Deposits and withdrawals are completed by the approved provider selected by the secure server. Funds are credited only after server verification; returning from checkout never changes your balance by itself."
    : buyFeatureAvailable
      ? "Deposits are completed by the approved provider selected by the secure server. Withdrawals are not active yet. Funds are credited only after server verification; returning from checkout never changes your balance by itself."
      : withdrawalFeatureAvailable
        ? "Withdrawals are completed by the approved provider selected by the secure server. Deposits are not active yet."
        : "Payment services are not active yet. Deposits and withdrawals remain unavailable while secure provider setup and server readiness checks are completed.";
  const buyConfigured = Boolean(
    config.chipsPerInr
    && config.minDepositPaise
    && config.maxDepositPaise
    && (hostedUpiBuyAvailable
      ? config.operatorCheckoutHosts.length
      : hostedBuyAvailable
        ? config.checkoutHosts.length
        : operatorBuyAvailable),
  );
  const withdrawalConfigured = Boolean(config.chipsPerInr && config.minWithdrawalPaise && config.minWithdrawalChips && config.maxWithdrawalChips);
  const buyPaise = rupeesToPaise(buyAmount);
  const buyChips = buyPaise && config.chipsPerInr ? Math.floor((buyPaise * config.chipsPerInr) / 100) : 0;
  const withdrawPaise = rupeesToPaise(withdrawAmount);
  const withdrawNumerator = withdrawPaise && config.chipsPerInr ? withdrawPaise * config.chipsPerInr : 0;
  const withdrawChips = withdrawNumerator && withdrawNumerator % 100 === 0 ? withdrawNumerator / 100 : null;

  useEffect(() => {
    let active = true;
    setBonusAccepted(false);
    if (!buyPaise) {
      setOffers([]);
      setSelectedOfferId("");
      setBonusAccepted(false);
      return () => { active = false; };
    }
    promotions.offers(buyPaise).then((rows) => {
      if (!active) return;
      setOffers(rows);
      setSelectedOfferId((current) => rows.some((offer) => offer.id === current) ? current : "");
    }).catch(() => {
      if (!active) return;
      // Promotion gates fail closed without making the core wallet unavailable.
      setOffers([]);
      setSelectedOfferId("");
      setBonusAccepted(false);
    });
    return () => { active = false; };
  }, [buyPaise]);

  const selectedOffer = useMemo(() => offers.find((offer) => offer.id === selectedOfferId) || null, [offers, selectedOfferId]);
  const selectedOfferEligible = isServerPromotionOfferEligible(selectedOffer, buyPaise);

  const activity = useMemo(() => [
    ...deposits.map((item) => ({ item, kind: "deposit" })),
    ...withdrawals.map((item) => ({ item, kind: "withdrawal" })),
  ].sort((left, right) => new Date(right.item.created_at || 0) - new Date(left.item.created_at || 0)), [deposits, withdrawals]);

  const changeTab = (next) => {
    setTab(next);
    navigate(next === "withdraw" ? "/wallet/withdraw" : next === "activity" ? "/wallet/activity" : "/wallet", { replace: true });
  };

  const buy = async (event) => {
    event.preventDefault();
    if (!buyFeatureAvailable || !buyConfigured) return toast.info("Deposits are temporarily unavailable.");
    if (!buyPaise || buyPaise < config.minDepositPaise || buyPaise > config.maxDepositPaise) {
      return toast.error(`Enter an amount between ${formatInrPaise(config.minDepositPaise)} and ${formatInrPaise(config.maxDepositPaise)}.`);
    }
    if (selectedOffer && !bonusAccepted) return toast.error("Accept the displayed bonus terms, or continue without the bonus.");
    if (selectedOffer && !selectedOfferEligible) return toast.error("This deposit does not meet the selected bonus requirements.");
    if (selectedOffer && (!selectedOffer.terms_version || !selectedOffer.jurisdiction)) return toast.error("This bonus is missing required terms metadata and cannot be selected.");
    const key = financialIntentKey("deposit", user?.id, `amount_paise=${buyPaise}`);
    setBusy("buy");
    try {
      let consent = null;
      let consentKey = null;
      if (selectedOffer) {
        consentKey = financialIntentKey("promotion-consent", user?.id, `campaign=${selectedOffer.campaign_id}&version=${selectedOffer.campaign_version}&amount_paise=${buyPaise}&quote=${selectedOffer.quote_token}`);
        consent = await promotions.acceptOffer(selectedOffer.campaign_id, {
          campaign_version: selectedOffer.campaign_version,
          jurisdiction: selectedOffer.jurisdiction,
          deposit_amount_paise: buyPaise,
          quote_token: selectedOffer.quote_token,
          terms_accepted: true,
        }, consentKey);
        if (!consent?.id) throw new Error("The server did not return a bonus consent receipt. Payment was not opened.");
        const consentMatchesDisplayedQuote = (
          Number(consent.quoted_deposit_amount_paise) === buyPaise
          && String(consent.quote_token || "") === selectedOffer.quote_token
          && Number(consent.quoted_deposit_chips) === selectedOffer.deposit_chips
          && Number(consent.quoted_target_chips) === selectedOffer.target_chips
          && String(consent.rate_version || "") === selectedOffer.rate_version
          && new Date(consent.quoted_deadline_at).getTime() === new Date(selectedOffer.deadline_at).getTime()
        );
        if (!consentMatchesDisplayedQuote) throw new Error("The bonus quote changed before acceptance. Payment was not opened; review the refreshed target and deadline.");
      }
      const result = selectedOffer
        ? await payments.createDeposit(buyPaise, key, { promotionConsentId: consent.id })
        : await payments.createDeposit(buyPaise, key);
      const checkoutUrl = safeHostedCheckoutUrl(result?.checkout_url, config.checkoutHosts);
      if (!checkoutUrl) throw new Error("The payment provider returned an invalid checkout address. No funds were credited.");
      checkoutNavigator(checkoutUrl);
      clearFinancialIntent("deposit", user?.id, key);
      if (consentKey) clearFinancialIntent("promotion-consent", user?.id, consentKey);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy("");
    }
  };

  const withdraw = async (event) => {
    event.preventDefault();
    if (!withdrawalFeatureAvailable || !withdrawalConfigured) return toast.info("Withdrawals are temporarily unavailable.");
    if (!withdrawPaise || withdrawPaise < config.minWithdrawalPaise || (config.maxWithdrawalPaise && withdrawPaise > config.maxWithdrawalPaise)) {
      return toast.error(config.maxWithdrawalPaise
        ? `Enter an amount between ${formatInrPaise(config.minWithdrawalPaise)} and ${formatInrPaise(config.maxWithdrawalPaise)}.`
        : `Enter a withdrawal of at least ${formatInrPaise(config.minWithdrawalPaise)}.`);
    }
    if (!withdrawChips || withdrawChips < config.minWithdrawalChips || withdrawChips > config.maxWithdrawalChips) {
      return toast.error("Choose an INR amount that converts to an eligible wallet amount.");
    }
    if (withdrawChips > wallet.withdrawable_chips) {
      setWithdrawalIssue({
        code: "WITHDRAWABLE_CASH_EXCEEDED",
        requested_chips: withdrawChips,
        withdrawable_chips: wallet.withdrawable_chips,
        restricted_bonus_chips: wallet.restricted_bonus_chips,
        active_mission: wallet.active_mission,
      });
      return;
    }
    if (!bankAccountId) return toast.error("Add and select a bank account before withdrawing.");

    setBusy("withdraw");
    try {
      await payments.createWithdrawal(withdrawChips, bankAccountId, key);
      setWithdrawalIssue(null);
      clearFinancialIntent("withdrawal", user?.id, key);
      toast.success("Withdrawal submitted. Track its status in Activity.");
      await Promise.allSettled([load(), refreshUser?.()]);
      changeTab("activity");
    } catch (error) {
      const detail = error?.response?.data?.detail;
      if (detail && typeof detail === "object" && ["WITHDRAWABLE_CASH_EXCEEDED", "AMOUNT_EXCEEDS_WITHDRAWABLE_CASH", "INSUFFICIENT_WITHDRAWABLE_BALANCE", "RESTRICTED_BONUS_EXCLUDED"].includes(detail.code)) {
        setWithdrawalIssue({
          ...detail.meta,
          ...detail,
          withdrawable_chips: detail.withdrawable_chips ?? detail.meta?.withdrawable_chips ?? wallet.withdrawable_chips,
          restricted_bonus_chips: detail.restricted_bonus_chips ?? detail.meta?.restricted_bonus_chips ?? wallet.restricted_bonus_chips,
          active_mission: detail.active_mission ?? detail.meta?.active_mission ?? wallet.active_mission,
        });
      } else toast.error(errMsg(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <PageTransition className="space-y-5" data-testid="wallet-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Wallet</h1>
        <p className="mt-1 text-sm text-white/50">Deposit securely, withdraw eligible cash, and follow every payment status.</p>
      </div>
      <WalletBalanceCard wallet={wallet} />
      {wallet.active_mission && <MissionCard mission={wallet.active_mission} onOpen={() => navigate(`/bonus-mission/${encodeURIComponent(wallet.active_mission.id || wallet.active_mission.mission_id)}`)} />}

      <div className="rounded-2xl border border-primary/25 bg-primary/8 p-4 text-xs leading-relaxed text-white/65">
        {providerReadinessCopy}
      </div>

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="grid h-12 w-full grid-cols-3 rounded-xl border border-white/10 bg-white/5">
          <TabsTrigger value="buy" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><ArrowDownToLine className="mr-1 h-4 w-4" />Deposit</TabsTrigger>
          <TabsTrigger value="withdraw" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><ArrowUpFromLine className="mr-1 h-4 w-4" />Withdraw</TabsTrigger>
          <TabsTrigger value="activity" className="rounded-lg text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><History className="mr-1 h-4 w-4" />Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="buy" className="mt-4">
          <form onSubmit={buy} className="space-y-4 rounded-2xl border border-primary/25 bg-card/55 p-4" data-testid="deposit-form">
            <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10"><ArrowDownToLine className="h-5 w-5 text-primary" /></div><div><p className="font-semibold">Deposit funds</p><p className="mt-1 text-xs leading-relaxed text-white/50">Pay in INR through secure hosted checkout. Your wallet updates after verified provider confirmation.</p></div></div>
            {!loading && (!buyFeatureAvailable || !buyConfigured) && <AvailabilityNotice text={buyFeatureAvailable ? "Payment limits are not yet available from the secure server." : "Deposits are temporarily unavailable."} />}
            <div className="grid grid-cols-4 gap-2">{QUICK_BUY_AMOUNTS.map((value) => <button key={value} type="button" onClick={() => setBuyAmount(String(value))} disabled={!buyFeatureAvailable || !buyConfigured} className={`min-h-11 rounded-xl border text-xs font-bold tabular-nums disabled:opacity-40 ${buyAmount === String(value) ? "border-primary/55 bg-primary/15 text-primary" : "border-white/10 bg-white/5 text-white/65"}`}>₹{value.toLocaleString("en-IN")}</button>)}</div>
            <Input data-testid="deposit-amount" aria-label="Amount in INR" type="text" inputMode="decimal" value={buyAmount} onChange={(event) => setBuyAmount(event.target.value)} disabled={!buyFeatureAvailable || !buyConfigured} className="h-12 rounded-xl border-white/12 bg-white/5 tabular-nums" />
            <div className="flex items-center justify-between rounded-xl border border-white/8 bg-black/10 px-3 py-2 text-xs"><span className="text-white/45">Player balance credit</span><strong className="tabular-nums text-primary">{formatChips(buyChips)}</strong></div>
            <OfferReview offers={offers} selectedOfferId={selectedOfferId} onSelect={setSelectedOfferId} accepted={bonusAccepted} onAcceptedChange={setBonusAccepted} depositPaise={buyPaise} />
            <Button data-testid="deposit-submit" type="submit" disabled={busy === "buy" || !buyFeatureAvailable || !buyConfigured || Boolean(selectedOffer && (!bonusAccepted || !selectedOfferEligible))} className="h-12 w-full rounded-xl text-base font-bold">{busy === "buy" ? "Opening secure checkout…" : selectedOffer ? "Accept bonus and continue" : "Continue to payment"}</Button>
          </form>
        </TabsContent>

        <TabsContent value="withdraw" className="mt-4">
          <form onSubmit={withdraw} className="space-y-4 rounded-2xl border border-primary/25 bg-card/55 p-4" data-testid="withdrawal-form">
            <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10"><ArrowUpFromLine className="h-5 w-5 text-primary" /></div><div><p className="font-semibold">Withdraw to your bank</p><p className="mt-1 text-xs leading-relaxed text-white/50">Minimum withdrawal: <strong className="text-white/75">{config.minWithdrawalPaise ? formatInrPaise(config.minWithdrawalPaise) : "set by the secure server"}</strong>. Admin approves, then SgPay pays your saved method.</p></div></div>
            {wallet.wager_remaining_chips > 0 && <AvailabilityNotice text={`Wager ₹${((wallet.wager_remaining_chips || 0) / (config.chipsPerInr || 1)).toLocaleString("en-IN")} more from deposits before you can request a withdrawal.`} />}
            {!loading && (!withdrawalFeatureAvailable || !withdrawalConfigured) && <AvailabilityNotice text={withdrawalFeatureAvailable ? "Withdrawal limits are not yet available from the secure server." : "Withdrawals are temporarily unavailable."} />}
            <div className="grid grid-cols-4 gap-2">{QUICK_WITHDRAW_AMOUNTS.map((value) => <button key={value} type="button" onClick={() => { setWithdrawAmount(String(value)); setWithdrawalIssue(null); }} disabled={!withdrawalFeatureAvailable || !withdrawalConfigured} className={`min-h-11 rounded-xl border text-xs font-bold tabular-nums disabled:opacity-40 ${withdrawAmount === String(value) ? "border-primary/55 bg-primary/15 text-primary" : "border-white/10 bg-white/5 text-white/65"}`}>₹{value.toLocaleString("en-IN")}</button>)}</div>
            <Input data-testid="withdrawal-amount" aria-label="Withdrawal amount in INR" type="text" inputMode="decimal" value={withdrawAmount} onChange={(event) => { setWithdrawAmount(event.target.value); setWithdrawalIssue(null); }} disabled={!withdrawalFeatureAvailable || !withdrawalConfigured} className="h-12 rounded-xl border-white/12 bg-white/5 tabular-nums" />
            <div className="flex items-center justify-between rounded-xl border border-white/8 bg-black/10 px-3 py-2 text-xs"><span className="text-white/45">Uses from withdrawable balance</span><strong className="tabular-nums text-primary">{withdrawChips ? formatChips(withdrawChips) : "—"}</strong></div>
            {withdrawalIssue && <WithdrawalRestrictionNotice issue={withdrawalIssue} onMission={(mission) => mission && navigate(`/bonus-mission/${encodeURIComponent(mission.id || mission.mission_id)}`)} onHelp={() => navigate("/support")} />}
            {bankAccounts.length ? <label className="block space-y-1.5 text-sm font-medium" htmlFor="withdrawal-bank-account"><span>Bank account</span><select id="withdrawal-bank-account" data-testid="withdrawal-bank-account" value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)} disabled={!withdrawalFeatureAvailable || !withdrawalConfigured} className="h-12 w-full rounded-xl border border-white/12 bg-background px-3 text-sm"><option value="">Select a bank account</option>{bankAccounts.map((account) => <option key={account.id} value={account.id} label={`${account.bank_name || "Bank account"} · ${account.account_number_masked || account.masked_account_number || "Account secured"}`} />)}</select></label> : <button type="button" data-testid="add-bank-account" onClick={() => navigate("/profile/bank-details", { state: { returnTo: "/wallet/withdraw" } })} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/10 text-sm font-bold text-primary"><Landmark className="h-4 w-4" />Add bank account</button>}
            <Button data-testid="withdrawal-submit" type="submit" disabled={busy === "withdraw" || !withdrawalFeatureAvailable || !withdrawalConfigured || !bankAccountId} className="h-12 w-full rounded-xl text-base font-bold">{busy === "withdraw" ? "Submitting securely…" : "Request withdrawal"}</Button>
          </form>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          {loading ? <div className="h-40 rounded-2xl fg-shimmer border border-white/5" /> : activity.length === 0 ? <EmptyState icon={History} title="No payment activity" subtitle="Deposits and withdrawals will appear here." /> : <section aria-label="Payment activity" className="overflow-hidden rounded-2xl border border-white/10 bg-card/55"><div className="divide-y divide-white/5">{activity.map(({ item, kind }) => <PaymentRow key={`${kind}:${item.id}`} item={item} kind={kind} />)}</div></section>}
        </TabsContent>
      </Tabs>
      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-white/40"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />Payment credentials and full bank details are never stored in this browser. Provider callbacks and wallet changes are verified by the server.</p>
    </PageTransition>
  );
}

function AvailabilityNotice({ text }) {
  return <div className="rounded-xl border border-amber-300/25 bg-amber-300/8 px-3 py-2 text-xs leading-relaxed text-amber-100">{text}</div>;
}

function ControllingMissionRow({ mission, onOpen }) {
  const missionTitle = mission?.title || mission?.campaign_title || mission?.name || null;
  const campaignReference = mission?.campaign_id
    ? `Campaign ${mission.campaign_id}${mission.campaign_version ? ` · version ${mission.campaign_version}` : ""}`
    : null;
  const missionReference = mission?.id || mission?.mission_id;
  return (
    <div className="rounded-lg border border-white/8 bg-white/[.025] p-2">
      <p className="font-bold text-white/80">{missionTitle || campaignReference || `Mission ${missionReference || "reference unavailable"}`}</p>
      {missionTitle && campaignReference && <p className="mt-1 text-[10px] text-white/45">{campaignReference}</p>}
      {missionReference && <p className="mt-1 break-all font-mono text-[10px] text-white/40">Mission {missionReference}</p>}
      {missionReference && <button type="button" onClick={() => onOpen(mission)} className="mt-2 min-h-11 w-full rounded-xl border border-primary/30 bg-primary/10 px-2 text-xs font-bold text-primary">{mission.forfeit_allowed === true ? "Review forfeiture option" : "View mission"}</button>}
    </div>
  );
}

function WithdrawalRestrictionNotice({ issue, onMission, onHelp }) {
  const controllingMissions = Array.isArray(issue.controlling_missions) && issue.controlling_missions.length
    ? issue.controlling_missions
    : issue.active_mission ? [issue.active_mission] : [];
  return (
    <div className="rounded-xl border border-amber-300/25 bg-amber-300/[.07] p-3" role="status" data-testid="withdrawal-balance-explanation">
      <div className="flex items-start gap-2.5"><CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" /><div><p className="text-sm font-bold text-amber-100">Choose an amount from withdrawable cash</p><p className="mt-1 text-xs leading-relaxed text-amber-50/70">You requested {formatChips(issue.requested_chips || 0)}. {formatChips(issue.withdrawable_chips || 0)} is currently withdrawable. A bonus mission does not block that cleared amount.</p></div></div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg border border-white/8 bg-black/10 p-2.5"><dt className="text-white/45">Withdrawable cash</dt><dd className="mt-1 tabular-nums font-bold text-emerald-200">{formatChips(issue.withdrawable_chips || 0)}</dd></div><div className="rounded-lg border border-white/8 bg-black/10 p-2.5"><dt className="text-white/45">Restricted bonus</dt><dd className="mt-1 tabular-nums font-bold text-fuchsia-200">{formatChips(issue.restricted_bonus_chips || 0)}</dd></div></dl>
      {controllingMissions.length > 0 && <div className="mt-3 space-y-2 rounded-lg border border-white/8 bg-black/10 p-2.5 text-xs" data-testid="withdrawal-controlling-mission"><p className="text-white/45">Bonus controlled by</p>{controllingMissions.map((mission, index) => <ControllingMissionRow key={mission?.id || mission?.mission_id || `${mission?.campaign_id}:${index}`} mission={mission} onOpen={onMission} />)}<p className="text-[10px] leading-relaxed text-white/50">These missions control only the restricted bonus shown above, not your cleared cash.</p></div>}
      <button type="button" onClick={onHelp} className="mt-3 min-h-11 w-full rounded-xl border border-white/12 bg-white/5 text-xs font-bold text-white/65">Get help</button>
    </div>
  );
}
