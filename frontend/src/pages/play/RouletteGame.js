import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { mountRoulette } from "@/pages/play/rouletteVip/engine";
import { isMuted, setMuted, onMuteChange } from "@/lib/sound";
import "@/pages/play/rouletteVip/styles.css";

/**
 * American Roulette — the synchronized double-zero table.
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
  const navigate = useNavigate();
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

  const placeBet = useCallback(async (bet_type, value, amount, key) => {
    inFlightRef.current += 1;
    try {
      await api.post("/games/fun-roulette/bets", { bet_type, value, amount });
    } catch (e) {
      /* Hand the reason back to the table. A refused stake used to leave its
         optimistic chip sitting on the felt until the next poll quietly removed
         it, which reads as the game losing the bet rather than declining it. */
      const msg = errMsg(e);
      if (engineRef.current) engineRef.current.rejectBet(key, amount, msg);
      toast.error(msg);
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
      engine = mountRoulette(host, {
        onPlaceBet: placeBet,
        onUndo: undoBet,
        onClear: clearBets,
        /* One mute, two buttons. The table has its own in the rail and the shell
           has one in the header; before this they were separate flags, so
           silencing from one left the other playing. The shell owns the answer —
           the table starts from it, reports its own presses into it, and is told
           when it changes elsewhere. */
        soundOn: !isMuted(),
        onSoundChange: (on) => setMuted(!on),
        onExit: () => navigate(`/games/${game.slug}`),
      });
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
          timing: {
            bettingSeconds: data.betting_seconds,
            spinSeconds: data.spin_seconds,
            resultSeconds: Math.max(0, data.round_seconds - data.betting_seconds - data.spin_seconds),
          },
          limits: data.limits,
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
  }, [placeBet, undoBet, clearBets, navigate, game.slug]);

  /* The other half of the shared mute: a press on the header's button has to
     reach the table, not just the app's own effects. */
  useEffect(() => onMuteChange((m) => {
    if (engineRef.current && engineRef.current.setSound) engineRef.current.setSound(!m);
  }), []);

  /* The table is authored against a 430-wide phone and none of its metrics are
     fluid, so on anything narrower it collides rather than compressing. Laying it
     out at its design width and scaling the box down to the room that exists
     keeps it the same table on every handset. The stylesheet does the scaling;
     this only has to tell it how much room there is.

     Document-relative top, not the viewport rect, so a scrolled page cannot make
     the table think it has less height than it has. */
  useLayoutEffect(() => {
    const DESIGN_W = 430;
    const fit = () => {
      const el = hostRef.current;
      if (!el) return;
      if (!window.matchMedia("(orientation: portrait)").matches) {
        el.removeAttribute("data-fit");
        el.style.height = "";
        return;
      }
      const w = el.clientWidth;
      if (!w) return;
      const docTop = el.getBoundingClientRect().top + window.scrollY;
      const h = Math.max(360, Math.round(window.innerHeight - docTop - 8));
      const s = Math.min(1, w / DESIGN_W);
      el.style.height = `${h}px`;
      el.style.setProperty("--fit-s", String(s));
      el.style.setProperty("--fit-w", `${w / s}px`);
      el.style.setProperty("--fit-h", `${h / s}px`);
      el.setAttribute("data-fit", "");
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (hostRef.current) {
      ro.observe(hostRef.current);
      /* The chrome above the table settles after this runs — the live activity
         bar arrives with its first poll and pushes the table down — so the
         parent is watched too, otherwise the table keeps the height it was
         given before the bar existed and overhangs the bottom of the screen. */
      if (hostRef.current.parentElement) ro.observe(hostRef.current.parentElement);
    }
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, []);

  return (
    <div className="roulette-fullscreen" data-testid="game-play-page">
      {fatal ? (
        <div className="p-6 text-center text-sm text-white/70" data-testid="roulette-error">
          The table could not be loaded. {fatal}
        </div>
      ) : null}
      <div ref={hostRef} data-testid="roulette-table" />
    </div>
  );
}
