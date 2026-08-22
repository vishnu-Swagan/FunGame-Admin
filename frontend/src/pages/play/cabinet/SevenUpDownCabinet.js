import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Settings, RotateCcw, Undo2, X, ChevronDown, ChevronUp,
  Map, Volume2, VolumeX,
} from "lucide-react";
import { formatChips } from "@/components/common";
import { useLiveRound } from "@/lib/useLiveRound";
import { isMuted, onMuteChange, sfx, toggleMuted } from "@/lib/sound";
import { fitDesignCanvas } from "@/lib/viewport";
import { BrandWordmark } from "@/components/Brand";
import playerAvatar from "./sevenUpDownMascot.png";
import "./sevenUpDown.css";

const CHIP_VALUES = [10, 20, 50, 100, 200];
const CHIP_COLORS = {
  10: { face: "#f4ecd2", deep: "#b9ad88", rim: "#168c50", ink: "#183126" },
  20: { face: "#238bc3", deep: "#075682", rim: "#d7f2ff", ink: "#ffffff" },
  50: { face: "#dc4439", deep: "#8e1615", rim: "#f6cf62", ink: "#ffffff" },
  100: { face: "#252a30", deep: "#090b0e", rim: "#ece9d9", ink: "#ffffff" },
  200: { face: "#84368f", deep: "#43164e", rim: "#f1c84b", ink: "#ffffff" },
};
const TOTALS = [
  { total: 2, odds: "1:26" }, { total: 3, odds: "1:12" },
  { total: 4, odds: "1:8" }, { total: 5, odds: "1:6" },
  { total: 6, odds: "1:5" }, { total: 8, odds: "1:5" },
  { total: 9, odds: "1:6" }, { total: 10, odds: "1:8" },
  { total: 11, odds: "1:12" }, { total: 12, odds: "1:26" },
];
const PAYOUTS = {
  down: 2, seven: 5, up: 2,
  t2: 27, t3: 13, t4: 9, t5: 7, t6: 6,
  t8: 6, t9: 7, t10: 9, t11: 13, t12: 27,
};
const PIPS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};
const DOWN_DICE = [[1, 1], [1, 2], [1, 3], [2, 2], [1, 4], [2, 3], [1, 5], [2, 4], [3, 3]];
const UP_DICE = [[2, 6], [3, 5], [4, 4], [3, 6], [4, 5], [4, 6], [5, 5], [5, 6], [6, 6]];
const SEVEN_DICE = [[1, 6], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]];
const DEMO_BET_SECONDS = 15;

function winnerAvatar(winner, index) {
  const characterAvatars = [1, 3, 9, 10, 11, 12, 13, 14, 15, 16];
  const key = String(winner?.id || winner?.name || index);
  let hash = 0;
  for (let cursor = 0; cursor < key.length; cursor += 1) hash = ((hash * 31) + key.charCodeAt(cursor)) >>> 0;
  return `/aviator-live/avatars/av-${characterAvatars[hash % characterAvatars.length]}.png`;
}

function resultFromDice(dice, roundNumber) {
  const total = dice[0] + dice[1];
  return {
    round_number: roundNumber,
    dice,
    total,
    winner: total === 7 ? "seven" : total > 7 ? "up" : "down",
  };
}

function seededDemoHistory() {
  return Array.from({ length: 100 }, (_, index) => {
    const selector = (index * 37) % 100;
    const pool = selector < 51 ? DOWN_DICE : selector < 84 ? UP_DICE : SEVEN_DICE;
    return resultFromDice(pool[index % pool.length], 1200 - index);
  });
}

function useDemoRound() {
  const [phase, setPhase] = useState("BETTING");
  const [countdown, setCountdown] = useState(DEMO_BET_SECONDS);
  const [round, setRound] = useState(12);
  const [outcome, setOutcome] = useState(null);
  const [balance, setBalance] = useState(10000);
  const [myBets, setMyBets] = useState([]);
  const [lastResults, setLastResults] = useState(seededDemoHistory);
  const betsRef = useRef(myBets);
  betsRef.current = myBets;

  useEffect(() => {
    const duration = phase === "BETTING" ? DEMO_BET_SECONDS : phase === "REVEAL" ? 3 : 2.4;
    const deadline = Date.now() + duration * 1000;
    setCountdown(duration);
    const clock = setInterval(() => setCountdown(Math.max(0, (deadline - Date.now()) / 1000)), 80);
    const next = setTimeout(() => {
      if (phase === "BETTING") {
        const d1 = 1 + Math.floor(Math.random() * 6);
        const d2 = 1 + Math.floor(Math.random() * 6);
        setOutcome(resultFromDice([d1, d2], round));
        sfx.dice();
        setPhase("REVEAL");
        return;
      }
      if (phase === "REVEAL") {
        const final = outcome;
        const payout = betsRef.current.reduce((sum, bet) => {
          const won = bet.selection.startsWith("t")
            ? final?.total === Number(bet.selection.slice(1))
            : final?.winner === bet.selection;
          return sum + (won ? bet.amount * PAYOUTS[bet.selection] : 0);
        }, 0);
        if (payout > 0) {
          setBalance((value) => value + payout);
          sfx.winCelebration();
        } else if (betsRef.current.length) {
          sfx.lose();
        }
        if (final) setLastResults((items) => [final, ...items].slice(0, 100));
        setPhase("RESULT");
        return;
      }
      setMyBets([]);
      setOutcome(null);
      setRound((value) => value + 1);
      setPhase("BETTING");
    }, duration * 1000);
    return () => {
      clearInterval(clock);
      clearTimeout(next);
    };
  }, [phase, outcome, round]);

  const placeBet = useCallback(async (selection, amount) => {
    if (phase !== "BETTING" || amount > balance) return null;
    const bet = { id: `demo-${Date.now()}-${Math.random()}`, selection, amount };
    setBalance((value) => value - amount);
    setMyBets((items) => [...items, bet]);
    sfx.chip();
    return { balance: balance - amount };
  }, [phase, balance]);

  const clearBets = useCallback(async () => {
    if (phase !== "BETTING") return null;
    const refunded = betsRef.current.reduce((sum, bet) => sum + bet.amount, 0);
    setBalance((value) => value + refunded);
    setMyBets([]);
    return { refunded };
  }, [phase]);

  const undoBet = useCallback(async () => {
    if (phase !== "BETTING" || !betsRef.current.length) return null;
    const latest = betsRef.current[betsRef.current.length - 1];
    setMyBets((items) => items.slice(0, -1));
    setBalance((value) => value + latest.amount);
    sfx.chip();
    return { refunded: latest.amount };
  }, [phase]);

  const revealProgress = phase === "RESULT" ? 1 : phase === "REVEAL" ? Math.max(0, 1 - countdown / 3) : 0;
  const myTotal = myBets.reduce((sum, bet) => sum + bet.amount, 0);
  const state = useMemo(() => ({
    round_number: round,
    phase,
    min_bet: 10,
    max_bet: 200,
    timings: { bet: DEMO_BET_SECONDS, reveal: 3, result: 2.4 },
    winners: [
      { id: "d1", name: "r***a", payout: 9594 },
      { id: "d2", name: "s***i", payout: 1710 },
      { id: "d3", name: "a***n", payout: 5305 },
    ],
  }), [round, phase]);

  return {
    state, countdown, balance, placing: false, phase, betting: phase === "BETTING",
    outcome, myBets, myTotal, lastResults, revealProgress, placeBet, clearBets, undoBet,
  };
}

function useJiliSoundState() {
  const [muted, setMuted] = useState(isMuted());
  useEffect(() => onMuteChange(setMuted), []);
  return muted;
}

function useCabinetScale(stageRef) {
  const measure = () => {
    if (typeof window === "undefined") return 1;
    const stage = stageRef.current;
    const width = stage?.clientWidth || window.visualViewport?.width || window.innerWidth;
    const height = stage?.clientHeight || Math.max(320, (window.visualViewport?.height || window.innerHeight) - 58);
    return fitDesignCanvas({
      availableWidth: width,
      availableHeight: height,
      designWidth: 500,
      designHeight: 884,
      maxScale: 1,
    }).scale;
  };
  const [scale, setScale] = useState(measure);
  useLayoutEffect(() => {
    const resize = () => setScale(measure());
    const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(resize) : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    resize();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, [stageRef]);
  return scale;
}

function CabinetShell({ game, children }) {
  const navigate = useNavigate();
  const muted = useJiliSoundState();
  return (
    <div className="j7-shell">
      <header className="j7-titlebar">
        <button type="button" onClick={() => navigate(`/games/${game.slug}`)} aria-label="Back to game details"><ArrowLeft /></button>
        <div className="j7-title-brand"><BrandWordmark logoClassName="j7-title-brand-logo" /><h1 className="sr-only">{game.name}</h1></div>
        <button type="button" onClick={toggleMuted} aria-label={muted ? "Unmute game sounds" : "Mute game sounds"}>
          {muted ? <VolumeX /> : <Volume2 />}
        </button>
      </header>
      {children}
    </div>
  );
}

function DieFace({ value, red = false, side = "front" }) {
  return (
    <span className={`j7-die-face is-${side}`}>
      {Array.from({ length: 9 }, (_, index) => (
        <i key={index} className={`${PIPS[value]?.includes(index) ? "is-on" : ""} ${red ? "is-red" : ""}`} />
      ))}
    </span>
  );
}

function Die({ value = 1, red = false, small = false, rolling = false, landed = false }) {
  if (small) {
    return (
      <span className="j7-die is-small" aria-label={`${value} on die`}>
        {Array.from({ length: 9 }, (_, index) => (
          <i key={index} className={`${PIPS[value]?.includes(index) ? "is-on" : ""} ${red ? "is-red" : ""}`} />
        ))}
      </span>
    );
  }

  /* Six real planes preserve the cube silhouette while it tumbles. The front
     face is always the synchronized result; the other planes are visual depth. */
  const opposite = 7 - value;
  const top = value === 1 || value === 6 ? 2 : 1;
  const right = [1, 2, 3, 4, 5, 6].find((face) => face !== value && face !== opposite && face !== top && face !== 7 - top) || 3;
  return (
    <span className={`j7-die ${rolling ? "is-rolling" : ""} ${landed ? "is-landed" : ""}`} aria-label={`${value} on die`}>
      <span className="j7-die-cube">
        <DieFace value={value} red={red} side="front" />
        <DieFace value={opposite} red={red} side="back" />
        <DieFace value={right} red={red} side="right" />
        <DieFace value={7 - right} red={red} side="left" />
        <DieFace value={top} red={red} side="top" />
        <DieFace value={7 - top} red={red} side="bottom" />
      </span>
    </span>
  );
}

function BetChip({ amount }) {
  if (!amount) return null;
  const denomination = [...CHIP_VALUES].reverse().find((value) => amount >= value) || CHIP_VALUES[0];
  const color = CHIP_COLORS[denomination];
  const label = amount >= 1000 ? `${Math.round(amount / 100) / 10}K` : formatChips(amount);
  return (
    <span
      className="j7-stake-chip"
      style={{ "--chip-face": color.face, "--chip-deep": color.deep, "--chip-rim": color.rim, "--chip-ink": color.ink }}
    >
      <b>{label}</b>
    </span>
  );
}

function HistoryCell({ item, latest = false }) {
  const dice = item?.dice || [1, 1];
  const winner = item?.winner || "down";
  return (
    <span className={`j7-history-cell ${winner} ${latest ? "is-latest" : ""}`}>
      <span className="j7-history-star">★</span>
      <b>{item?.total ?? "–"}</b>
      <span className="j7-mini-dice"><Die value={dice[0]} small /><Die value={dice[1]} red small /></span>
    </span>
  );
}

function ToolButton({ icon, label, onClick, disabled = false, danger = false }) {
  return (
    <button className={`j7-tool ${danger ? "is-danger" : ""}`} type="button" onClick={onClick} disabled={disabled}>
      <span>{icon}</span><small>{label}</small>
    </button>
  );
}

function SevenUpDownTable({ game, live, demo = false }) {
  const {
    state, countdown, balance, placing, phase, betting, outcome, myBets, myTotal,
    lastResults, revealProgress, placeBet, clearBets, undoBet,
  } = live;
  const [chip, setChip] = useState(10);
  const [chipMenu, setChipMenu] = useState(false);
  const [multiple, setMultiple] = useState(true);
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const stageRef = useRef(null);
  const cabinetScale = useCabinetScale(stageRef);
  const repeatRef = useRef([]);
  const landedRef = useRef("");

  useEffect(() => {
    if (myBets.length) repeatRef.current = myBets.map(({ selection, amount }) => ({ selection, amount }));
  }, [myBets]);

  useEffect(() => {
    const key = `${state?.round_number}:${phase}`;
    if (phase === "REVEAL" && revealProgress >= 0.63 && landedRef.current !== key) {
      landedRef.current = key;
      sfx.diceLand();
    }
  }, [phase, revealProgress, state?.round_number]);

  const stakes = useMemo(() => myBets.reduce((map, bet) => {
    map[bet.selection] = (map[bet.selection] || 0) + bet.amount;
    return map;
  }, {}), [myBets]);
  const history = useMemo(() => lastResults.slice(0, 12).reverse(), [lastResults]);
  const [rollingFaces, setRollingFaces] = useState([3, 4]);
  const stats = useMemo(() => {
    const sample = lastResults.slice(0, 100);
    const size = sample.length || 1;
    const count = (winner) => sample.filter((round) => round.winner === winner).length;
    return {
      size: sample.length,
      down: Math.round((count("down") / size) * 100),
      seven: Math.round((count("seven") / size) * 100),
      up: Math.round((count("up") / size) * 100),
    };
  }, [lastResults]);

  const shownOutcome = phase === "RESULT" || (phase === "REVEAL" && revealProgress >= 0.63);
  const rolling = phase === "REVEAL" && !shownOutcome;
  const fallbackDice = history.length ? history[history.length - 1]?.dice : [3, 4];
  const dice = shownOutcome && outcome?.dice ? outcome.dice : rolling ? rollingFaces : (fallbackDice || [3, 4]);
  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 200;
  const bettingLength = state?.timings?.bet || 60;
  const timerProgress = betting ? Math.min(1, countdown / bettingLength) : Math.max(0, 1 - revealProgress);

  /* The changing faces are visual theatre only; the final pair below always
     switches to `outcome.dice`, which is the synchronized server result. */
  useEffect(() => {
    if (!rolling) return undefined;
    const nextFace = () => 1 + Math.floor(Math.random() * 6);
    const timer = window.setInterval(() => setRollingFaces([nextFace(), nextFace()]), 82);
    return () => window.clearInterval(timer);
  }, [rolling, state?.round_number]);

  useEffect(() => {
    if (!CHIP_VALUES.includes(chip) || chip < minBet || chip > maxBet) {
      setChip(CHIP_VALUES.find((value) => value >= minBet && value <= maxBet) || minBet);
    }
  }, [chip, minBet, maxBet]);

  const lay = useCallback(async (selection) => {
    if (!betting || placing || busy) return;
    if (!multiple && myBets.length) await clearBets();
    await placeBet(selection, chip);
  }, [betting, placing, busy, multiple, myBets.length, clearBets, placeBet, chip]);

  const replay = useCallback(async (mode) => {
    if (!betting || placing || busy || !repeatRef.current.length) return;
    setBusy(true);
    try {
      const layout = mode === "double"
        ? myBets.map(({ selection, amount }) => ({ selection, amount }))
        : repeatRef.current.map((bet) => ({ ...bet }));
      if (mode === "again" && myBets.length) await clearBets();
      for (const bet of layout) {
        await placeBet(bet.selection, Math.min(maxBet, Math.max(minBet, bet.amount)));
      }
    } finally {
      setBusy(false);
    }
  }, [betting, placing, busy, myBets, clearBets, maxBet, minBet, placeBet]);

  const realWinners = state?.winners?.slice(0, 3) || [];
  const roundLabel = String(state?.round_number ?? "12").slice(-2).padStart(2, "0");

  return (
    <CabinetShell game={game}>
      <div
        ref={stageRef}
        className="j7-stage"
        data-testid="seven-up-down-table"
        data-demo={demo ? "true" : "false"}
        data-phase={phase || "LOADING"}
        style={{ "--j7-scale": cabinetScale }}
      >
        <section className="j7-table">
          <header className="j7-roadmap">
            <div className="j7-stats">
              <b><em>2~6</em> {stats.down}%</b>
              <b><em>8~12</em> {stats.up}%</b>
              <b><em>7</em> {stats.seven}%</b>
              <span>Calculated from last {stats.size || 0} rounds.</span>
            </div>
            <div className="j7-history" aria-label="Previous rounds">
              {history.map((item, index) => <HistoryCell key={item.round_number || index} item={item} latest={index === history.length - 1} />)}
            </div>
          </header>

          <div className="j7-dome-zone">
            <div className="j7-winners" aria-label="Recent winners">
              <span className="j7-high-win">HIGH WIN<br />RATE</span>
              {realWinners.map((winner, index) => (
                <div className="j7-winner" key={winner.id || index}>
                  <img src={winnerAvatar(winner, index)} alt="" aria-hidden="true" />
                  <small>{winner.name}<b>₹ {formatChips(winner.payout)}</b></small>
                </div>
              ))}
            </div>

            <div className="j7-dome" aria-live="polite">
              <div className="j7-glass"><i /><i /></div>
              <div className={`j7-dice-tray ${rolling ? "is-rolling" : ""} ${shownOutcome ? "is-landed" : ""}`}>
                <Die value={dice[0]} rolling={rolling} landed={shownOutcome} />
                <Die value={dice[1]} red rolling={rolling} landed={shownOutcome} />
              </div>
            </div>

            <div className="j7-countdown" style={{ "--timer": `${timerProgress * 360}deg` }}>
              <span>{betting ? Math.max(0, Math.ceil(countdown)) : shownOutcome ? outcome?.total ?? "–" : "•"}</span>
            </div>
          </div>

          <div className="j7-brass-strip">
            <button type="button" onClick={() => setRulesOpen(true)} aria-label="Game settings"><Settings size={17} /></button>
            <span>{roundLabel}</span>
            <button type="button" onClick={() => setRoadmapOpen(true)}><Map size={14} /> Roadmap <ChevronDown size={13} /></button>
            <button type="button" className={multiple ? "is-on" : ""} onClick={() => setMultiple((value) => !value)}>Multiple Mode</button>
            <span><ChevronUp size={13} /> Min <b>{minBet}</b></span>
            <span>Max <b>{maxBet}</b></span>
          </div>

          <div className="j7-main-bets">
            <button type="button" className="j7-bet down" onClick={() => lay("down")} disabled={!betting || busy}>
              <span>2 - 6</span><small>1:1</small><strong>DOWN</strong><BetChip amount={stakes.down} />
            </button>
            <button type="button" className="j7-bet seven" onClick={() => lay("seven")} disabled={!betting || busy}>
              <span>7</span><small>1:4</small><BetChip amount={stakes.seven} />
            </button>
            <button type="button" className="j7-bet up" onClick={() => lay("up")} disabled={!betting || busy}>
              <span>8 - 12</span><small>1:1</small><strong>UP</strong><BetChip amount={stakes.up} />
            </button>
          </div>

          <div className="j7-total-grid">
            {TOTALS.map(({ total, odds }) => (
              <button type="button" key={total} onClick={() => lay(`t${total}`)} disabled={!betting || busy}>
                <b>{total}</b><small>{odds}</small><BetChip amount={stakes[`t${total}`]} />
              </button>
            ))}
          </div>

          <div className="j7-money-line">
            <span>Balance <b>₹{balance === null ? "…" : formatChips(balance)}</b></span>
            <span>Your Bet <b>₹{formatChips(myTotal)}</b></span>
          </div>

          <footer className="j7-tools">
            <div className="j7-player-card"><img src={playerAvatar} alt="Player" /><small>{demo ? "3164954_erg_INR" : "PLAYER"}</small></div>
            <ToolButton label="again" icon={<RotateCcw />} onClick={() => replay("again")} disabled={!betting || busy || !repeatRef.current.length} />
            <div className="j7-chip-picker">
              {chipMenu && <div className="j7-chip-menu">
                {CHIP_VALUES.filter((value) => value >= minBet && value <= maxBet).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={value === chip ? "is-active" : ""}
                    style={{
                      "--chip-face": CHIP_COLORS[value].face,
                      "--chip-deep": CHIP_COLORS[value].deep,
                      "--chip-rim": CHIP_COLORS[value].rim,
                      "--chip-ink": CHIP_COLORS[value].ink,
                    }}
                    onClick={() => { setChip(value); setChipMenu(false); sfx.chip(); }}
                  >{value}</button>
                ))}
              </div>}
              <button
                type="button"
                className="j7-bank-chip"
                style={{
                  "--chip-face": CHIP_COLORS[chip]?.face,
                  "--chip-deep": CHIP_COLORS[chip]?.deep,
                  "--chip-rim": CHIP_COLORS[chip]?.rim,
                  "--chip-ink": CHIP_COLORS[chip]?.ink,
                }}
                onClick={() => { setChipMenu((value) => !value); sfx.chip(); }}
                aria-label={`Selected chip ${chip}`}
              ><b>{chip}</b></button>
            </div>
            <ToolButton label="double" icon={<b>×2</b>} onClick={() => replay("double")} disabled={!betting || busy || !myBets.length} />
            <ToolButton label="undo" icon={<Undo2 />} onClick={undoBet} disabled={!betting || busy || !myBets.length} />
            <ToolButton label="clear" icon={<X />} onClick={clearBets} disabled={!betting || busy || !myBets.length} danger />
          </footer>

          {(roadmapOpen || rulesOpen) && (
            <div className="j7-modal" role="dialog" aria-modal="true">
              <div>
                <button type="button" className="j7-modal-close" onClick={() => { setRoadmapOpen(false); setRulesOpen(false); }}><X /></button>
                {roadmapOpen ? <>
                  <h2>Roadmap</h2>
                  <p>The latest shared live results. Every player sees the same two-dice outcome.</p>
                  <div className="j7-modal-history">{lastResults.slice(0, 30).reverse().map((item, index) => <HistoryCell key={item.round_number || index} item={item} latest={index === Math.min(29, lastResults.length - 1)} />)}</div>
                </> : <>
                  <h2>How to play</h2>
                  <p><b>DOWN</b> wins when the dice total 2–6. <b>UP</b> wins on 8–12. A total of <b>7</b> wins only the blue Lucky Seven bet. Exact-total bets pay the odds printed on the felt.</p>
                  <p>Minimum stake: {minBet}. Maximum stake per chip: {maxBet}.</p>
                </>}
              </div>
            </div>
          )}
        </section>
      </div>
    </CabinetShell>
  );
}

function LiveSevenUpDown({ game }) {
  const live = useLiveRound(game.slug, {
    pollMs: 900,
    revealSound: "dice",
    formatResult: (settled) => ({
      title: settled.payout > 0 ? `WIN ${formatChips(settled.payout)}` : "BETTER LUCK NEXT ROUND",
      subtitle: `${settled.outcome?.dice?.[0] ?? "–"} + ${settled.outcome?.dice?.[1] ?? "–"} = ${settled.outcome?.total ?? "–"}`,
    }),
  });
  return <SevenUpDownTable game={game} live={live} />;
}

function DemoSevenUpDown({ game }) {
  const demo = useDemoRound();
  return <SevenUpDownTable game={game} live={demo} demo />;
}

export default function SevenUpDownCabinet({ game }) {
  return game.demo ? <DemoSevenUpDown game={game} /> : <LiveSevenUpDown game={game} />;
}
