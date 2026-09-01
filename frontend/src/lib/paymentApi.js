import { financialApi, financialPost } from "@/lib/api";

// Kept in one module so a future provider adapter never leaks into React pages.
const PLAYER_ROOT = "/payments";
const ADMIN_ROOT = "/admin/payments";

export const responseRows = (data, key, aliases = []) => data?.[key] || aliases.map((alias) => data?.[alias]).find(Array.isArray) || data?.items || [];

export const payments = {
  async wallet() {
    const { data } = await financialApi.get(`${PLAYER_ROOT}/wallet`);
    return data;
  },
  async deposits() {
    const { data } = await financialApi.get(`${PLAYER_ROOT}/deposits`);
    return responseRows(data, "deposits");
  },
  async deposit(id) {
    const { data } = await financialApi.get(`${PLAYER_ROOT}/deposits/${encodeURIComponent(id)}`);
    return data?.deposit || data;
  },
  async refreshDeposit(id) {
    const { data } = await financialApi.post(
      `${PLAYER_ROOT}/deposits/${encodeURIComponent(id)}/refresh`,
      {},
      { __noFailover: true },
    );
    return data?.deposit || data;
  },
  async submitDepositUtr(id, utr) {
    const { data } = await financialApi.post(
      `${PLAYER_ROOT}/deposits/${encodeURIComponent(id)}/utr`,
      { utr },
      { __noFailover: true },
    );
    return data?.deposit || data;
  },
  async createDeposit(amountPaise, idempotencyKey) {
    const { data } = await financialPost(
      `${PLAYER_ROOT}/deposits`,
      { amount_paise: amountPaise },
      { idempotencyKey },
    );
    return data;
  },
  async bankDetails() {
    const { data } = await financialApi.get(`${PLAYER_ROOT}/bank-details`);
    return responseRows(data, "bank_details");
  },
  async bankDetail() {
    const { data } = await financialApi.get(`${PLAYER_ROOT}/bank-details`);
    const rows = responseRows(data, "bank_details");
    return rows[0] || null;
  },
  async saveBankDetail(body) {
    const { data } = await financialApi.post(`${PLAYER_ROOT}/bank-details`, body, { __noFailover: true });
    return data?.bank_detail || data;
  },
  async removeBankDetail(id) {
    const { data } = await financialApi.delete(`${PLAYER_ROOT}/bank-details/${encodeURIComponent(id)}`, { __noFailover: true });
    return data;
  },
  async withdrawals() {
    const { data } = await financialApi.get(`${PLAYER_ROOT}/withdrawals`);
    return responseRows(data, "withdrawals");
  },
  async createWithdrawal(amountChips, bankDetailId, idempotencyKey) {
    const { data } = await financialPost(`${PLAYER_ROOT}/withdrawals`, {
      amount_chips: amountChips,
      bank_detail_id: bankDetailId,
    }, { idempotencyKey });
    return data;
  },
  async createOperatorDeposit(amountPaise, idempotencyKey, note) {
    const { data } = await financialPost(`${PLAYER_ROOT}/operator/deposits`, {
      amount_paise: amountPaise,
      note: note || null,
    }, { idempotencyKey });
    return data;
  },
  async createOperatorWithdrawal(amountChips, bankDetailId, note) {
    const { data } = await financialApi.post(`${PLAYER_ROOT}/operator/withdrawals`, {
      amount_chips: amountChips,
      bank_detail_id: bankDetailId,
      note: note || null,
    }, { __noFailover: true });
    return data;
  },
};

export const adminPayments = {
  async hubStatus() {
    const { data } = await financialApi.get("/admin/payment-hub/status");
    return data?.data || data;
  },
  async gateways() {
    const { data } = await financialApi.get("/admin/payment-gateways");
    return data?.data?.items || [];
  },
  async createGateway(body) {
    const { data } = await financialApi.post("/admin/payment-gateways", body, { __noFailover: true });
    return data?.data?.gateway || data?.gateway || data;
  },
  async updateGateway(id, body) {
    const { data } = await financialApi.patch(`/admin/payment-gateways/${encodeURIComponent(id)}`, body, { __noFailover: true });
    return data?.data?.gateway || data?.gateway || data;
  },
  async paymentGatewaySettings() {
    const { data } = await financialApi.get("/admin/payment-gateway-settings");
    return data?.data?.settings || data?.settings || data;
  },
  async savePaymentGatewaySettings(body) {
    const { data } = await financialApi.patch("/admin/payment-gateway-settings", body, { __noFailover: true });
    return data?.data?.settings || data?.settings || data;
  },
  async localAgents() {
    const { data } = await financialApi.get("/admin/payment-local-agents");
    return data?.data?.items || [];
  },
  async createLocalAgent(body) {
    const { data } = await financialApi.post("/admin/payment-local-agents", body, { __noFailover: true });
    return data?.data?.agent || data?.agent || data;
  },
  async deleteLocalAgent(id) {
    const { data } = await financialApi.delete(`/admin/payment-local-agents/${encodeURIComponent(id)}`, { __noFailover: true });
    return data?.data || data;
  },
  async writeGatewayCredentials(id, credentials) {
    const { data } = await financialApi.post(`/admin/payment-gateways/${encodeURIComponent(id)}/credentials`, { credentials }, { __noFailover: true });
    return data?.data || data;
  },
  async testGateway(id) {
    const { data } = await financialApi.post(`/admin/payment-gateways/${encodeURIComponent(id)}/test`, {}, { __noFailover: true });
    return data?.data || data;
  },
  async requestGatewayActivation(id, reason) {
    const { data } = await financialApi.post(`/admin/payment-gateways/${encodeURIComponent(id)}/request-activation`, { reason }, { __noFailover: true });
    return data?.data?.approval || data;
  },
  async approveGatewayActivation(id, approvalId) {
    const { data } = await financialApi.post(`/admin/payment-gateways/${encodeURIComponent(id)}/approve-activation`, { approval_id: approvalId }, { __noFailover: true });
    return data?.data?.gateway || data;
  },
  async disableGateway(id, reason) {
    const { data } = await financialApi.post(`/admin/payment-gateways/${encodeURIComponent(id)}/disable`, { reason }, { __noFailover: true });
    return data?.data?.gateway || data;
  },
  async routes() {
    const { data } = await financialApi.get("/admin/payment-routes");
    return data?.data?.items || [];
  },
  async createRoute(body) {
    const { data } = await financialApi.post("/admin/payment-routes", body, { __noFailover: true });
    return data?.data?.route || data;
  },
  async requestRouteActivation(id, reason) {
    const { data } = await financialApi.post(`/admin/payment-routes/${encodeURIComponent(id)}/request-activation`, { reason }, { __noFailover: true });
    return data?.data?.approval || data;
  },
  async approveRouteActivation(id, approvalId) {
    const { data } = await financialApi.post(`/admin/payment-routes/${encodeURIComponent(id)}/approve-activation`, { approval_id: approvalId }, { __noFailover: true });
    return data?.data?.route || data;
  },
  async paymentApprovals(status = "PENDING") {
    const { data } = await financialApi.get("/admin/payment-approvals", { params: { status } });
    return data?.data?.items || [];
  },
  async simulateRoute(body) {
    const { data } = await financialApi.post("/admin/payment-routes/simulate", body, { __noFailover: true });
    return data?.data?.decision || data;
  },
  async hubWebhookEvents() {
    const { data } = await financialApi.get("/admin/webhook-events");
    return data?.data?.items || [];
  },
  async hubActivity() {
    const { data } = await financialApi.get("/admin/activity");
    return data?.data?.items || [];
  },
  async kyc(status) {
    const { data } = await financialApi.get(`${ADMIN_ROOT}/kyc`, { params: status ? { status } : {} });
    return responseRows(data, "players");
  },
  async reviewKyc(userId, status, reason) {
    const { data } = await financialApi.patch(`${ADMIN_ROOT}/kyc/${encodeURIComponent(userId)}`, { status, reason }, { __noFailover: true });
    return data;
  },
  async deposits(params = {}) {
    const { data } = await financialApi.get(`${ADMIN_ROOT}/deposits`, { params });
    return responseRows(data, "deposits");
  },
  async withdrawals(params = {}) {
    const { data } = await financialApi.get(`${ADMIN_ROOT}/withdrawals`, { params });
    return responseRows(data, "withdrawals");
  },
  async events(params = {}) {
    const { data } = await financialApi.get(`${ADMIN_ROOT}/events`, { params });
    return responseRows(data, "events");
  },
  async ledger(params = {}) {
    const { data } = await financialApi.get(`${ADMIN_ROOT}/ledger`, { params });
    return responseRows(data, "entries");
  },
  async audit(params = {}) {
    const { data } = await financialApi.get(`${ADMIN_ROOT}/audit`, { params });
    return responseRows(data, "audit", ["events"]);
  },
  async settings() {
    const { data } = await financialApi.get(`${ADMIN_ROOT}/settings`);
    return data?.settings ? { ...data.settings, financial: data.financial } : data;
  },
  async setWithdrawalMode(mode, reason) {
    const { data } = await financialApi.patch(`${ADMIN_ROOT}/settings/withdrawal-mode`, {
      mode,
      reason,
    }, { __noFailover: true });
    return data;
  },
  async withdrawalAction(id, action, body = {}) {
    const { data } = await financialApi.post(`/admin/withdrawals/${encodeURIComponent(id)}/${action}`, body, { __noFailover: true });
    return data;
  },
  async resolveOperatorRequest(id, action, body = {}) {
    const { data } = await financialApi.post(
      `${ADMIN_ROOT}/operator-requests/${encodeURIComponent(id)}/${action}`,
      body,
      { __noFailover: true },
    );
    return data;
  },
  async reconcileEvent(id) {
    const { data } = await financialApi.post(`${ADMIN_ROOT}/events/${encodeURIComponent(id)}/reconcile`, {}, { __noFailover: true });
    return data;
  },
  async reconcileAll(limit = 50) {
    const { data } = await financialApi.post(`${ADMIN_ROOT}/reconcile`, {}, {
      __noFailover: true,
      params: { limit },
    });
    return data;
  },
};
