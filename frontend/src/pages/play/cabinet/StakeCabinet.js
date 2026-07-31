import { useState, useEffect, useMemo } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W, CAB_H } from "@/components/play/arcade/Cabinet";
import { at, atMid, Plaque, TitleBoard, CabButton, ChipRail, Dial, Marquee, Paytable } from "@/components/play/arcade/parts";

/**
 * The shell every stake-only cabinet shares.
 *
 * Eight of the client's machines are the same game underneath: choose a
 * denomination, press Bet, watch the round resolve, get paid by a multiplier.
 * What differs is the price list and what happens in the middle — cards, reels,
 * a wheel. Writing that shell once means those eight screens are each a
 * paytable and a centrepiece rather than eight copies of the same plumbing,
 * and a fix to the betting flow is a fix to all of them.
 *
 * `render` receives the round's live state and draws the middle. Everything
 * around it — the plaques, the dial, the chips, the message rail — is identical
 * across the machines, which is exactly how the originals feel.
 */
export const DENOMINATIONS = [1, 5, 10, 50, 100, 500, 1000, 5000];

export default function StakeCabinet({
  game,
  title,
  ground,
  render,                 // ({ state, outcome, phase, revealing, showFinal }) => node
  paytableSide = "left",  // which side the price list hangs on
  paytableWidth = 430,
  extraButtons,
  centreTop = 300,        // where the centrepiece starts
  formatResult,
  messageFor,             // optional per-game override of the message rail
}) {
  const { state, countdown, balance, betting, phase, outcome, result, placeBet, clearBets, myTotal } =
    useLiveRound(game.slug, { formatResult });

  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 100000;
  const chips = useMemo(
    () => DENOMINATIONS.filter((c) => c >= minBet && c <= maxBet),
    [minBet, maxBet]);

  const [chip, setChip] = useState(null);
  useEffect(() => {
    if (!chips.length) return;
    if (chip == null || !chips.includes(chip)) setChip(chips[0]);
  }, [chips, chip]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const revealing = phase === "REVEAL" && !showFinal;

  /* The price list is the server's, and it rescales with the chip in hand —
     which is the behaviour that makes these panels worth the space they take. */
  const rows = state?.paytable || [];
  const stakeUnit = myTotal || chip || minBet;

  const bet = () => { if (betting && chip) placeBet(null, chip); };

  const message = (() => {
    if (messageFor) {
      const m = messageFor({ state, outcome, phase, result, myTotal });
      if (m) return m;
    }
    if (phase === "REVEAL") return "Round in progress…";
    if (phase === "RESULT" && outcome) {
      const won = result && result.payout > 0;
      const label = outcome.label || outcome.hand;
      return `${label ? label + ". " : ""}${won ? `You won ${formatChips(result.payout)}` : "You Lost! Try Again"}`;
    }
    if (!myTotal) return `Please Bet to Start Game. Minimum Bet = ${formatChips(minBet)} and Maximum Bet = ${formatChips(maxBet)}`;
    return `Your bet of ${formatChips(myTotal)} has been accepted.`;
  })();

  const panelX = paytableSide === "left" ? 40 : CAB_W - paytableWidth - 40;

  return (
    <Cabinet ground={ground} exitTo={`/games/${game.slug}`} testId={`cab-${game.slug}`}>
      <Plaque label="Score" value={balance === null ? "…" : formatChips(balance)}
              width={280} height={46} style={at(44, 24)} testId="cab-score" />
      <TitleBoard size={50} style={atMid(CAB_W, 620, 18)}>{title}</TitleBoard>
      <Plaque label="Winner" value={formatChips(result?.payout || 0)}
              width={280} height={46} style={at(CAB_W - 280 - 124, 24)} testId="cab-winner" />

      <Plaque label="Bet" value={formatChips(myTotal || 0)} width={190} height={38}
              labelSize={22} valueSize={20} style={at(panelX === 40 ? CAB_W - 250 : 60, 118)} testId="cab-bet" />
      <Dial seconds={betting ? countdown : 0} size={86}
            style={at(panelX === 40 ? CAB_W - 200 : 110, 186)} />

      {/* the price list, as the machines print it */}
      {rows.length > 0 && (
        <Paytable rows={rows.slice(0, 14)} multiplier={stakeUnit} rowSize={rows.length > 10 ? 17 : 21}
                  style={{ ...at(panelX, 120, paytableWidth) }} testId="cab-paytable" />
      )}

      {/* Whatever this machine does in the middle, in the room the price list
          leaves it. Centring on the whole canvas put the card rail on top of the
          panel's right edge — the centre of the screen is not the centre of the
          space that is free. */}
      <div style={{
        ...at(paytableSide === "left" ? panelX + paytableWidth + 40 : 40, centreTop,
              CAB_W - paytableWidth - 120),
        display: "flex", justifyContent: "center",
      }}>
        {render({ state, outcome, phase, revealing, showFinal, stakeUnit })}
      </div>

      <ChipRail chips={chips} value={chip} onPick={setChip} size={58} gap={20}
                style={{ ...atMid(CAB_W, 560, CAB_H - 174) }} />

      <div style={{ ...at(40, CAB_H - 108, CAB_W - 80), display: "flex", gap: 22 }}>
        {extraButtons}
        <CabButton onClick={clearBets} disabled={!betting || !myTotal} size={22} style={{ height: 60, flex: 1 }}
                   data-testid="cab-clear">
          Cancel
        </CabButton>
        <CabButton onClick={bet} disabled={!betting || !chip} tone="armed" size={26}
                   style={{ height: 60, flex: 2 }} data-testid="cab-bet-button">
          Bet {chip ? formatChips(chip) : ""}
        </CabButton>
      </div>

      <Marquee style={{ ...at(40, CAB_H - 42, CAB_W - 80, 34) }} size={20}>{message}</Marquee>
    </Cabinet>
  );
}
