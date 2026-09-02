import { financialApi } from "@/lib/api";

export const promoApi = {
  async state() {
    const { data } = await financialApi.get("/promo/state");
    return data;
  },
  async claimFreeCash() {
    const { data } = await financialApi.post("/promo/free-cash/claim", {});
    return data;
  },
};
