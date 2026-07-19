import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";

export function useGamePlay(slug) {
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get(`/games/${slug}/history`);
      setHistory(data.rounds || []);
    } catch (e) {
      // silent
    }
  }, [slug]);

  useEffect(() => {
    loadHistory();
    api.get("/chips/balance").then(({ data }) => setBalance(data.balance)).catch(() => {});
  }, [loadHistory]);

  const play = useCallback(
    async (bet, payload = {}) => {
      setBusy(true);
      try {
        const { data } = await api.post(`/games/${slug}/play`, { bet, payload });
        if (typeof data.balance === "number") setBalance(data.balance);
        return data;
      } catch (e) {
        toast.error(errMsg(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [slug]
  );

  return { balance, setBalance, busy, setBusy, play, history, loadHistory };
}
