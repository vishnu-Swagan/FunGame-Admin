import { useMemo, useState, useEffect, useRef } from "react";
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

/** A past round's die, drawn small for the roadmap. */
const MiniDie = ({ value }) => (
  <span className="grid grid-cols-3 gap-[1px] w-[17px] h-[17px] rounded-[2px] bg-white p-[2px]">
    {Array.from({ length: 9 }, (_, i) => (
      <span key={i} className={`rounded-full ${PIPS[value]?.includes(i) ? (value === 1 ? "bg-red-600" : "bg-neutral-900") : ""}`} />
    ))}
  </span>
);

const CHIPS = [10, 50, 100, 500, 1000];
const TOTALS = [[2, 3, 4, 5, 6], [8, 9, 10, 11, 12]];

/** Down green, seven blue, up red — the colours the roadmap and the felt share. */
const toneOf = (t) => (t === 7 ? "bg-sky-600" : t < 7 ? "bg-emerald-600" : "bg-rose-600");

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
  const [rollCfg, setRollCfg] = useState([{ v: false, d: "0.8s" }, { v: true, d: "0.9s" }]);
  /* The order chips were laid this round, so undo can take the last one back and
     "again" can repeat the round that just finished. */
  const placedRef = useRef([]);
  const [prevRound, setPrevRound] = useState([]);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    if (phase === "BETTING" && placedRef.current.length) {
      setPrevRound(placedRef.current);
      placedRef.current = [];
    }
  }, [state?.round_number]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Odds come from the server's own paytable, so the felt can never print a price
     the backend would not pay. */
  const options = state?.options || {};
  const oddsFor = (sel) => {
    const m = options[sel];
    if (!m) return "";
    const p = m - 1;
    return `1:${Number.isInteger(p) ? p : p.toFixed(1)}`;
  };

  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });

  const share = useMemo(() => {
    const rows = (lastResults || []).filter((r) => r.total != null);
    if (!rows.length) return null;
    const c = { down: 0, seven: 0, up: 0 };
    rows.forEach((r) => { c[r.total === 7 ? "seven" : r.total < 7 ? "down" : "up"] += 1; });
    const pct = (n) => Math.round((n / rows.length) * 100);
    return { down: pct(c.down), seven: pct(c.seven), up: pct(c.up), n: rows.length };
  }, [lastResults]);

  const lay = async (sel) => {
    if (!betting || busy) return;
    const res = await placeBet(sel, chip);
    if (res) placedRef.current.push({ sel, amount: chip });
  };

  const replay = async (list) => {
    setBusy(true);
    for (const b of list) {
      if (!betting) break;
      // eslint-disable-next-line no-await-in-loop
      const res = await placeBet(b.sel, b.amount);
      if (res) placedRef.current.push(b);
    }
    setBusy(false);
  };

  /* There is no per-bet undo on the live API — only a clear for the whole round.
     Undo is therefore the honest equivalent: drop everything, then lay the same
     chips back minus the last one. */
  const undo = async () => {
    if (!betting || busy || !placedRef.current.length) return;
    const keep = placedRef.current.slice(0, -1);
    setBusy(true);
    await clearBets();
    placedRef.current = [];
    setBusy(false);
    if (keep.length) await replay(keep);
  };

  const again = () => !busy && replay(prevRound);
  const double = () => !busy && replay(placedRef.current.slice());
  const clearAll = async () => { if (betting && !busy) { await clearBets(); placedRef.current = []; } };

  const Chip = ({ amount }) =>
    amount > 0 ? (
      <span className="sud-chip absolute right-1 bottom-1 h-6 min-w-[26px] px-1 text-[10px]">
        {formatChips(amount)}
      </span>
    ) : null;

  const Cell = ({ sel, className = "", testId, children }) => (
    <button
      type="button"
      data-testid={testId}
      onClick={() => lay(sel)}
      disabled={!betting || busy}
      className={`relative overflow-hidden rounded-[6px] border text-center transition ${betting ? "active:scale-[0.985]" : ""} ${className}`}
    >
      {children}
      <Chip amount={staked[sel]} />
    </button>
  );

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "ROLLING…" }}
      betDock={
        <div className="flex items-center gap-2" data-testid="dice-tray">
          <button type="button" onClick={again} disabled={!betting || busy || !prevRound.length}
            data-testid="dice-again"
            className="flex flex-col items-center gap-0.5 rounded-full px-2 py-1 text-[10px] font-bold text-white/85 disabled:opacity-35">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-black/30 text-base">⟳</span>
            again
          </button>
          <div className="flex flex-1 items-center justify-center gap-1.5">
            {CHIPS.map((c) => (
              <button key={c} type="button" onClick={() => setChip(c)} data-testid={`dice-chip-${c}`}
                aria-pressed={chip === c}
                className={`h-11 w-11 rounded-full border-[3px] border-dashed text-[11px] font-extrabold tabular-nums text-white transition
                  ${chip === c ? "scale-110 ring-2 ring-amber-300" : "opacity-75"}`}
                style={{ background: "radial-gradient(circle at 36% 28%, #22c268, #0d7a3f 70%)", borderColor: "rgba(255,255,255,.75)" }}>
                {c >= 1000 ? `${c / 1000}k` : c}
              </button>
            ))}
          </div>
          <button type="button" onClick={double} disabled={!betting || busy || !placedRef.current.length}
            data-testid="dice-double"
            className="flex flex-col items-center gap-0.5 px-1 text-[10px] font-bold text-white/85 disabled:opacity-35">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-black/30 text-xs font-black">×2</span>
            double
          </button>
          <button type="button" onClick={undo} disabled={!betting || busy || !placedRef.current.length}
            data-testid="dice-undo"
            className="flex flex-col items-center gap-0.5 px-1 text-[10px] font-bold text-white/85 disabled:opacity-35">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-black/30 text-base">↺</span>
            undo
          </button>
          <button type="button" onClick={clearAll} disabled={!betting || busy || !myBets.length}
            data-testid="dice-clear"
            className="flex flex-col items-center gap-0.5 px-1 text-[10px] font-bold text-white/85 disabled:opacity-35">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-rose-400/50 bg-rose-900/40 text-base text-rose-300">✕</span>
            clear
          </button>
        </div>
      }
    >
      <div className="sud" data-testid="dice-table">
        {/* how the table has actually been running */}
        <div className="sud-wood flex flex-wrap items-center gap-x-3 px-3 py-1.5 text-[11px] font-bold">
          {share ? (
            <>
              <span className="text-amber-200">2~6 <span className="text-amber-400">{share.down}%</span></span>
              <span className="text-amber-200">8~12 <span className="text-amber-400">{share.up}%</span></span>
              <span className="text-amber-200">7 <span className="text-amber-400">{share.seven}%</span></span>
              <span className="font-normal text-amber-100/60">Calculated from the last {share.n} rounds.</span>
            </>
          ) : (
            <span className="font-normal text-amber-100/60">Waiting for the first rounds…</span>
          )}
        </div>

        {/* roadmap: every round as its total over the faces that made it */}
        <div className="sud-wood flex gap-[3px] overflow-x-auto px-2 py-1.5" data-testid="dice-roadmap">
          {(lastResults || []).slice(0, 14).map((r, i) => (
            <div key={r.round_number ?? i}
              className={`flex shrink-0 flex-col items-center gap-[2px] rounded-[3px] p-[2px] ${i === 0 ? "ring-2 ring-amber-400" : ""}`}>
              <span className={`grid h-[18px] w-[22px] place-items-center rounded-[2px] text-[11px] font-black text-white ${toneOf(r.total)}`}>
                {r.total}
              </span>
              {(r.dice || []).map((d, k) => <MiniDie key={k} value={d} />)}
            </div>
          ))}
        </div>

        {/* the dice, under the glass */}
        <div className="relative flex items-center justify-center py-2">
          <div className="fg-dome" data-testid="dice-dome">
            <div className="fg-dome-dish" />
            <div className="fg-dome-stage">
              <Die value={dice[0]} rolling={rolling} variant={rollCfg[0].v} duration={rollCfg[0].d} />
              <Die value={dice[1]} rolling={rolling} variant={rollCfg[1].v} duration={rollCfg[1].d} />
            </div>
            <div className="fg-dome-glass" />
            <div className="fg-dome-collar" />
          </div>
          {betting && countdown > 0 && (
            <span data-testid="dice-countdown"
              className={`absolute right-3 top-1/2 grid h-14 w-14 -translate-y-1/2 place-items-center rounded-full border-[3px] text-2xl font-black tabular-nums
                ${countdown <= 3 ? "border-rose-400 text-rose-300" : "border-amber-400 text-amber-300"}`}>
              {Math.ceil(countdown)}
            </span>
          )}
        </div>

        {/* table limits */}
        <div className="sud-wood flex items-center gap-3 px-3 py-1 text-[11px] font-bold text-amber-100/85">
          <span>Roadmap</span>
          <span className="ml-auto">Min <span className="text-amber-300">{formatChips(10)}</span></span>
          <span>Max <span className="text-amber-300">{formatChips(10000)}</span></span>
        </div>

        {/* the board */}
        <div className={`relative p-2 ${betting ? "" : "sud-locked"}`}>
          <div className="grid grid-cols-3 gap-1.5" data-testid="dice-sides">
            <Cell sel="down" testId="dice-side-down"
              className="h-[104px] border-emerald-300/50 bg-gradient-to-b from-emerald-500 to-emerald-700">
              <span className="pointer-events-none absolute inset-x-0 bottom-0 text-center sud-mark text-[40px] leading-[1.05]">DOWN</span>
              <span className="relative block pt-4 sud-num text-[30px] leading-none">2-6</span>
              <span className="relative mt-1 block text-[13px] font-bold text-white/85">{oddsFor("down")}</span>
            </Cell>
            <Cell sel="seven" testId="dice-side-seven"
              className="h-[104px] border-sky-300/50 bg-gradient-to-b from-sky-500 to-sky-700">
              <span className="relative block pt-3 sud-num text-[42px] leading-none">7</span>
              <span className="relative mt-1 block text-[13px] font-bold text-white/85">{oddsFor("seven")}</span>
            </Cell>
            <Cell sel="up" testId="dice-side-up"
              className="h-[104px] border-rose-300/50 bg-gradient-to-b from-rose-500 to-rose-700">
              <span className="pointer-events-none absolute inset-x-0 bottom-0 text-center sud-mark text-[40px] leading-[1.05]">UP</span>
              <span className="relative block pt-4 sud-num text-[30px] leading-none">8-12</span>
              <span className="relative mt-1 block text-[13px] font-bold text-white/85">{oddsFor("up")}</span>
            </Cell>
          </div>

          {TOTALS.map((row, ri) => (
            <div key={ri} className="mt-1.5 grid grid-cols-5 gap-1.5" data-testid={`dice-totals-${ri}`}>
              {row.map((t) => (
                <Cell key={t} sel={`t${t}`} testId={`dice-total-${t}`}
                  className="h-[86px] border-emerald-200/25 bg-emerald-800/60">
                  <span className="block pt-3 sud-num text-[26px] leading-none">{t}</span>
                  <span className="mt-1 block text-[12px] font-bold text-white/70">{oddsFor(`t${t}`)}</span>
                </Cell>
              ))}
            </div>
          ))}

          {!betting && (
            <div className="absolute inset-0 grid place-items-center" data-testid="dice-locked">
              <span className="rounded-md bg-black/55 px-7 py-2 text-2xl font-black tracking-wide text-amber-300"
                    style={{ textShadow: "0 2px 6px rgba(0,0,0,.8)" }}>
                Bet Locked
              </span>
            </div>
          )}
        </div>

        {/* the money line */}
        <div className="flex items-center justify-center gap-8 px-3 pb-2 text-[13px] font-bold text-white/80">
          <span>Balance <span className="tabular-nums text-amber-300">{formatChips(balance ?? 0)}</span></span>
          <span>Your Bet <span className="tabular-nums text-amber-300">{formatChips(myTotal)}</span></span>
        </div>
      </div>

      <ResultBanner result={result} onClose={() => setResult(null)} />
    </GameStage>
  );
}
