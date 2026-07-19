import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { sfx } from "@/lib/sound";

/**
 * Universal live-round client. Polls /live/{slug}/state so every player sees
 * the SAME 24/7 synchronized round, phase, countdown and outcome.
 * `revealSound` (optional): sfx key played when the reveal phase starts
 * ("dice" | "reel" | "deal" | "spin" | "draw").
 */
export function useLiveRound(slug, { pollMs = 1500, formatResult, revealSound } = {}) {
  const [state, setState] = useState(null);
  const [balance, setBalance] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const deadlineRef = useRef(0);
  const phaseKeyRef = useRef("");
  const boundaryPollRef = useRef("");
  const monoRef = useRef({ key: "", val: 0 });
  const settledShownRef = useRef(null);
  const prevPhaseRef = useRef(null);
  const formatRef = useRef(formatResult);
  formatRef.current = formatResult;
  const revealSoundRef = useRef(revealSound);
  revealSoundRef.current = revealSound;

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
      /* Anchor the phase deadline ONCE per (round, phase). Re-anchoring on every
         poll made the countdown jitter with network latency, which rewound the
         card-dealing timelines mid-animation (cards un-dealt / re-flipped =
         the flicker bug). Only resync on real drift (tab slept, clock skew). */
      const phaseKey = `${data.round_number}:${data.phase}`;
      const newDeadline = Date.now() + data.phase_ends_in * 1000;
      if (phaseKeyRef.current !== phaseKey) {
        phaseKeyRef.current = phaseKey;
        deadlineRef.current = newDeadline;
      } else if (Math.abs(newDeadline - deadlineRef.current) > 450) {
        deadlineRef.current = newDeadline;
      }
      // A new reveal is starting - clear the previous round's banner + play the reveal sound
      if (data.phase === "REVEAL") {
        setResult((r) => (r && r.key === `r-${data.round_number}` ? r : null));
        if (prevPhaseRef.current !== "REVEAL" && revealSoundRef.current && sfx[revealSoundRef.current]) {
          sfx[revealSoundRef.current]();
        }
      }
      prevPhaseRef.current = data.phase;
      if (data.settled && settledShownRef.current !== data.settled.round_number) {
        settledShownRef.current = data.settled.round_number;
        const s = data.settled;
        const base = {
          key: `r-${s.round_number}`,
          win: s.payout > 0,
          big: s.payout > 0 && s.payout >= s.total_bet * 5,
          payout: s.payout,
          title: s.payout > 0 ? "You won!" : "Not this time",
        };
        const extra = formatRef.current ? formatRef.current(s) : {};
        const merged = { ...base, ...extra };
        setResult(merged);
        if (merged.push) sfx.push();
        else if (merged.win) (s.payout >= s.total_bet * 5 ? sfx.bigWinCelebration : sfx.winCelebration)();
        else {
          sfx.lose();
          sfx.aww();
        }
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
      /* Fire ONE instant poll right at the phase boundary so the next phase
         (e.g. REVEAL) starts on time instead of up to a full poll-interval
         late - keeps the dealing choreography tight. */
      if (
        deadlineRef.current > 0 &&
        Date.now() >= deadlineRef.current &&
        boundaryPollRef.current !== phaseKeyRef.current
      ) {
        boundaryPollRef.current = phaseKeyRef.current;
        poll();
      }
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
        sfx.chip();
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
  /* Monotonic reveal clock: within one round's REVEAL phase this value can
     only move forward, so deal/flip animations can never un-trigger even if
     the countdown gets a small network-latency correction. Read the deadline
     ref directly (it is anchored synchronously when the phase flips) so the
     first REVEAL render never sees a stale betting-phase countdown. */
  const liveCd = deadlineRef.current > 0 ? Math.max(0, (deadlineRef.current - Date.now()) / 1000) : 0;
  const rawElapsed = phase === "RESULT" ? 999 : phase === "REVEAL" ? Math.max(0, revealSecs - liveCd) : 0;
  const monoKey = `${state?.round_number ?? "-"}:${phase ?? "-"}`;
  if (monoRef.current.key !== monoKey) {
    monoRef.current = { key: monoKey, val: rawElapsed };
  } else if (rawElapsed > monoRef.current.val) {
    monoRef.current.val = rawElapsed;
  }
  const revealElapsed = monoRef.current.val;
  const revealProgress =
    phase === "RESULT" ? 1 : phase === "REVEAL" ? Math.min(1, Math.max(0, revealElapsed / revealSecs)) : 0;

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
    revealElapsed,
  };
}
