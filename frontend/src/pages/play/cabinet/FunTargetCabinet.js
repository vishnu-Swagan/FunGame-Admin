import { useState, useEffect, useMemo } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W, CAB_H } from "@/components/play/arcade/Cabinet";
import { at, atMid, Plaque, TitleBoard, CabButton, ChipRail, Marquee } from "@/components/play/arcade/parts";
import { Wheel, NumberGrid, LastResults } from "@/components/play/arcade/pieces";
import { DENOMINATIONS } from "@/pages/play/cabinet/StakeCabinet";

/**
 * Fun Target — the ten-segment wheel over the treasure.
 *
 * The reference puts the clock and the last ten results either side of the
 * wheel and the ten numbers in a row along the bottom, each with its own bet
 * slot. That is the whole game: pick digits, watch the wheel, one of them pays.
 *
 * The wheel is turned to the digit the server already picked. The outcome
 * exists before the spin does, so an animation that landed anywhere else would
 * be telling the player something untrue for three seconds.
 */
const GROUND = "radial-gradient(120% 100% at 50% 8%, #6b4a12 0%, #3a2708 45%, #120b02 100%)";
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

export default function FunTargetCabinet({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result,
          placeBet, clearBets, myBets, myTotal, lastResults } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `Landed on ${s.outcome.result}`,
      }),
    });

  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 100000;
  const chips = useMemo(() => DENOMINATIONS.filter((c) => c >= minBet && c <= maxBet), [minBet, maxBet]);
  const [chip, setChip] = useState(null);
  useEffect(() => { if (chips.length && (chip == null || !chips.includes(chip))) setChip(chips[0]); }, [chips, chip]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const revealing = phase === "REVEAL" && !showFinal;

  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });

  const labels = DIGITS.map(String);
  const idx = showFinal && outcome ? labels.indexOf(String(outcome.result)) : 0;
  const angle = revealing ? 360 * 5 : 360 * 5 + (360 - (idx + 0.5) * 36);

  const price = (state?.paytable || [])[0];
  const pays = price ? price[1] : 7;

  const message = (() => {
    if (phase === "REVEAL") return "Bet Time Over.";
    if (phase === "RESULT" && outcome) {
      const won = result && result.payout > 0;
      return `Landed on ${outcome.result}. ${won ? `You won ${formatChips(result.payout)}` : "No winnings this round."}`;
    }
    if (!myTotal) return `Please Bet to Start Game. Minimum Bet = ${formatChips(minBet)}`;
    return `Total bet ${formatChips(myTotal)} — pays ${pays}x on the exact number.`;
  })();

  return (
    <Cabinet ground={GROUND} exitTo={`/games/${game.slug}`} testId="cab-fun-target">
      <Plaque label="Score" value={balance === null ? "…" : formatChips(balance)}
              width={300} height={46} style={at(44, 24)} testId="cab-score" />
      <TitleBoard size={50} style={atMid(CAB_W, 420, 16)}>Fun Target</TitleBoard>
      <Plaque label="Winner" value={formatChips(result?.payout || 0)}
              width={300} height={46} style={at(CAB_W - 300 - 124, 24)} testId="cab-winner" />

      <Plaque label="Time" value={`0:${String(Math.max(0, Math.ceil(betting ? countdown : 0))).padStart(2, "0")}`}
              width={220} height={44} style={at(44, 150)} testId="cab-time" />

      <div style={{ ...at(CAB_W - 460, 156, 420) }}>
        <span className="cab-script" style={{ fontSize: 24 }}>Last 10 Data</span>
        <LastResults values={(lastResults || []).slice(0, 10).map((r) => r.result ?? "-")} style={{ marginTop: 6 }} />
      </div>

      <div style={{ ...atMid(CAB_W, 330, 132) }}>
        <Wheel labels={labels} size={330} angle={angle} spinning={revealing || showFinal} />
      </div>

      {/* the ten numbers, each carrying its own money */}
      <NumberGrid
        numbers={DIGITS} cols={10} cell={92} gap={14} staked={staked}
        disabled={!betting} onPick={(n) => betting && chip && placeBet(n, chip)}
        style={{ ...atMid(CAB_W, 10 * 92 + 9 * 14, 500) }} testPrefix="cab-target" />

      <ChipRail chips={chips} value={chip} onPick={setChip} size={58} gap={20}
                style={{ ...atMid(CAB_W, 560, CAB_H - 168) }} />

      <div style={{ ...at(40, CAB_H - 96, CAB_W - 80), display: "flex", gap: 22 }}>
        <CabButton onClick={clearBets} disabled={!betting || !myTotal} size={22}
                   style={{ height: 54, flex: 1 }} data-testid="cab-clear">Cancel Bet</CabButton>
        <CabButton tone="take" size={22} disabled style={{ height: 54, flex: 1 }}>
          Total Bet {formatChips(myTotal || 0)}
        </CabButton>
      </div>

      <Marquee style={{ ...at(40, CAB_H - 36, CAB_W - 80, 30) }} size={19}>{message}</Marquee>
    </Cabinet>
  );
}
