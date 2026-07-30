import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { PlayShell } from "@/components/play/PlayShell";
import { mountRoulette } from "@/pages/play/rouletteVip/engine";
import "@/pages/play/rouletteVip/styles.css";

/**
 * Fun Roulette — the American double-zero table.
 *
 * The visuals, physics, racetrack, statistics and panels live in the engine,
 * which is imperative DOM code mounted into the div below. This component does
 * one job: keep the engine fed with the server's state and forward taps back to
 * the API.
 *
 * Everything that decides an outcome or moves chips is server-side. The round
 * number, the phase, the countdown and the winning pocket come from
 * /games/fun-roulette/state, which derives them from universal epoch time so
 * every player worldwide sees the same spin and the same result. Bets are posted
 * and settled by the backend; the engine's chips are replaced by the server's own
 * record of them on the next poll, so a refused bet simply disappears.
 */
export default function RouletteGame({ game }) {
  const hostRef = useRef(null);
  const engineRef = useRef(null);
  const pollRef = useRef(null);
  const inFlightRef = useRef(0);
  const [fatal, setFatal] = useState(null);

  /** Server (bet_type, value) -> the engine's key, so chips land on the right spot. */
  const toKey = (b) => {
    const t = b.bet_type;
    if (t === "sector") {
      const back = { zeroside: "zeroside", dzeroside: "dzeroside", zeroneighbours: "zerofour" };
      return { sector: back[b.value] || b.value };
    }
    if (["split", "street", "corner", "sixline", "basket"].includes(t)) return `grp:${b.value}`;
    return `${t}:${b.value}`;
  };

  const placeBet = useCallback(async (bet_type, value, amount) => {
    inFlightRef.current += 1;
    try {
      await api.post("/games/fun-roulette/bets", { bet_type, value, amount });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      inFlightRef.current -= 1;
    }
  }, []);

  const undoBet = useCallback(async () => {
    try { await api.post("/games/fun-roulette/bets/undo"); }
    catch (e) { toast.error(errMsg(e)); }
  }, []);

  const clearBets = useCallback(async () => {
    try { await api.post("/games/fun-roulette/bets/clear"); }
    catch (e) { toast.error(errMsg(e)); }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let alive = true;
    let engine;
    try {
      engine = mountRoulette(host, { onPlaceBet: placeBet, onUndo: undoBet, onClear: clearBets });
      engineRef.current = engine;
    } catch (e) {
      setFatal(String(e && e.message ? e.message : e));
      return undefined;
    }

    const tick = async () => {
      if (!alive) return;
      try {
        const { data } = await api.get("/games/fun-roulette/state");
        if (!alive) return;
        engine.applyState({
          phase: data.phase,
          roundNumber: data.round_number,
          secondsLeft: data.phase_ends_in,
          winningNumber: data.winning_number,
          // a bet still in flight would be missing from the server's list and the
          // chip would flicker off the felt, so hold the optimistic view until it lands
          myBets: inFlightRef.current === 0 ? (data.my_bets || []).map((b) => ({ key: toKey(b), amount: b.amount })) : null,
          balance: inFlightRef.current === 0 ? data.balance : null,
          settled: data.settled,
        });
        if (Array.isArray(data.last_results)) {
          engine.setHistory(data.last_results.map((r) => r.winning_number));
        }
      } catch (e) {
        /* a dropped poll is not fatal: the next one re-syncs */
      }
    };

    tick();
    pollRef.current = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(pollRef.current);
      try { engine && engine.destroy(); } catch (e) { /* already gone */ }
      engineRef.current = null;
    };
  }, [placeBet, undoBet, clearBets]);

  return (
    <PlayShell game={game} title="Fun Roulette">
      {fatal ? (
        <div className="p-6 text-center text-sm text-white/70" data-testid="roulette-error">
          The table could not be loaded. {fatal}
        </div>
      ) : null}
      <div ref={hostRef} data-testid="roulette-table" />
    </PlayShell>
  );
}
