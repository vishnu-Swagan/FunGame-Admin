import { useState, useEffect, useMemo } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W, CAB_H } from "@/components/play/arcade/Cabinet";
import { at, atMid, Plaque, TitleBoard, CabButton, ChipRail, Dial, Marquee } from "@/components/play/arcade/parts";
import { StarStrip } from "@/components/play/arcade/pieces";

/**
 * Checker — gold against steel, on the orange board.
 *
 * The reference fills its board with a grid of 1-1 to 5-5 slots. Ours settles
 * one question: which colour captured more pieces. So the board shows the
 * rounds it took to get there — the thing the grid on the original is standing
 * in for — and the two colours are the bets, priced from the server.
 *
 * Building the 5x5 grid anyway would mean twenty-five slots that take no bet.
 */
const GROUND = "radial-gradient(120% 100% at 50% 6%, #c8801c 0%, #8a5410 42%, #2a1704 100%)";

export default function CheckerCabinet({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result,
          placeBet, clearBets, myBets, myTotal } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `${String(s.outcome.winner).toUpperCase()} captured more`,
      }),
    });

  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 100000;
  const chips = useMemo(() => DENOMS.filter((c) => c >= minBet && c <= maxBet), [minBet, maxBet]);
  const [chip, setChip] = useState(null);
  useEffect(() => { if (chips.length && (chip == null || !chips.includes(chip))) setChip(chips[0]); }, [chips, chip]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });
  const options = state?.options || {};
  const rounds = showFinal ? (outcome?.rounds || []) : [];

  const message = (() => {
    if (phase === "REVEAL") return "Playing out…";
    if (phase === "RESULT" && outcome) {
      const won = result && result.payout > 0;
      return `Gold ${outcome.gold} — Steel ${outcome.steel}. ${String(outcome.winner).toUpperCase()} wins. ${won ? `You won ${formatChips(result.payout)}` : "Try again."}`;
    }
    if (!myTotal) return `Your minimum bet is ${formatChips(minBet)}`;
    return `Your bet of ${formatChips(myTotal)} has been accepted.`;
  })();

  const Side = ({ sel, label, swatch }) => {
    const on = staked[sel] > 0;
    const won = showFinal && outcome?.winner === sel;
    return (
      <button type="button" onClick={() => betting && chip && placeBet(sel, chip)} disabled={!betting}
        data-testid={`cab-${sel}`}
        style={{
          width: 420, height: 190, borderRadius: 14, position: "relative", display: "grid", placeItems: "center",
          border: `3px solid ${won ? "#7bf59b" : on ? "#ffeaa0" : "rgba(255,255,255,.35)"}`,
          background: won ? "rgba(60,220,120,.18)" : "rgba(0,0,0,.35)",
          boxShadow: won ? "0 0 30px rgba(60,235,130,.5)" : "inset 0 0 26px rgba(0,0,0,.6)",
          opacity: betting || showFinal ? 1 : 0.75,
        }}>
        <span style={{ width: 76, height: 76, borderRadius: "50%", background: swatch,
                       border: "3px solid rgba(0,0,0,.45)", boxShadow: "inset 0 4px 10px rgba(255,255,255,.35)" }} />
        <span className="cab-script" style={{ fontSize: 32, marginTop: 8 }}>{label}</span>
        <span style={{ position: "absolute", bottom: 10, fontSize: 17, color: "#ffe9c0" }}>
          pays {(options[sel] || 0).toFixed(2)}x
        </span>
        {on && (
          <span style={{ position: "absolute", top: 10, right: 12, background: "linear-gradient(180deg,#ffe38f,#d9a83c)",
                         color: "#0a0913", borderRadius: 999, padding: "2px 12px", fontWeight: 800, fontSize: 17 }}>
            {formatChips(staked[sel])}
          </span>
        )}
      </button>
    );
  };

  return (
    <Cabinet ground={GROUND} exitTo={`/games/${game.slug}`} testId="cab-checker">
      <Plaque label="Score" value={balance === null ? "…" : formatChips(balance)}
              width={280} height={46} style={at(44, 24)} testId="cab-score" />
      <TitleBoard size={54} style={atMid(CAB_W, 400, 16)}>Checker</TitleBoard>
      <Plaque label="Winner" value={formatChips(result?.payout || 0)}
              width={280} height={46} style={at(CAB_W - 280 - 124, 24)} testId="cab-winner" />

      <StarStrip count={11} lit={showFinal ? 11 : 0} size={30} style={{ ...atMid(CAB_W, 560, 122) }} />
      <Dial seconds={betting ? countdown : 0} size={92} style={atMid(CAB_W, 92, 168)} />

      <div style={{ ...at(0, 288, CAB_W), display: "flex", justifyContent: "center", gap: 90 }}>
        <Side sel="gold" label="Gold" swatch="radial-gradient(circle at 34% 28%, #ffe9a0, #b8860b)" />
        <Side sel="steel" label="Steel" swatch="radial-gradient(circle at 34% 28%, #eef2f8, #7a8794)" />
      </div>

      {/* how the round actually went — the capture run, round by round */}
      <div className="cab-rail" style={{ ...atMid(CAB_W, 940, 500, 78), gap: 8, justifyContent: "center" }}
           data-testid="cab-rounds">
        {(rounds.length ? rounds.slice(0, 14) : Array.from({ length: 14 })).map((r, i) => (
          <span key={i} style={{
            width: 46, height: 46, borderRadius: "50%",
            background: !r ? "rgba(255,255,255,.06)"
              : (r.winner || r) === "gold"
                ? "radial-gradient(circle at 34% 28%, #ffe9a0, #b8860b)"
                : "radial-gradient(circle at 34% 28%, #eef2f8, #7a8794)",
            border: "2px solid rgba(0,0,0,.4)",
          }} />
        ))}
      </div>

      <ChipRail chips={chips} value={chip} onPick={setChip} size={58} gap={20}
                style={{ ...atMid(CAB_W, 560, CAB_H - 166) }} />

      <div style={{ ...at(40, CAB_H - 94, CAB_W - 80), display: "flex", gap: 22 }}>
        <CabButton onClick={clearBets} disabled={!betting || !myTotal} size={22}
                   style={{ height: 54, flex: 1 }} data-testid="cab-clear">Take Bet Off</CabButton>
        <CabButton tone="take" size={22} disabled style={{ height: 54, flex: 1 }}>
          Total Bet {formatChips(myTotal || 0)}
        </CabButton>
      </div>

      <Marquee style={{ ...at(40, CAB_H - 36, CAB_W - 80, 30) }} size={19}>{message}</Marquee>
    </Cabinet>
  );
}

const DENOMS = [1, 5, 10, 50, 100, 500, 1000, 5000];
