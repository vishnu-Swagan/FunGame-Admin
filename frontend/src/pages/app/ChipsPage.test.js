import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import ChipsPage, { isServerPromotionOfferEligible, publicFinancialConfig, safeHostedCheckoutUrl } from "./ChipsPage";

const mockNavigate = jest.fn();
const mockRefreshUser = jest.fn();
const mockWallet = jest.fn();
const mockDeposits = jest.fn();
const mockWithdrawals = jest.fn();
const mockBankDetails = jest.fn();
const mockCreateDeposit = jest.fn();
const mockCreateWithdrawal = jest.fn();
const mockCreateOperatorDeposit = jest.fn();
const mockCreateOperatorWithdrawal = jest.fn();
const mockOffers = jest.fn();
const mockAcceptOffer = jest.fn();
const mockFinancialIntentKey = jest.fn();
const mockClearFinancialIntent = jest.fn();
let mockPathname = "/wallet";

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname }),
}), { virtual: true });

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "player-1", chip_balance: 250 }, refreshUser: mockRefreshUser }),
}));

jest.mock("@/lib/paymentApi", () => ({ payments: {
  wallet: (...args) => mockWallet(...args),
  deposits: (...args) => mockDeposits(...args),
  withdrawals: (...args) => mockWithdrawals(...args),
  bankDetails: (...args) => mockBankDetails(...args),
  createDeposit: (...args) => mockCreateDeposit(...args),
  createWithdrawal: (...args) => mockCreateWithdrawal(...args),
  createOperatorDeposit: (...args) => mockCreateOperatorDeposit(...args),
  createOperatorWithdrawal: (...args) => mockCreateOperatorWithdrawal(...args),
  chipTransactions: (...args) => mockChipTransactions(...args),
} }));

jest.mock("@/lib/promotionApi", () => ({
  normalizeMission: (value) => value,
  isPromotionPolicyVersion: (value) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(String(value || "")),
  promotions: {
    offers: (...args) => mockOffers(...args),
    acceptOffer: (...args) => mockAcceptOffer(...args),
  },
}));

jest.mock("@/lib/financialIntent", () => ({
  financialIntentKey: (...args) => mockFinancialIntentKey(...args),
  clearFinancialIntent: (...args) => mockClearFinancialIntent(...args),
}));

jest.mock("@/lib/api", () => ({
  errMsg: (error, fallback) => error?.message || fallback || "Request failed",
  errCode: (error) => error?.code || error?.response?.data?.detail?.code || null,
}));

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }), { virtual: true });

jest.mock("lucide-react", () => ({
  ArrowDownToLine: () => null,
  ArrowUpFromLine: () => null,
  History: () => null,
  Landmark: () => null,
  LockKeyhole: () => null,
  CircleAlert: () => null,
  Check: () => null,
  CircleDollarSign: () => null,
  Clock3: () => null,
  Gamepad2: () => null,
  Info: () => null,
  ShieldCheck: () => null,
  X: () => null,
  Gift: () => null,
  CirclePause: () => null,
  ArrowRight: () => null,
}), { virtual: true });

jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  EmptyState: ({ title }) => <div>{title}</div>,
  formatChips: (value) => String(value ?? 0),
}));

jest.mock("@/pages/app/wallet/WalletBits", () => ({
  WalletBalanceCard: () => <div data-testid="wallet-balance-card" />,
  PaymentRow: ({ item, kind }) => <div data-testid={`${kind}-activity-row`}>{item.id}</div>,
  PlayRow: ({ item }) => <div data-testid="play-activity-row">{item.id}</div>,
}));

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }) => <div>{children}</div>,
  TabsList: ({ children }) => <div>{children}</div>,
  TabsTrigger: ({ children, ...props }) => <button {...props}>{children}</button>,
  TabsContent: ({ children, value }) => <div data-tab={value}>{children}</div>,
}));

jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));

const READY_WALLET = {
  wallet: {
    available_chips: 50000,
    cash_chips: 50000,
    bonus_chips: 0,
    held_chips: 0,
    withdrawable_chips: 50000,
  },
  financial: {
    ready: true,
    features: { real_money: true, deposits: true, withdrawals: true },
  },
  money_config: {
    currency: "INR",
    rate: { chips_per_inr: 1, paise_per_inr: 100 },
    checkout_hosts: ["pay.example"],
    deposits: { minimum_paise: 10000, maximum_paise: 100000000 },
    withdrawals: {
      minimum_paise: 100000,
      maximum_paise: 100000000,
      minimum_chips: 1000,
      maximum_chips: 1000000,
      exact_chip_conversion_required: true,
    },
  },
};

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderPage(props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ChipsPage {...props} />);
    await settle();
  });
  return { container, root };
}

function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  mockPathname = "/wallet";
  mockNavigate.mockReset();
  mockRefreshUser.mockReset().mockResolvedValue(undefined);
  mockWallet.mockReset().mockResolvedValue(READY_WALLET);
  mockDeposits.mockReset().mockResolvedValue([{ id: "deposit-1", status: "CREDITED", created_at: "2026-08-31T10:00:00Z" }]);
  mockWithdrawals.mockReset().mockResolvedValue([{ id: "withdrawal-1", status: "PENDING", created_at: "2026-08-31T11:00:00Z" }]);
  mockBankDetails.mockReset().mockResolvedValue([{ id: "bank-1", bank_name: "Secure Bank", account_number_masked: "••••1234" }]);
  mockCreateDeposit.mockReset().mockResolvedValue({ checkout_url: "https://pay.example/checkout/order-1" });
  mockCreateWithdrawal.mockReset().mockResolvedValue({ withdrawal: { id: "withdrawal-2", status: "PENDING" } });
  mockOffers.mockReset().mockResolvedValue([]);
  mockAcceptOffer.mockReset().mockResolvedValue({ id: "consent-1", quote_token: "quote-token-1", quoted_deposit_amount_paise: 100000, quoted_deposit_chips: 1000, quoted_target_chips: 10000, quoted_deadline_at: "2026-09-05T10:00:00Z", rate_version: "rate-1" });
  mockFinancialIntentKey.mockReset().mockImplementation((kind) => `${kind}-key`);
  mockClearFinancialIntent.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

test("normalizes server-owned financial limits and rejects unsafe checkout URLs", () => {
  expect(publicFinancialConfig(READY_WALLET)).toMatchObject({
    chipsPerInr: 1,
    minDepositPaise: 10000,
    minWithdrawalPaise: 100000,
    minWithdrawalChips: 1000,
  });
  expect(safeHostedCheckoutUrl("https://pay.example/checkout/1", ["pay.example"])).toBe("https://pay.example/checkout/1");
  expect(safeHostedCheckoutUrl("https://pay.example/checkout/1")).toBeNull();
  expect(safeHostedCheckoutUrl("https://pay.example/checkout/1", [])).toBeNull();
  expect(safeHostedCheckoutUrl("http://pay.example/checkout/1", ["pay.example"])).toBeNull();
  expect(safeHostedCheckoutUrl("https://other.example/checkout/1", ["pay.example"])).toBeNull();
  expect(safeHostedCheckoutUrl("https://user:secret@pay.example/checkout/1", ["pay.example"])).toBeNull();
  expect(safeHostedCheckoutUrl("https://pay.example:8443/checkout/1", ["pay.example"])).toBeNull();
  expect(safeHostedCheckoutUrl("https://pay.example:443/checkout/1", ["pay.example"])).toBe("https://pay.example/checkout/1");
});

test("promotion offer eligibility fails closed outside the disclosed 1 to 720 hour finality range", () => {
  const offer = {
    deposit_amount_paise: 100000, target_chips: 5000, rate_version: "rate-1",
    quote_token: "quote-123", deadline_at: "2026-09-05T10:00:00Z",
    quote_expires_at: "2026-09-02T10:10:00Z", terms_version: "terms-1",
    jurisdiction: "IN", claim_finality_hours: 24,
    settlement_finality_policy_version: "settlement-v1",
  };
  expect(isServerPromotionOfferEligible(offer, 100000)).toBe(true);
  expect(isServerPromotionOfferEligible({ ...offer, claim_finality_hours: 0 }, 100000)).toBe(false);
  expect(isServerPromotionOfferEligible({ ...offer, claim_finality_hours: 721 }, 100000)).toBe(false);
  expect(isServerPromotionOfferEligible({ ...offer, claim_finality_hours: undefined }, 100000)).toBe(false);
  expect(isServerPromotionOfferEligible({ ...offer, settlement_finality_policy_version: "" }, 100000)).toBe(false);
  expect(isServerPromotionOfferEligible({ ...offer, settlement_finality_policy_version: "invalid policy!" }, 100000)).toBe(false);
});

test("Deposit creates an idempotent INR order and opens only the routed hosted checkout", async () => {
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });
  expect(container.querySelector('[data-testid="manual-chip-request-form"]')).toBeNull();
  expect(container.querySelector('[data-testid="deposit-form"]')).not.toBeNull();
  expect(container.textContent).toContain("Deposit funds");
  expect(container.textContent).toContain("₹1,000");
  expect(container.textContent).toContain("completed by the approved provider");

  change(container.querySelector('[data-testid="deposit-amount"]'), "2500");
  await submit(container.querySelector('[data-testid="deposit-form"]'));

  expect(mockFinancialIntentKey).toHaveBeenCalledWith("deposit", "player-1", "amount_paise=250000");
  expect(mockCreateDeposit).toHaveBeenCalledWith(250000, "deposit-key");
  expect(checkoutNavigator).toHaveBeenCalledWith("https://pay.example/checkout/order-1");
  expect(mockClearFinancialIntent).toHaveBeenCalledWith("deposit", "player-1", "deposit-key");
  await act(async () => root.unmount());
});

test("explicit bonus consent is attached to the exact deposit order", async () => {
  mockOffers.mockResolvedValue([{
    id: "campaign-1",
    campaign_id: "campaign-1",
    campaign_version: 2,
    name: "Golden mission",
    terms_version: "terms-2",
    jurisdiction: "IN",
    claim_finality_hours: 24,
    settlement_finality_policy_version: "settlement-v1",
    deposit_amount_paise: 100000,
    deposit_chips: 1000,
    rate_version: "rate-1",
    quote_token: "quote-token-1",
    quote_expires_at: "2026-09-02T10:10:00Z",
    deadline_at: "2026-09-05T10:00:00Z",
    reward: { type: "BONUS_CHIPS", chips: 500 },
    target_chips: 10000,
    contribution_rules: { default_bps: 10000, allowed_games: ["Aviator"], excluded_games: [] },
    significant_terms: ["Complete before the displayed deadline."],
    withdrawal_consequence: "Deposited cash stays withdrawable.",
  }]);
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });

  act(() => container.querySelector('[role="radio"]').click());
  const consentCheckbox = container.querySelector('[role="checkbox"]');
  expect(consentCheckbox).not.toBeNull();
  act(() => consentCheckbox.click());
  await submit(container.querySelector('[data-testid="deposit-form"]'));

  expect(mockAcceptOffer).toHaveBeenCalledWith("campaign-1", {
    campaign_version: 2,
    jurisdiction: "IN",
    deposit_amount_paise: 100000,
    quote_token: "quote-token-1",
    terms_accepted: true,
  }, expect.any(String));
  expect(mockCreateDeposit).toHaveBeenCalledWith(100000, "deposit-key", { promotionConsentId: "consent-1" });
  expect(checkoutNavigator).toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("a malformed settlement-finality window cannot be accepted or open payment", async () => {
  mockOffers.mockResolvedValue([{
    id: "campaign-unsafe", campaign_id: "campaign-unsafe", campaign_version: 1,
    name: "Incomplete mission", terms_version: "terms-1", jurisdiction: "IN",
    claim_finality_hours: 0,
    deposit_amount_paise: 100000, deposit_chips: 1000, target_chips: 5000,
    rate_version: "rate-1", quote_token: "quote-token-unsafe",
    quote_expires_at: "2026-09-02T10:10:00Z", deadline_at: "2026-09-05T10:00:00Z",
    reward: { type: "BONUS_CHIPS", chips: 250 },
    contribution_rules: { default_bps: 10000, allowed_games: ["Aviator"], excluded_games: [] },
  }]);
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });

  act(() => container.querySelector('[role="radio"]').click());
  expect(container.querySelector('[role="checkbox"]').disabled).toBe(true);
  expect(container.querySelector('[data-testid="deposit-submit"]').disabled).toBe(true);
  await submit(container.querySelector('[data-testid="deposit-form"]'));
  expect(mockAcceptOffer).not.toHaveBeenCalled();
  expect(mockCreateDeposit).not.toHaveBeenCalled();
  expect(checkoutNavigator).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("payment does not open when the accepted consent differs from the displayed quote", async () => {
  mockOffers.mockResolvedValue([{
    id: "campaign-1", campaign_id: "campaign-1", campaign_version: 2,
    name: "Golden mission", terms_version: "terms-2", jurisdiction: "IN", claim_finality_hours: 24,
    settlement_finality_policy_version: "settlement-v1",
    deposit_amount_paise: 100000, deposit_chips: 1000, target_chips: 10000,
    rate_version: "rate-1", quote_token: "quote-token-1",
    quote_expires_at: "2026-09-02T10:10:00Z", deadline_at: "2026-09-05T10:00:00Z",
    reward: { type: "BONUS_CHIPS", chips: 500 },
    contribution_rules: { default_bps: 10000, allowed_games: ["Aviator"], excluded_games: [] },
  }]);
  mockAcceptOffer.mockResolvedValue({
    id: "consent-1", quote_token: "quote-token-1",
    quoted_deposit_amount_paise: 100000, quoted_deposit_chips: 1000,
    quoted_target_chips: 12000, quoted_deadline_at: "2026-09-05T10:00:00Z",
    rate_version: "rate-1",
  });
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });
  act(() => container.querySelector('[role="radio"]').click());
  act(() => container.querySelector('[role="checkbox"]').click());
  await submit(container.querySelector('[data-testid="deposit-form"]'));
  expect(mockCreateDeposit).not.toHaveBeenCalled();
  expect(checkoutNavigator).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("does not claim an active approved provider while financial readiness is dormant", async () => {
  mockWallet.mockResolvedValue({
    ...READY_WALLET,
    financial: {
      ready: false,
      features: { real_money: false, deposits: false, withdrawals: false },
    },
  });
  const { container, root } = await renderPage();

  expect(container.textContent).toContain("Payment services are not active yet");
  expect(container.textContent).toContain("remain unavailable");
  expect(container.textContent).not.toContain("completed by the approved provider");
  expect(container.querySelector('[data-testid="deposit-submit"]').disabled).toBe(true);
  expect(container.querySelector('[data-testid="withdrawal-submit"]').disabled).toBe(true);
  await act(async () => root.unmount());
});

test("provider readiness copy reports deposit-only availability precisely", async () => {
  mockWallet.mockResolvedValue({
    ...READY_WALLET,
    financial: {
      ready: true,
      features: { real_money: true, deposits: true, withdrawals: false },
    },
  });
  const { container, root } = await renderPage();

  expect(container.textContent).toContain("Deposits are completed by the approved provider");
  expect(container.textContent).toContain("Withdrawals are not active yet");
  expect(container.textContent).not.toContain("Deposits and withdrawals are completed");
  expect(container.querySelector('[data-testid="deposit-submit"]').disabled).toBe(false);
  expect(container.querySelector('[data-testid="withdrawal-submit"]').disabled).toBe(true);
  await act(async () => root.unmount());
});

test("provider readiness copy reports withdrawal-only availability precisely", async () => {
  mockWallet.mockResolvedValue({
    ...READY_WALLET,
    financial: {
      ready: true,
      features: { real_money: true, deposits: false, withdrawals: true },
    },
  });
  const { container, root } = await renderPage();

  expect(container.textContent).toContain("Withdrawals are completed by the approved provider");
  expect(container.textContent).toContain("Deposits are not active yet");
  expect(container.textContent).not.toContain("Chip purchases and withdrawals are completed");
  expect(container.querySelector('[data-testid="deposit-submit"]').disabled).toBe(true);
  expect(container.querySelector('[data-testid="withdrawal-submit"]').disabled).toBe(false);
  await act(async () => root.unmount());
});

test("Deposit remains fail-closed when the server publishes no checkout hosts", async () => {
  const noCheckoutHosts = JSON.parse(JSON.stringify(READY_WALLET));
  delete noCheckoutHosts.money_config.checkout_hosts;
  mockWallet.mockResolvedValue(noCheckoutHosts);
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });

  expect(container.querySelector('[data-testid="deposit-submit"]').disabled).toBe(true);
  await submit(container.querySelector('[data-testid="deposit-form"]'));
  expect(mockCreateDeposit).not.toHaveBeenCalled();
  expect(checkoutNavigator).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("withdrawal uses the selected masked bank account and the server ₹1,000 minimum", async () => {
  mockPathname = "/wallet/withdraw";
  const { container, root } = await renderPage();
  expect(container.textContent).toContain("Minimum withdrawal:");
  expect(container.textContent).toContain("₹1,000");
  expect(container.querySelector('[data-testid="withdrawal-bank-account"]').value).toBe("bank-1");

  change(container.querySelector('[data-testid="withdrawal-amount"]'), "1000");
  await submit(container.querySelector('[data-testid="withdrawal-form"]'));

  expect(mockFinancialIntentKey).toHaveBeenCalledWith("withdrawal", "player-1", "amount_chips=1000&bank=bank-1");
  expect(mockCreateWithdrawal).toHaveBeenCalledWith(1000, "bank-1", "withdrawal-key");
  expect(mockClearFinancialIntent).toHaveBeenCalledWith("withdrawal", "player-1", "withdrawal-key");
  expect(mockNavigate).toHaveBeenCalledWith("/wallet/activity", { replace: true });
  await act(async () => root.unmount());
});

test("withdrawal exceeding cleared cash shows a structured split instead of submitting", async () => {
  mockPathname = "/wallet/withdraw";
  mockWallet.mockResolvedValue({
    ...READY_WALLET,
    wallet: {
      ...READY_WALLET.wallet,
      withdrawable_chips: 500,
      restricted_bonus_chips: 300,
      active_mission: { id: "mission-1", campaign_id: "gold-mission", campaign_version: 2, title: "Gold mission", status: "ACTIVE", forfeit_allowed: true, progress: { percent: 25 } },
    },
  });
  const { container, root } = await renderPage();
  await submit(container.querySelector('[data-testid="withdrawal-form"]'));

  expect(mockCreateWithdrawal).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="withdrawal-balance-explanation"]')).not.toBeNull();
  expect(container.textContent).toContain("500 is currently withdrawable");
  expect(container.textContent).toContain("Restricted bonus");
  expect(container.textContent).toContain("Gold mission");
  expect(container.textContent).toContain("Campaign gold-mission · version 2");
  expect(container.textContent).toContain("Mission mission-1");
  expect(container.textContent).toContain("Review forfeiture option");
  expect(container.querySelector('[data-testid="withdrawal-submit"]').disabled).toBe(false);
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Review forfeiture option")).click());
  expect(mockNavigate).toHaveBeenCalledWith("/bonus-mission/mission-1");
  expect(mockCreateWithdrawal).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("a server-race WITHDRAWABLE_CASH_EXCEEDED response renders structured guidance instead of a toast", async () => {
  mockPathname = "/wallet/withdraw";
  mockCreateWithdrawal.mockRejectedValue({
    response: {
      data: {
        detail: {
          code: "WITHDRAWABLE_CASH_EXCEEDED",
          message: "The requested amount exceeds cleared cash.",
          meta: {
            requested_chips: 1000,
            withdrawable_chips: 800,
            restricted_bonus_chips: 250,
            active_mission: { id: "mission-race", campaign_id: "race-campaign", campaign_version: 4, status: "ACTIVE", forfeit_allowed: false },
          },
        },
      },
    },
  });
  const { container, root } = await renderPage();
  await submit(container.querySelector('[data-testid="withdrawal-form"]'));

  expect(container.querySelector('[data-testid="withdrawal-balance-explanation"]')).not.toBeNull();
  expect(container.textContent).toContain("800 is currently withdrawable");
  expect(container.textContent).toContain("Campaign race-campaign · version 4");
  expect(container.textContent).toContain("View mission");
  expect(toast.error).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

const OPERATOR_WALLET = {
  wallet: {
    available_chips: 937292,
    cash_chips: 0,
    bonus_chips: 937292,
    held_chips: 0,
    withdrawable_chips: 0,
  },
  money_config: null,
  financial: {
    ready: false,
    features: { real_money: false, deposits: false, withdrawals: false },
    operator: {
      enabled: true,
      rail: "ADMIN_REVIEW",
      deposits_enabled: true,
      withdrawals_enabled: true,
      limits: {
        chips_per_inr: 1,
        min_deposit_paise: 10000,
        max_deposit_paise: 20000000,
        max_daily_deposit_paise: 20000000,
        min_withdrawal_paise: 100000,
        min_withdrawal_chips: 1000,
        max_withdrawal_chips: 1000000,
      },
    },
  },
};

const UPI_OPERATOR_WALLET = {
  ...OPERATOR_WALLET,
  financial: {
    ...OPERATOR_WALLET.financial,
    operator: {
      ...OPERATOR_WALLET.financial.operator,
      rail: "UPI_HOSTED",
      hosted_checkout: true,
      checkout_hosts: ["root.sgpay24.com"],
    },
  },
};

test("hosted UPI operator rail creates an idempotent deposit and opens only SgPay checkout", async () => {
  mockWallet.mockResolvedValue(UPI_OPERATOR_WALLET);
  mockCreateOperatorDeposit.mockResolvedValue({
    checkout_url: "https://root.sgpay24.com/pay/order-1",
    deposit: { id: "upi-deposit-1", status: "PENDING" },
    source: "SGPAY24_UPI",
  });
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });

  expect(publicFinancialConfig(UPI_OPERATOR_WALLET)).toMatchObject({
    operatorCheckoutHosts: ["root.sgpay24.com"],
    checkoutHosts: ["root.sgpay24.com"],
  });
  expect(container.textContent).toContain("Deposit with UPI");
  expect(container.textContent).toContain("SgPay secure UPI checkout");
  expect(container.querySelector('[data-testid="deposit-submit"]').textContent).toContain("Pay securely with UPI");

  change(container.querySelector('[data-testid="deposit-amount"]'), "1000");
  await submit(container.querySelector('[data-testid="deposit-form"]'));

  expect(mockFinancialIntentKey).toHaveBeenCalledWith("deposit", "player-1", "amount_paise=100000");
  expect(mockCreateOperatorDeposit).toHaveBeenCalledWith(100000, "deposit-key");
  expect(mockCreateDeposit).not.toHaveBeenCalled();
  expect(checkoutNavigator).toHaveBeenCalledWith("https://root.sgpay24.com/pay/order-1");
  expect(mockClearFinancialIntent).toHaveBeenCalledWith("deposit", "player-1", "deposit-key");
  expect(mockNavigate).not.toHaveBeenCalledWith("/chips/activity", { replace: true });
  await act(async () => root.unmount());
});

test("hosted UPI operator rail rejects checkout URLs outside the server allowlist", async () => {
  mockWallet.mockResolvedValue(UPI_OPERATOR_WALLET);
  mockCreateOperatorDeposit.mockResolvedValue({ checkout_url: "https://attacker.example/pay/order-1" });
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });

  await submit(container.querySelector('[data-testid="deposit-form"]'));

  expect(mockCreateOperatorDeposit).toHaveBeenCalledWith(100000, "deposit-key");
  expect(checkoutNavigator).not.toHaveBeenCalled();
  expect(mockClearFinancialIntent).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("operator rail unlocks buy and withdraw without hosted checkout", async () => {
  mockWallet.mockResolvedValue(OPERATOR_WALLET);
  mockPathname = "/chips";
  const checkoutNavigator = jest.fn();
  const { container, root } = await renderPage({ checkoutNavigator });

  expect(publicFinancialConfig(OPERATOR_WALLET)).toMatchObject({
    chipsPerInr: 1,
    minDepositPaise: 10000,
    minWithdrawalPaise: 100000,
  });
  expect(container.textContent).toContain("submitted for Admin review");
  expect(container.textContent).toContain("Daily buy limit");
  expect(container.textContent).toMatch(/2,00,000|200,000/);
  expect(container.textContent).not.toContain("Payment services are not active yet");
  expect(container.querySelector('[data-testid="deposit-submit"]').disabled).toBe(false);
  expect(container.querySelector('[data-testid="deposit-submit"]').textContent).toContain("Submit deposit request");

  change(container.querySelector('[data-testid="deposit-amount"]'), "1000");
  await submit(container.querySelector('[data-testid="deposit-form"]'));
  expect(mockCreateDeposit).not.toHaveBeenCalled();
  expect(checkoutNavigator).not.toHaveBeenCalled();
  expect(mockCreateOperatorDeposit).toHaveBeenCalledWith(100000);
  expect(mockNavigate).toHaveBeenCalledWith("/wallet/activity", { replace: true });
  await act(async () => root.unmount());
});

test("operator rail submits withdrawals against available play chips", async () => {
  mockWallet.mockResolvedValue(OPERATOR_WALLET);
  mockPathname = "/chips/withdraw";
  const { container, root } = await renderPage();

  expect(container.querySelector('[data-testid="withdrawal-submit"]').disabled).toBe(false);
  change(container.querySelector('[data-testid="withdrawal-amount"]'), "1000");
  await submit(container.querySelector('[data-testid="withdrawal-form"]'));
  expect(mockCreateWithdrawal).not.toHaveBeenCalled();
  expect(mockCreateOperatorWithdrawal).toHaveBeenCalledWith(1000, "bank-1");
  expect(mockNavigate).toHaveBeenCalledWith("/wallet/activity", { replace: true });
  await act(async () => root.unmount());
});

test("Activity lists play win and loss rows above buy and withdraw history", async () => {
  mockPathname = "/chips/activity";
  mockChipTransactions.mockResolvedValue([
    { id: "play-win-1", kind: "PAYOUT", amount: 80, game: "Roulette", created_at: "2026-09-03T04:10:00Z" },
    { id: "play-loss-1", kind: "STAKE", amount: 50, game: "Roulette", created_at: "2026-09-03T04:09:00Z" },
    { id: "buy-1", kind: "DEPOSIT", amount: 500, created_at: "2026-09-03T03:00:00Z" },
  ]);
  const { container, root } = await renderPage();
  expect(container.querySelector('[data-testid="play-history"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-testid="play-activity-row"]')).toHaveLength(2);
  expect(container.querySelector('[data-testid="play-history-summary"]').textContent).toMatch(/Won 80/);
  expect(container.querySelector('[data-testid="deposit-activity-row"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="withdrawal-activity-row"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("money actions fail closed when the server does not publish limits", async () => {
  mockWallet.mockResolvedValue({
    wallet: READY_WALLET.wallet,
    financial: { ready: true, features: { real_money: true, deposits: true, withdrawals: true } },
  });
  mockBankDetails.mockResolvedValue([]);
  const { container, root } = await renderPage();
  expect(container.textContent).toContain("Payment limits are not yet available");
  expect(container.textContent).toContain("Withdrawal limits are not yet available");
  expect(container.querySelector('[data-testid="deposit-submit"]').disabled).toBe(true);
  expect(container.querySelector('[data-testid="withdrawal-submit"]').disabled).toBe(true);
  expect(container.querySelector('[data-testid="add-bank-account"]')).not.toBeNull();
  await act(async () => root.unmount());
});
