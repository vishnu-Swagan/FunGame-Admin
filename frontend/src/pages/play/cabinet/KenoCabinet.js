import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown, CircleHelp, Coins, History, Menu, Minus, Play, Plus,
  Music2, RefreshCw, Volume2, VolumeX, X,
} from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { isMuted, kenoMusic, onMuteChange, sfx, toggleMuted } from "@/lib/sound";
import { CLIENT_BETTING_GUARD_SECONDS } from "@/lib/serverClock";
import { formatRoundClock, kenoPayoutLabel } from "./kenoResult";
import "./keno.css";

const NUMBERS = Array.from({ length: 36 }, (_, index) => index + 1);
const AUTO_ROUNDS = [3, 10, 25, 100, 200, 500];
const PRESETS = [10, 20, 50, 100, 200, 500, 1000];
const KENO_ROUND_TIMING = { bet: 30, reveal: 20, result: 10, total: 60 };

// Transparent return multipliers mirrored by the server. The 10-pick column
// matches the reference cabinet's exact 0.00x-to-100.00x win ladder.
const KENO_PAYTABLE = {
  1: { 1: 2.51 },
  2: { 1: 1.08, 2: 3.54 },
  3: { 1: 0.72, 2: 1.66, 3: 5.9 },
  4: { 1: 0.36, 2: 1.31, 3: 3.02, 4: 15.12 },
  5: { 1: 0, 2: 0.79, 3: 2.7, 4: 10.8, 5: 25.2 },
  6: { 1: 0, 2: 0.36, 3: 2.09, 4: 5.47, 5: 12.96, 6: 39.6 },
  7: { 1: 0, 2: 0.18, 3: 1.66, 4: 2.95, 5: 7.2, 6: 22.32, 7: 43.2 },
  8: { 1: 0, 2: 0, 3: 1.01, 4: 2.02, 5: 8.21, 6: 20.16, 7: 28.8, 8: 50.4 },
  9: { 1: 0, 2: 0, 3: 0.72, 4: 1.58, 5: 4.39, 6: 12.24, 7: 18, 8: 39.6, 9: 61.2 },
  10: { 1: 0, 2: 0, 3: 1, 4: 1.5, 5: 3.3, 6: 10.2, 7: 25, 8: 40, 9: 75, 10: 100 },
};

const money = (value) => new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

function shuffledDraw() {
  const pool = [...NUMBERS];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, 10);
}

function useDemoKeno() {
  const [phase, setPhase] = useState("BETTING");
  const [roundNumber, setRoundNumber] = useState(2418);
  const [balance, setBalance] = useState(10000);
  const [outcome, setOutcome] = useState(null);
  const [myBets, setMyBets] = useState([]);
  const [result, setResult] = useState(null);
  const [revealProgress, setRevealProgress] = useState(0);
  const [lastResults, setLastResults] = useState([]);
  const [countdown, setCountdown] = useState(KENO_ROUND_TIMING.bet);
  const betRef = useRef(null);

  const placeBet = useCallback(async (selection, amount) => {
    if (phase !== "BETTING" || betRef.current || amount > balance) return null;
    const bet = { id: `demo-${Date.now()}`, selection: [...selection], amount };
    betRef.current = bet;
    setBalance((value) => value - amount);
    setMyBets([bet]);
    setResult(null);
    sfx.chip();
    return { balance: balance - amount, my_bets: [bet], my_total: amount };
  }, [balance, phase]);

  const clearBets = useCallback(async () => {
    if (phase !== "BETTING" || !betRef.current) return null;
    const refund = betRef.current.amount;
    betRef.current = null;
    setBalance((value) => value + refund);
    setMyBets([]);
    return { refunded: refund };
  }, [phase]);

  const bettingOpenNow = useCallback((guardSeconds = 0) => (
    phase === "BETTING" && countdown >= Math.max(0, Number(guardSeconds) || 0)
  ), [countdown, phase]);

  useEffect(() => {
    if (phase !== "BETTING") return undefined;
    const started = performance.now();
    setCountdown(KENO_ROUND_TIMING.bet);
    const interval = window.setInterval(() => {
      setCountdown(Math.max(0, KENO_ROUND_TIMING.bet - (performance.now() - started) / 1000));
    }, 100);
    const close = window.setTimeout(() => {
      setCountdown(0);
      setOutcome({ drawn: shuffledDraw() });
      setRevealProgress(0);
      setPhase("REVEAL");
    }, KENO_ROUND_TIMING.bet * 1000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(close);
    };
  }, [phase, roundNumber]);

  useEffect(() => {
    if (phase !== "REVEAL") return undefined;
    const started = performance.now();
    const revealMs = KENO_ROUND_TIMING.reveal * 1000;
    setCountdown(KENO_ROUND_TIMING.reveal);
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - started;
      setRevealProgress(Math.min(1, elapsed / revealMs));
      setCountdown(Math.max(0, KENO_ROUND_TIMING.reveal - elapsed / 1000));
    }, 100);
    const finish = window.setTimeout(() => {
      const bet = betRef.current;
      if (!outcome) return;
      setRevealProgress(1);
      setLastResults((rows) => [{ round_number: roundNumber, drawn: outcome.drawn }, ...rows].slice(0, 10));
      if (bet) {
        const matches = bet.selection.filter((number) => outcome.drawn.includes(number)).sort((a, b) => a - b);
        const mult = KENO_PAYTABLE[bet.selection.length]?.[matches.length] || 0;
        const payout = Math.round(bet.amount * mult * 100) / 100;
        const netWin = payout > bet.amount;
        setBalance((value) => value + payout);
        setResult({
          key: `demo-${roundNumber}`,
          payout,
          total_bet: bet.amount,
          win: netWin,
          bets: [{ ...bet, matches, multiplier: mult, payout }],
        });
        if (netWin) sfx.winCelebration();
        else sfx.lose();
      }
      setCountdown(0);
      setPhase("RESULT");
    }, revealMs);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(finish);
    };
  }, [outcome, phase, roundNumber]);

  useEffect(() => {
    if (phase !== "RESULT") return undefined;
    const started = performance.now();
    setCountdown(KENO_ROUND_TIMING.result);
    const interval = window.setInterval(() => {
      setCountdown(Math.max(0, KENO_ROUND_TIMING.result - (performance.now() - started) / 1000));
    }, 100);
    const timer = window.setTimeout(() => {
      betRef.current = null;
      setMyBets([]);
      setOutcome(null);
      setResult(null);
      setRevealProgress(0);
      setRoundNumber((value) => value + 1);
      setPhase("BETTING");
    }, KENO_ROUND_TIMING.result * 1000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timer);
    };
  }, [phase]);

  const state = useMemo(() => ({
    round_number: roundNumber,
    phase,
    min_bet: 10,
    max_bet: 1000,
    timings: KENO_ROUND_TIMING,
    game_config: { pool: 36, draw_count: 10, max_picks: 10, paytable: KENO_PAYTABLE },
  }), [phase, roundNumber]);

  return {
    state,
    countdown,
    balance,
    placing: false,
    result,
    phase,
    betting: phase === "BETTING",
    outcome,
    myBets,
    myTotal: myBets.reduce((sum, bet) => sum + bet.amount, 0),
    lastResults,
    revealProgress,
    placeBet,
    clearBets,
    bettingOpenNow,
  };
}

function useSoundState() {
  const [muted, setMuted] = useState(isMuted());
  useEffect(() => onMuteChange(setMuted), []);
  return muted;
}

function Paytable({ picks, table, hits, active }) {
  const rows = picks > 0 ? Array.from({ length: picks }, (_, index) => picks - index) : [];
  const maxValue = Math.max(1, ...Object.values(table || {}).map(Number));
  return (
    <aside className="keno-paytable" aria-label="Payout table" data-testid="keno-paytable">
      <div className="keno-paytable-head" aria-hidden="true"><span>HITS</span><span>PAYOUT</span></div>
      {picks === 0 ? (
        <div className="keno-paytable-empty"><b>1–10</b><span>SELECT NUMBERS</span></div>
      ) : rows.map((count) => {
        const value = Number(table?.[count] || 0);
        const tier = value > 0 ? Math.max(.08, Math.log10(value + 1) / Math.log10(maxValue + 1)) : 0;
        const winning = active && count === hits;
        return (
          <div
            key={count}
            className={`keno-payrow ${winning ? "is-active" : ""} ${count === picks ? "is-peak" : ""}`}
            style={{ "--payout-tier": tier }}
            aria-current={winning ? "true" : undefined}
          >
            <span>{count}</span>
            <b><strong>{value.toFixed(2)}</strong><em>x</em></b>
          </div>
        );
      })}
    </aside>
  );
}

function NumberBall({ number, picked, drawn, drawing, latest, onClick, disabled }) {
  const hit = picked && drawn;
  const className = [
    "keno-number",
    picked && !drawing ? "is-picked" : "",
    drawing && picked && !drawn ? "is-missed" : "",
    drawn && !picked ? "is-drawn" : "",
    hit ? "is-hit" : "",
    latest ? "is-latest" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      data-testid={`keno-number-${number}`}
      aria-pressed={picked}
    >
      <span>{number}</span>
    </button>
  );
}

function Modal({ title, children, onClose, className = "" }) {
  return (
    <div className="keno-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`keno-modal ${className}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="Close"><X /></button></header>
        {children}
      </section>
    </div>
  );
}

function KenoTable({ game, live, demo = false }) {
  const navigate = useNavigate();
  const muted = useSoundState();
  const {
    state, countdown, balance, placing, result, phase, betting: phaseBetting, outcome,
    myBets, myTotal, lastResults, revealProgress, placeBet, clearBets, bettingOpenNow,
  } = live;
  const betting = phaseBetting && countdown >= CLIENT_BETTING_GUARD_SECONDS;
  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 1000;
  const configPaytable = state?.game_config?.paytable || KENO_PAYTABLE;
  const [picks, setPicks] = useState([]);
  const [amount, setAmount] = useState("10.00");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoChoice, setAutoChoice] = useState(3);
  const [autoRemaining, setAutoRemaining] = useState(0);
  const [stopLoss, setStopLoss] = useState(0);
  const [stopWin, setStopWin] = useState(0);
  const [musicOn, setMusicOn] = useState(false);
  const autoStartBalance = useRef(null);
  const autoRoundRef = useRef(null);
  const shownRef = useRef(0);
  const matchesRef = useRef(0);

  const toggleKenoMusic = useCallback(async () => {
    if (musicOn) {
      kenoMusic.stop();
      setMusicOn(false);
      return;
    }
    // This handler is the required user gesture. It both unlocks Web Audio on
    // iOS/Android and keeps us inside browser autoplay rules.
    if (isMuted()) toggleMuted();
    setMusicOn(await kenoMusic.start());
  }, [musicOn]);

  useEffect(() => () => kenoMusic.stop(), []);
  useEffect(() => onMuteChange((nextMuted) => {
    if (!nextMuted) return;
    kenoMusic.stop();
    setMusicOn(false);
  }), []);
  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.visibilityState !== "hidden") return;
      kenoMusic.stop();
      setMusicOn(false);
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => document.removeEventListener("visibilitychange", stopWhenHidden);
  }, []);

  useEffect(() => {
    setAmount((value) => Math.min(maxBet, Math.max(minBet, Number(value) || minBet)).toFixed(2));
  }, [maxBet, minBet]);

  const lockedBet = myBets[0] || null;
  const locked = !!lockedBet;
  const activePicks = locked ? (lockedBet.selection || []) : picks;
  const pickCount = activePicks.length;
  const table = configPaytable?.[pickCount] || configPaytable?.[String(pickCount)] || KENO_PAYTABLE[pickCount] || {};
  const allDrawn = outcome?.drawn || [];
  const shownCount = phase === "RESULT" ? allDrawn.length : phase === "REVEAL" ? Math.min(allDrawn.length, Math.floor(revealProgress * allDrawn.length)) : 0;
  const shown = allDrawn.slice(0, shownCount);
  const shownSet = useMemo(() => new Set(shown), [shown]);
  const hits = activePicks.filter((number) => shownSet.has(number)).length;
  const drawing = phase === "REVEAL" || phase === "RESULT";
  const latest = shown[shown.length - 1];
  const betAmount = lockedBet?.amount || amount;
  const computedPayout = Math.round(betAmount * Number(table[hits] || 0) * 100) / 100;
  const payout = result?.payout ?? state?.settled?.payout ?? (phase === "RESULT" && locked ? computedPayout : 0);
  const roundCountdown = Math.max(0,
    countdown
    + (phase === "BETTING" ? Number(state?.timings?.reveal || 0) + Number(state?.timings?.result || 0) : 0)
    + (phase === "REVEAL" ? Number(state?.timings?.result || 0) : 0));

  useEffect(() => {
    if (phase !== "REVEAL") {
      shownRef.current = 0;
      matchesRef.current = 0;
      return;
    }
    if (shownCount > shownRef.current) {
      if (hits > matchesRef.current) sfx.slotBell();
      else sfx.chip();
    }
    shownRef.current = shownCount;
    matchesRef.current = hits;
  }, [hits, phase, shownCount]);

  const togglePick = (number) => {
    if (!betting || locked || placing) return;
    setPicks((values) => values.includes(number)
      ? values.filter((value) => value !== number)
      : values.length < 10 ? [...values, number].sort((a, b) => a - b) : values);
    sfx.chip();
  };

  const randomize = () => {
    if (!betting || locked || placing) return;
    const count = picks.length || 10;
    setPicks(shuffledDraw().slice(0, count).sort((a, b) => a - b));
    sfx.chip();
  };

  const adjustAmount = (delta) => {
    setAmount((value) => Math.min(maxBet, Math.max(minBet, Math.round((Number(value) + delta) * 100) / 100)).toFixed(2));
    sfx.chip();
  };

  const cyclePreset = () => {
    const available = PRESETS.filter((value) => value >= minBet && value <= maxBet);
    const index = available.findIndex((value) => value >= amount);
    setAmount(Number(available[(index + 1 + available.length) % available.length] || minBet).toFixed(2));
    sfx.chip();
  };

  const placeCurrent = useCallback(async () => {
    if (!bettingOpenNow(CLIENT_BETTING_GUARD_SECONDS) || placing || locked || picks.length === 0) return null;
    const stake = Math.min(maxBet, Math.max(minBet, Number(amount) || minBet));
    return placeBet(picks, stake);
  }, [amount, bettingOpenNow, locked, maxBet, minBet, picks, placeBet, placing]);

  const startAuto = () => {
    if (!bettingOpenNow(CLIENT_BETTING_GUARD_SECONDS) || !picks.length || locked) return;
    autoStartBalance.current = Number(balance || 0);
    autoRoundRef.current = null;
    setAutoRemaining(autoChoice);
    setAutoOpen(false);
  };

  useEffect(() => {
    if (!autoRemaining || !betting || locked || placing || !picks.length) return;
    const round = state?.round_number;
    if (round == null || autoRoundRef.current === round) return;
    const start = Number(autoStartBalance.current ?? balance ?? 0);
    const current = Number(balance || 0);
    if (stopLoss > 0 && start - current >= stopLoss) {
      setAutoRemaining(0);
      return;
    }
    autoRoundRef.current = round;
    placeCurrent().then((response) => {
      if (response) setAutoRemaining((value) => Math.max(0, value - 1));
      else autoRoundRef.current = null;
    });
  }, [autoRemaining, balance, betting, locked, picks.length, placeCurrent, placing, state?.round_number, stopLoss]);

  useEffect(() => {
    const latestPayout = Number(result?.payout ?? state?.settled?.payout ?? 0);
    if (autoRemaining > 0 && stopWin > 0 && latestPayout >= stopWin) setAutoRemaining(0);
  }, [autoRemaining, result?.payout, state?.settled?.payout, stopWin]);

  const status = (() => {
    const roundSeconds = Math.max(0, Math.ceil(roundCountdown));
    const roundClock = formatRoundClock(roundSeconds);
    const betSeconds = Math.max(0, Math.ceil(countdown));
    if (phase === "REVEAL") return `LIVE DRAW • ${shownCount}/10 • ROUND ${roundClock}`;
    if (phase === "RESULT") {
      if (!locked && !result && !state?.settled) return `ROUND RESULT • NEXT ${roundClock}`;
      const stake = Number(lockedBet?.amount ?? result?.total_bet ?? state?.settled?.total_bet ?? 0);
      const payoutLabel = kenoPayoutLabel(payout, stake, money);
      return `${hits} HIT${hits === 1 ? "" : "S"} • ${payoutLabel} • NEXT ${roundClock}`;
    }
    if (phase === "BETTING" && !betting) return `BETS LOCKED • ROUND ${roundClock}`;
    if (locked) return `LIVE BET ACCEPTED • BETS CLOSE ${betSeconds}s • ROUND ${roundClock}`;
    if (picks.length) return `${picks.length} NUMBER${picks.length === 1 ? "" : "S"} • BET ${betSeconds}s • ROUND ${roundClock}`;
    return `PICK NUMBERS • BET ${betSeconds}s • ROUND ${roundClock}`;
  })();

  const recent = lastResults.slice(0, 6);

  return (
    <div className="keno-shell" data-phase={phase || "LOADING"} data-demo={demo ? "true" : "false"} data-testid="keno-live-cabinet">
      <div className="keno-cabinet">
        <header className="keno-header">
          <button type="button" className="keno-game-button" onClick={() => navigate(`/games/${game.slug}`)}>
            <span>KENO</span><ChevronDown />
          </button>
          <button type="button" className="keno-help-button" onClick={() => setRulesOpen(true)}>
            <CircleHelp /><span>How to Play?</span>
          </button>
          <div className="keno-live-mode">LIVE MODE</div>
          <div className="keno-balance" data-testid="keno-balance">₹{balance == null ? "…" : money(balance)} <span>INR</span></div>
          <button
            type="button"
            className={`keno-music-button ${musicOn ? "is-active" : ""}`}
            onClick={toggleKenoMusic}
            aria-label={musicOn ? "Stop Keno motivational music" : "Play Keno motivational music"}
            aria-pressed={musicOn}
            data-testid="keno-music"
          >
            {musicOn ? <Volume2 /> : <Music2 />}
          </button>
          <button type="button" className="keno-menu-button" onClick={() => setMenuOpen(true)} aria-label="Open game menu"><Menu /></button>
        </header>

        <main className="keno-playfield">
          <div className="keno-status" aria-live="polite">{status}</div>
          <div className="keno-content">
            <section className="keno-grid" aria-label="Keno number board" data-testid="keno-board">
              {NUMBERS.map((number) => (
                <NumberBall
                  key={number}
                  number={number}
                  picked={activePicks.includes(number)}
                  drawn={shownSet.has(number)}
                  drawing={drawing}
                  latest={number === latest && phase === "REVEAL"}
                  disabled={!betting || locked || placing}
                  onClick={() => togglePick(number)}
                />
              ))}
            </section>
            <Paytable picks={pickCount} table={table} hits={hits} active={phase === "RESULT"} />
          </div>

          <div className="keno-selection-actions">
            <button type="button" onClick={randomize} disabled={!betting || locked || placing} data-testid="keno-random">RANDOM</button>
            <button type="button" onClick={() => setPicks([])} disabled={!betting || locked || placing || !picks.length} data-testid="keno-clear">CLEAR</button>
          </div>
        </main>

        <footer className="keno-betbar">
          <div className="keno-stake-control">
            <div className="keno-stake-amount">
              <label htmlFor="keno-stake">Bet INR</label>
              <input id="keno-stake" value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} onBlur={() => setAmount(Math.min(maxBet, Math.max(minBet, Number(amount) || minBet)).toFixed(2))} disabled={locked || placing} aria-label="Bet amount in INR" />
            </div>
            <button type="button" onClick={() => adjustAmount(-minBet)} disabled={locked || placing} aria-label="Decrease bet"><Minus strokeWidth={3.4} /></button>
            <button type="button" onClick={cyclePreset} disabled={locked || placing} aria-label="Select bet preset"><Coins strokeWidth={2.8} /></button>
            <button type="button" onClick={() => adjustAmount(minBet)} disabled={locked || placing} aria-label="Increase bet"><Plus strokeWidth={3.4} /></button>
          </div>

          <button
            type="button"
            className={`keno-auto-button ${autoRemaining ? "is-active" : ""}`}
            onClick={() => autoRemaining ? setAutoRemaining(0) : setAutoOpen(true)}
            disabled={placing}
            aria-label={autoRemaining ? "Stop auto play" : "Configure auto play"}
            data-testid="keno-auto"
          >
            <RefreshCw strokeWidth={3.2} />{autoRemaining > 0 && <b>{autoRemaining}</b>}
          </button>

          <button type="button" className="keno-bet-button" onClick={placeCurrent} disabled={!betting || locked || placing || !picks.length} data-testid="keno-bet">
            <Play /><span>{placing ? "PLACING…" : locked ? "BET PLACED" : "BET"}</span>
          </button>
        </footer>
      </div>

      {rulesOpen && (
        <Modal title="HOW TO PLAY" onClose={() => setRulesOpen(false)}>
          <div className="keno-rules">
            <p>Pick from 1 to 10 numbers on the 36-number board, set your stake in INR, then press <b>BET</b>.</p>
            <p>Every live round draws 10 numbers. Your payout is your stake multiplied by the value shown beside the number of hits.</p>
            <ol><li>Pink numbers were drawn.</li><li>Gold numbers are winning hits.</li><li>A yellow ring marks one of your picks.</li></ol>
            <p className="keno-live-note">LIVE MODE means the round and result are synchronized by the server for every connected player.</p>
          </div>
        </Modal>
      )}

      {autoOpen && (
        <Modal title="AUTO PLAY" onClose={() => setAutoOpen(false)} className="keno-auto-modal">
          <div className="keno-auto-body">
            <p>Number of rounds</p>
            <div className="keno-auto-rounds">
              {AUTO_ROUNDS.map((rounds) => <button type="button" key={rounds} className={autoChoice === rounds ? "is-selected" : ""} onClick={() => setAutoChoice(rounds)}>{rounds}</button>)}
            </div>
            <label>Stop if cash decreases by<input type="number" min="0" value={stopLoss || ""} onChange={(event) => setStopLoss(Number(event.target.value) || 0)} placeholder="0.00" /></label>
            <label>Stop if single win exceeds<input type="number" min="0" value={stopWin || ""} onChange={(event) => setStopWin(Number(event.target.value) || 0)} placeholder="0.00" /></label>
            <button type="button" className="keno-start-auto" onClick={startAuto} disabled={!picks.length || locked}>START AUTO</button>
          </div>
        </Modal>
      )}

      {menuOpen && (
        <Modal title="KENO MENU" onClose={() => setMenuOpen(false)} className="keno-menu-modal">
          <div className="keno-menu-body">
            <div className="keno-menu-live"><span>LIVE MODE</span><b>ROUND #{state?.round_number ?? "—"}</b></div>
            <button type="button" onClick={toggleKenoMusic}>{musicOn ? <Volume2 /> : <Music2 />}<span>{musicOn ? "Motivational music on" : "Play motivational music"}</span></button>
            <button type="button" onClick={toggleMuted}>{muted ? <VolumeX /> : <Volume2 />}<span>{muted ? "Sound off" : "Sound on"}</span></button>
            <button type="button" onClick={() => { setMenuOpen(false); setAutoOpen(true); }}><RefreshCw /><span>Auto Play</span></button>
            {locked && betting && <button type="button" onClick={() => {
              if (bettingOpenNow(CLIENT_BETTING_GUARD_SECONDS)) clearBets();
              setMenuOpen(false);
            }}><X /><span>Cancel current bet ₹{money(myTotal)}</span></button>}
            <div className="keno-recent"><h3><History /> Recent live draws</h3>{recent.length ? recent.map((row) => <div key={row.round_number}><b>#{row.round_number}</b><span>{(row.drawn || []).join(" · ")}</span></div>) : <p>No completed rounds yet.</p>}</div>
            <button type="button" onClick={() => navigate(`/games/${game.slug}`)}><ChevronDown /><span>Exit game</span></button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function LiveKeno({ game }) {
  const live = useLiveRound(game.slug, {
    pollMs: 800,
    revealSound: "draw",
    formatResult: (settled) => {
      const bet = settled.bets?.[0] || {};
      const hits = bet.matches?.length || 0;
      const netWin = settled.payout > settled.total_bet;
      return {
        win: netWin,
        big: netWin && settled.payout >= settled.total_bet * 5,
        title: `${hits} hit${hits === 1 ? "" : "s"}`,
        subtitle: netWin
          ? `Won ₹${money(settled.payout)}`
          : settled.payout > 0 ? `Returned ₹${money(settled.payout)}` : "No payout this round",
      };
    },
  });
  return <KenoTable game={game} live={live} />;
}

function DemoKeno({ game }) {
  const demo = useDemoKeno();
  return <KenoTable game={game} live={demo} demo />;
}

export default function KenoCabinet({ game }) {
  return game.demo ? <DemoKeno game={game} /> : <LiveKeno game={game} />;
}
