import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";

/**
 * Universal live-round client. Polls /live/{slug}/state so every player sees
 * the SAME 24/7 synchronized round, phase, countdown and outcome.
 */
export function useLiveRound(slug, { pollMs = 1500, formatResult } = {}) {
  const [state, setState] = useState(null);
  const [balance, setBalance] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const deadlineRef = useRef(0);
  const settledShownRef = useRef(null);
  const formatRef = useRef(formatResult);
  formatRef.current = formatResult;

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get(`/games/${slug}/history`);
      setHistory(data.rounds || []);
    } catch (e) {
      /* silent */
    }
  }, [slug]);

  const applyState = useCallback(
    (data) => {
      setState(data);
      setBalance(data.balance);
      deadlineRef.current = Date.now() + data.phase_ends_in * 1000;
      // A new reveal is starting - clear the previous round's banner
      if (data.phase === "REVEAL") {
        setResult((r) => (r && r.key === `r-${data.round_number}` ? r : null));
      }
      if (data.settled && settledShownRef.current !== data.settled.round_number) {
        settledShownRef.current = data.settled.round_number;
        const s = data.settled;
        const base = {
          key: `r-${s.round_number}`,
          win: s.payout > 0,
          payout: s.payout,
          title: s.payout > 0 ? "You won!" : "Not this time",
        };
        const extra = formatRef.current ? formatRef.current(s) : {};
        setResult({ ...base, ...extra });
        loadHistory();
      }
    },
    [loadHistory]
  );

  const poll = useCallback(async () => {
    try {
      const { data } = await api.get(`/live/${slug}/state`);
      applyState(data);
    } catch (e) {
      /* transient */
    }
  }, [slug, applyState]);

  useEffect(() => {
    poll();
    loadHistory();
    const p = setInterval(poll, pollMs);
    const t = setInterval(() => {
      setCountdown(Math.max(0, (deadlineRef.current - Date.now()) / 1000));
    }, 100);
    return () => {
      clearInterval(p);
      clearInterval(t);
    };
  }, [poll, loadHistory, pollMs]);

  const placeBet = useCallback(
    async (selection, amount) => {
      if (placing) return null;
      setPlacing(true);
      try {
        const { data } = await api.post(`/live/${slug}/bets`, { selection, amount });
        setBalance(data.balance);
        setState((s) => (s ? { ...s, my_bets: data.my_bets, my_total: data.my_total } : s));
        return data;
      } catch (e) {
        toast.error(errMsg(e));
        return null;
      } finally {
        setPlacing(false);
      }
    },
    [slug, placing]
  );

  const clearBets = useCallback(async () => {
    try {
      const { data } = await api.post(`/live/${slug}/bets/clear`);
      setBalance(data.balance);
      setState((s) => (s ? { ...s, my_bets: [], my_total: 0 } : s));
      if (data.refunded > 0) toast.success(`Refunded ${data.refunded} chips`);
      return data;
    } catch (e) {
      toast.error(errMsg(e));
      return null;
    }
  }, [slug]);

  const phase = state?.phase;
  const revealSecs = state?.timings?.reveal || 4;
  const revealProgress =
    phase === "RESULT" ? 1 : phase === "REVEAL" ? Math.min(1, Math.max(0, (revealSecs - countdown) / revealSecs)) : 0;

  return {
    state,
    countdown,
    balance,
    placing,
    result,
    setResult,
    history,
    loadHistory,
    placeBet,
    clearBets,
    phase,
    betting: phase === "BETTING",
    outcome: state?.outcome ?? null,
    myBets: state?.my_bets || [],
    myTotal: state?.my_total || 0,
    lastResults: state?.last_results || [],
    revealProgress,
  };
}
