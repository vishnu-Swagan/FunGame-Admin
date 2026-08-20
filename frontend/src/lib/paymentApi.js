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
};

export const adminPayments = {
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
