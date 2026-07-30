import { useMemo, useState, useEffect } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { GameStage } from "@/components/play/GameStage";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

/* pip layout per face value on a 3x3 grid */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const FACE_ROT = {
  1: "rotateX(0deg) rotateY(0deg)", 2: "rotateX(-90deg) rotateY(0deg)",
  3: "rotateX(0deg) rotateY(-90deg)", 4: "rotateX(0deg) rotateY(90deg)",
  5: "rotateX(90deg) rotateY(0deg)", 6: "rotateX(0deg) rotateY(180deg)",
};
const FACE_PLACE = {
  1: "translateZ(34px)", 2: "rotateX(90deg) translateZ(34px)", 3: "rotateY(90deg) translateZ(34px)",
  4: "rotateY(-90deg) translateZ(34px)", 5: "rotateX(-90deg) translateZ(34px)", 6: "rotateY(180deg) translateZ(34px)",
};

const DieFace = ({ value }) => (
  <div className="fg-die-face" style={{ transform: FACE_PLACE[value] }}>
    {Array.from({ length: 9 }, (_, i) => (
      <span key={i} className={PIPS[value].includes(i) ? `fg-pip ${value === 1 ? "fg-pip-red" : ""}` : ""} />
    ))}
  </div>
);

const Die = ({ value, rolling, variant, duration = "0.8s" }) => (
  <div className="fg-die-scene relative">
    <div className={`fg-die-shadow ${rolling ? "rolling" : ""}`} style={rolling ? { animationDuration: duration } : {}} />
    <div
      className={`fg-die ${rolling ? `rolling ${variant ? "v2" : ""}` : ""}`}
      style={rolling ? { animationDuration: duration } : { transform: FACE_ROT[value] }}
    >
      {[1, 2, 3, 4, 5, 6].map((v) => <DieFace key={v} value={v} />)}
    </div>
  </div>
);

/** A past round's dice, small — two 3x3 pip grids under the total. */
const MiniDie = ({ value }) => (
  <span className="grid grid-cols-3 gap-[1px] w-[15px] h-[15px] rounded-[2px] bg-white p-[1.5px]">
    {Array.from({ length: 9 }, (_, i) => (
      <span key={i} className={`rounded-full ${PIPS[value]?.includes(i) ? (value === 1 ? "bg-red-600" : "bg-neutral-900") : ""}`} />
    ))}
  </span>
);

const TOTALS_TOP = [2, 3, 4, 5, 6];
const TOTALS_BOTTOM = [8, 9, 10, 11, 12];
const CHIPS = [10, 50, 100, 500, 1000];

/** Colour a total the way the table does: down green, seven blue, up red. */
const totalTone = (t) =>
  t === 7 ? { bg: "bg-sky-600", ring: "ring-sky-400" }
  : t < 7 ? { bg: "bg-emerald-600", ring: "ring-emerald-400" }
  : { bg: "bg-rose-600", ring: "ring-rose-400" };

export default function DiceGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, setResult,
          placeBet, clearBets, myBets, myTotal, lastResults } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `Rolled ${s.outcome.dice[0]} + ${s.outcome.dice[1]} = ${s.outcome.total} — ${String(s.outcome.winner).toUpperCase()}`,
      }),
    });

  const [chip, setChip] = useState(10);
  const [lastRound, setLastRound] = useState([]);
  const [rollCfg, setRollCfg] = useState([{ v: false, d: "0.8s" }, { v: true, d: "0.9s" }]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const rolling = phase === "REVEAL" && !showFinal;
  const dice = showFinal ? outcome.dice : [3, 4];

  useEffect(() => {
    if (!rolling) return;
    const mk = () => ({ v: Math.random() < 0.5, d: (0.66 + Math.random() * 0.34).toFixed(2) + "s" });
    setRollCfg([mk(), mk()]);
    sfx.dice();
    const t = setInterval(sfx.dice, 1150);
    return () => clearInterval(t);
  }, [rolling]);
  useEffect(() => { if (showFinal && phase === "REVEAL") sfx.diceLand(); }, [showFinal, phase]);

  /* Odds come from the server's own paytable, so the table can never advertise a
     price the backend would not pay. */
  const options = state?.options || {};
  const oddsFor = (sel) => {
    const m = options[sel];
    if (!m) return "";
    const profit = m - 1;
    return `1:${Number.isInteger(profit) ? profit : profit.toFixed(1)}`;
  };

  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });

  /* "Calculated from the last 100 rounds" — the real distribution of what this
     table has actually produced, not a fixed 33/17/50. */
  const share = useMemo(() => {
    const rows = (lastResults || []).filter((r) => r.total != null);
    if (!rows.length) return null;
    const c = { down: 0, seven: 0, up: 0 };
    rows.forEach((r) => { c[r.total === 7 ? "seven" : r.total < 7 ? "down" : "up"] += 1; });
    const pct = (n) => Math.round((n / rows.length) * 100);
    return { down: pct(c.down), seven: pct(c.seven), up: pct(c.up), n: rows.length };
  }, [lastResults]);

  const bet = (sel) => {
    if (!betting) return;
    setLastRound((r) => [...r, { sel, amount: chip }]);
    placeBet(sel, chip);
  };

  /* "again" repeats the last COMPLETED round, so the running list is only
     promoted once the round it belongs to has been settled. */
  const [prevRound, setPrevRound] = useState([]);
  useEffect(() => {
    if (phase === "BETTING" && lastRound.length) { setPrevRound(lastRound); setLastRound([]); }
  }, [state?.round_number]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Sequenced, not fired in a loop. placeBet guards against overlapping requests,
     so a synchronous forEach races that guard and can silently drop chips. */
  const repeatBets = async (list) => {
    for (const b of list) {
      if (!betting) break;
      // eslint-disable-next-line no-await-in-loop
      await placeBet(b.sel, b.amount);
    }
  };
  const rebet = () => betting && repeatBets(prevRound);
  const double = () => betting && repeatBets(myBets.map((b) => ({ sel: b.selection, amount: b.amount })));

  const Cell = ({ sel, children, className = "", testId }) => (
    <button
      type="button"
      data-testid={testId}
      onClick={() => bet(sel)}
      disabled={!betting}
      className={`relative flex flex-col items-center justify-center rounded-lg border transition
        ${betting ? "active:scale-[0.98] cursor-pointer" : "opacity-70 cursor-default"} ${className}`}
    >
      {children}
      {staked[sel] > 0 && (
        <span className="absolute right-1 bottom-1 min-w-[26px] rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-amber-300 ring-1 ring-amber-300/50">
          {formatChips(staked[sel])}
        </span>
      )}
    </button>
  );

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "ROLLING…" }}
      betDock={
        <div className="space-y-2" data-testid="dice-bet-dock">
          <div className="flex items-center justify-between text-[11px] text-white/60">
            <span>Balance <b className="tabular-nums text-white">{formatChips(balance ?? 0)}</b></span>
            <span>Your bet <b className="tabular-nums text-primary">{formatChips(myTotal)}</b></span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={rebet} disabled={!betting || !prevRound.length}
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold disabled:opacity-40" data-testid="dice-again">again</button>
            <div className="flex flex-1 items-center justify-center gap-1.5">
              {CHIPS.map((c) => (
                <button key={c} type="button" onClick={() => setChip(c)} data-testid={`dice-chip-${c}`}
                  className={`h-10 w-10 rounded-full border-4 border-dashed text-[10px] font-extrabold tabular-nums transition
                    ${chip === c ? "scale-110 ring-2 ring-primary" : "opacity-80"}`}
                  style={{ background: "#0f7a3d", borderColor: "rgba(255,255,255,.6)", color: "#fff" }}>
                  {c >= 1000 ? `${c / 1000}k` : c}
                </button>
              ))}
            </div>
            <button type="button" onClick={double} disabled={!betting || !myBets.length}
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold disabled:opacity-40" data-testid="dice-double">×2</button>
            <button type="button" onClick={clearBets} disabled={!betting || !myBets.length}
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold disabled:opacity-40" data-testid="dice-clear">clear</button>
          </div>
        </div>
      }
    >
      {/* how this table has actually been running */}
      {share && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-black/30 px-3 py-1.5 text-[11px]" data-testid="dice-share">
          <span className="font-bold text-emerald-400">2–6 {share.down}%</span>
          <span className="font-bold text-rose-400">8–12 {share.up}%</span>
          <span className="font-bold text-sky-400">7 {share.seven}%</span>
          <span className="text-white/45">from the last {share.n} rounds</span>
        </div>
      )}

      {/* roadmap: each past round as its total over the two faces that made it */}
      <div className="mt-2 flex gap-1 overflow-x-auto pb-1" data-testid="dice-roadmap">
        {(lastResults || []).slice(0, 14).map((r, i) => {
          const tone = totalTone(r.total);
          return (
            <div key={r.round_number ?? i} className="flex shrink-0 flex-col items-center gap-[2px]">
              <span className={`grid h-5 w-6 place-items-center rounded text-[11px] font-bold text-white ${tone.bg}`}>{r.total}</span>
              <span className="flex gap-[2px]">
                {(r.dice || []).map((d, k) => <MiniDie key={k} value={d} />)}
              </span>
            </div>
          );
        })}
      </div>

      {/* the dice themselves */}
      <div className="relative my-3 flex items-center justify-center gap-6 rounded-2xl bg-[radial-gradient(60%_70%_at_50%_35%,rgba(255,255,255,.10),transparent)] py-5">
        <Die value={dice[0]} rolling={rolling} variant={rollCfg[0].v} duration={rollCfg[0].d} />
        <Die value={dice[1]} rolling={rolling} variant={rollCfg[1].v} duration={rollCfg[1].d} />
        {showFinal && (
          <span className="absolute bottom-1 rounded-full bg-black/70 px-3 py-0.5 text-xs font-bold text-white" data-testid="dice-total">
            {outcome.total}
          </span>
        )}
        {!betting && (
          <div className="absolute inset-0 grid place-items-center rounded-2xl bg-black/55" data-testid="dice-locked">
            <span className="text-lg font-extrabold tracking-wide text-amber-300">Bet Locked</span>
          </div>
        )}
      </div>

      {/* the three main positions */}
      <div className="grid grid-cols-3 gap-2" data-testid="dice-sides">
        <Cell sel="down" testId="dice-side-down" className="h-24 border-emerald-400/40 bg-emerald-700/70">
          <span className="text-2xl font-black text-white/90">2–6</span>
          <span className="text-[11px] font-bold text-white/70">{oddsFor("down")}</span>
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-3xl font-black text-white/10">DOWN</span>
        </Cell>
        <Cell sel="seven" testId="dice-side-seven" className="h-24 border-sky-400/40 bg-sky-700/70">
          <span className="text-3xl font-black text-white/90">7</span>
          <span className="text-[11px] font-bold text-white/70">{oddsFor("seven")}</span>
        </Cell>
        <Cell sel="up" testId="dice-side-up" className="h-24 border-rose-400/40 bg-rose-700/70">
          <span className="text-2xl font-black text-white/90">8–12</span>
          <span className="text-[11px] font-bold text-white/70">{oddsFor("up")}</span>
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-3xl font-black text-white/10">UP</span>
        </Cell>
      </div>

      {/* every exact total */}
      <div className="mt-2 grid grid-cols-5 gap-1.5" data-testid="dice-totals">
        {[...TOTALS_TOP, ...TOTALS_BOTTOM].map((t) => (
          <Cell key={t} sel={`t${t}`} testId={`dice-total-${t}`}
            className="h-16 border-emerald-300/20 bg-emerald-900/50">
            <span className="text-xl font-black text-white/85">{t}</span>
            <span className="text-[10px] font-bold text-white/55">{oddsFor(`t${t}`)}</span>
          </Cell>
        ))}
      </div>

      <p className="mt-2 text-center text-[11px] text-white/45">
        A 7 beats both sides — Up and Down lose when the dice total 7. Every position pays the
        same 83.3% return, whichever you back.
      </p>

      <ResultBanner result={result} onClose={() => setResult(null)} />
    </GameStage>
  );
}
