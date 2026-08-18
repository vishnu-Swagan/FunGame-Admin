import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings, RotateCcw, Undo2, X, ChevronDown, ChevronUp, Map } from "lucide-react";
import { PlayShell } from "@/components/play/PlayShell";
import { formatChips } from "@/components/common";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import "./sevenUpDown.css";

const CHIP_VALUES = [10, 20, 50, 100, 200];
const TOTALS = [
  { total: 2, odds: "1:26" },
  { total: 3, odds: "1:12" },
  { total: 4, odds: "1:8" },
  { total: 5, odds: "1:6" },
  { total: 6, odds: "1:5" },
  { total: 8, odds: "1:5" },
  { total: 9, odds: "1:6" },
  { total: 10, odds: "1:8" },
  { total: 11, odds: "1:12" },
  { total: 12, odds: "1:26" },
];
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function Die({ value = 1, red = false, small = false, rolling = false }) {
  return (
    <span className={`j7-die ${small ? "is-small" : ""} ${rolling ? "is-rolling" : ""}`} aria-label={`${value} on die`}>
      {Array.from({ length: 9 }, (_, index) => (
        <i key={index} className={`${PIPS[value]?.includes(index) ? "is-on" : ""} ${red ? "is-red" : ""}`} />
      ))}
    </span>
  );
}

function BetChip({ amount, selected = false }) {
  if (!amount) return null;
  return <span className={`j7-stake-chip ${selected ? "is-selected" : ""}`}>{formatChips(amount)}</span>;
}

function HistoryCell({ item, latest = false }) {
  const dice = item?.dice || [1, 1];
  const winner = item?.winner || (item?.total === 7 ? "seven" : item?.total > 7 ? "up" : "down");
  return (
    <span className={`j7-history-cell ${winner} ${latest ? "is-latest" : ""}`}>
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

export default function SevenUpDownCabinet({ game }) {
  const {
    state, countdown, balance, placing, phase, betting, outcome, myBets, myTotal,
    lastResults, revealProgress, placeBet, clearBets, undoBet,
  } = useLiveRound(game.slug, {
    pollMs: 900,
    revealSound: "dice",
    formatResult: (settled) => ({
      title: settled.payout > 0 ? `WIN ${formatChips(settled.payout)}` : "BETTER LUCK NEXT ROUND",
      subtitle: `${settled.outcome?.dice?.[0] ?? "–"} + ${settled.outcome?.dice?.[1] ?? "–"} = ${settled.outcome?.total ?? "–"}`,
    }),
  });
  const [chip, setChip] = useState(10);
  const [chipMenu, setChipMenu] = useState(false);
  const [multiple, setMultiple] = useState(true);
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const dice = shownOutcome && outcome?.dice ? outcome.dice : (fallbackDice || [3, 4]);
  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 200;
  const bettingLength = state?.timings?.bet || 60;
  const timerProgress = betting ? Math.min(1, countdown / bettingLength) : Math.max(0, 1 - revealProgress);

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
      if (mode === "again" && myBets.length) await clearBets();
      for (const bet of repeatRef.current) {
        const amount = Math.min(maxBet, Math.max(minBet, bet.amount));
        await placeBet(bet.selection, amount);
      }
    } finally {
      setBusy(false);
    }
  }, [betting, placing, busy, myBets.length, clearBets, maxBet, minBet, placeBet]);

  const realWinners = state?.winners?.slice(0, 3) || [];

  return (
    <PlayShell game={game} balance={balance} compact>
      <div className="j7-stage" data-testid="seven-up-down-table">
        <section className="j7-table">
          <header className="j7-roadmap">
            <div className="j7-stats">
              <b><em>2~6</em> {stats.down}%</b>
              <b><em>8~12</em> {stats.up}%</b>
              <b><em>7</em> {stats.seven}%</b>
              <span>Calculated from last {stats.size || 0} rounds.</span>
            </div>
            <div className="j7-history" aria-label="Previous rounds">
              {history.length ? history.map((item, index) => (
                <HistoryCell key={item.round_number || index} item={item} latest={index === history.length - 1} />
              )) : Array.from({ length: 12 }, (_, index) => <HistoryCell key={index} />)}
            </div>
          </header>

          <div className="j7-dome-zone">
            <div className="j7-winners" aria-label="Recent winners">
              <span className="j7-high-win">HIGH WIN<br />RATE</span>
              {realWinners.length ? realWinners.map((winner, index) => (
                <div className="j7-winner" key={winner.id || index}>
                  <span>{String(winner.name || "P").replaceAll("*", "").slice(0, 1).toUpperCase()}</span>
                  <small>{winner.name}<b>◉ {formatChips(winner.payout)}</b></small>
                </div>
              )) : <span className="j7-live-badge">LIVE<br />TABLE</span>}
            </div>

            <div className="j7-dome" aria-live="polite">
              <div className="j7-glass"><i /><i /></div>
              <div className={`j7-dice-tray ${rolling ? "is-rolling" : ""}`}>
                <Die value={dice[0]} rolling={rolling} />
                <Die value={dice[1]} red rolling={rolling} />
              </div>
              {shownOutcome && outcome && (
                <div className={`j7-result ${outcome.winner}`}>
                  <b>{outcome.total}</b><span>{outcome.winner === "seven" ? "LUCKY SEVEN" : outcome.winner.toUpperCase()}</span>
                </div>
              )}
            </div>

            <div className="j7-countdown" style={{ "--timer": `${timerProgress * 360}deg` }}>
              <span>{betting ? Math.max(0, Math.ceil(countdown)) : phase === "REVEAL" ? "GO" : outcome?.total ?? "–"}</span>
            </div>
          </div>

          <div className="j7-brass-strip">
            <button type="button" onClick={() => setRulesOpen(true)} aria-label="Game settings"><Settings size={17} /></button>
            <span>♦ {state?.round_number ?? "–"}</span>
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
            <span>Balance <b>◉ {balance === null ? "…" : formatChips(balance)}</b></span>
            <span>Your Bet <b>◉ {formatChips(myTotal)}</b></span>
          </div>

          <footer className="j7-tools">
            <ToolButton label="again" icon={<RotateCcw />} onClick={() => replay("again")} disabled={!betting || busy || !repeatRef.current.length} />
            <div className="j7-chip-picker">
              {chipMenu && <div className="j7-chip-menu">
                {CHIP_VALUES.filter((value) => value >= minBet && value <= maxBet).map((value) => (
                  <button type="button" key={value} className={value === chip ? "is-active" : ""} onClick={() => { setChip(value); setChipMenu(false); }}>{value}</button>
                ))}
              </div>}
              <button type="button" className="j7-bank-chip" onClick={() => setChipMenu((value) => !value)} aria-label={`Selected chip ${chip}`}>
                <i /><b>{chip}</b>
              </button>
            </div>
            <ToolButton label="double" icon={<b>×2</b>} onClick={() => replay("double")} disabled={!betting || busy || !myBets.length} />
            <ToolButton label="undo" icon={<Undo2 />} onClick={undoBet} disabled={!betting || busy || !myBets.length} />
            <ToolButton label="clear" icon={<X />} onClick={clearBets} disabled={!betting || busy || !myBets.length} danger />
          </footer>

          {!betting && <div className="j7-bets-closed">{phase === "REVEAL" ? "DICE ROLLING" : "PLACE YOUR BETS"}</div>}

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
                  <p>Minimum stake: {minBet}. Maximum stake per chip: {maxBet}. Results are generated and settled by the shared server round.</p>
                </>}
              </div>
            </div>
          )}
        </section>
      </div>
    </PlayShell>
  );
}
