import { useState, useEffect, useMemo } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W, CAB_H } from "@/components/play/arcade/Cabinet";
import { at, atMid, Plaque, TitleBoard, CabButton, ChipRail, Dial, Marquee, Paytable } from "@/components/play/arcade/parts";
import { NumberGrid } from "@/components/play/arcade/pieces";
import { DENOMINATIONS } from "@/pages/play/cabinet/StakeCabinet";

/**
 * Keno — the number board and the ball bowl.
 *
 * The reference draws eighty numbers; ours draws from thirty-six, because that
 * is the pool the engine samples and the paytable is priced against. Printing
 * eighty cells over a thirty-six-ball draw would put forty-four numbers on the
 * board that can never come up.
 *
 * The price list changes with how many numbers are marked — that is how keno
 * works, and the panel re-reads as each pick is made rather than showing one
 * fixed column.
 */
const GROUND = "radial-gradient(120% 100% at 50% 0%, #5a5a2a 0%, #2e2e12 45%, #0e0e04 100%)";
const POOL = Array.from({ length: 36 }, (_, i) => i + 1);
const MAX_PICKS = 10;

/* The engine's table, indexed by how many numbers are marked. Sent by the
   server for the current column; this mirrors its shape so the panel can
   re-price as the player picks without a round trip per tap. */
export default function KenoCabinet({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result,
          placeBet, clearBets, myBets, myTotal } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `${(s.detail?.matches || []).length} matches`,
      }),
    });

  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 100000;
  const chips = useMemo(() => DENOMINATIONS.filter((c) => c >= minBet && c <= maxBet), [minBet, maxBet]);
  const [chip, setChip] = useState(null);
  useEffect(() => { if (chips.length && (chip == null || !chips.includes(chip))) setChip(chips[0]); }, [chips, chip]);

  const [picks, setPicks] = useState([]);
  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const drawn = showFinal ? (outcome?.drawn || []) : [];

  /* A new round is a clean card. Keeping the marks across rounds looks like a
     standing bet, which this table does not take. */
  useEffect(() => { if (phase === "BETTING") setPicks([]); }, [state?.round_number]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (n) => {
    if (!betting) return;
    setPicks((p) => p.includes(n) ? p.filter((x) => x !== n) : (p.length >= MAX_PICKS ? p : [...p, n]));
  };

  const bet = () => { if (betting && chip && picks.length) placeBet(picks, chip); };

  const laid = myBets.length > 0;
  const message = (() => {
    if (phase === "REVEAL") return "Drawing…";
    if (phase === "RESULT" && outcome) {
      const won = result && result.payout > 0;
      return `Drawn: ${(outcome.drawn || []).join(" ")} — ${won ? `You won ${formatChips(result.payout)}` : "No win this time"}`;
    }
    if (!picks.length) return `Select up to ${MAX_PICKS} numbers, then press Bet. Minimum Bet = ${formatChips(minBet)}`;
    if (!laid) return `${picks.length} number${picks.length === 1 ? "" : "s"} marked — press Bet to play them.`;
    return `Your bet of ${formatChips(myTotal)} on ${picks.length} numbers has been accepted.`;
  })();

  return (
    <Cabinet ground={GROUND} exitTo={`/games/${game.slug}`} testId="cab-keno">
      <Plaque label="Score" value={balance === null ? "…" : formatChips(balance)}
              width={280} height={46} style={at(44, 24)} testId="cab-score" />
      <TitleBoard size={52} style={atMid(CAB_W, 400, 18)}>Keno</TitleBoard>
      <Plaque label="Winner" value={formatChips(result?.payout || 0)}
              width={280} height={46} style={at(CAB_W - 280 - 124, 24)} testId="cab-winner" />

      <Plaque label="Bet" value={formatChips(myTotal || 0)} width={200} height={40}
              labelSize={22} valueSize={20} style={at(44, 132)} testId="cab-bet" />
      <Dial seconds={betting ? countdown : 0} size={86} style={at(102, 218)} />

      <Paytable rows={(state?.paytable || []).slice(0, 11)} multiplier={chip || minBet} rowSize={18}
                style={{ ...at(40, 330, 380) }} testId="cab-paytable" />

      {/* the board: six rows of six, which is the pool the engine draws from */}
      <NumberGrid
        numbers={POOL} cols={6} cell={78} gap={8} picked={picks}
        disabled={!betting}
        onPick={toggle}
        style={{ ...at(CAB_W / 2 - (6 * 78 + 5 * 8) / 2 + 130, 120) }}
        testPrefix="cab-keno" />

      {/* the drawn balls */}
      <div style={{ ...at(CAB_W - 400, 132, 360), display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}
           data-testid="cab-drawn">
        <span className="cab-script" style={{ fontSize: 22, width: "100%" }}>Drawn</span>
        {(drawn.length ? drawn : Array.from({ length: 10 }, () => null)).map((n, i) => (
          <span key={i} style={{
            height: 58, width: 58, borderRadius: "50%", display: "grid", placeItems: "center",
            fontFamily: "ui-serif, Georgia, serif", fontWeight: 700, fontSize: 22,
            fontVariantNumeric: "tabular-nums",
            color: n ? (picks.includes(n) ? "#08202f" : "#2a1a02") : "rgba(255,255,255,.16)",
            background: n
              ? (picks.includes(n) ? "linear-gradient(180deg,#9fd8ff,#2f7fb8)" : "radial-gradient(circle at 36% 28%, #ffe9a0, #d9a83c)")
              : "rgba(255,255,255,.05)",
            border: "2px solid rgba(217,168,60,.5)",
          }}>{n || ""}</span>
        ))}
      </div>

      <ChipRail chips={chips} value={chip} onPick={setChip} size={56} gap={18}
                style={{ ...at(40, CAB_H - 176, 400) }} />

      <div style={{ ...at(40, CAB_H - 104, CAB_W - 80), display: "flex", gap: 22 }}>
        <CabButton onClick={() => setPicks([])} disabled={!betting || !picks.length} size={21}
                   style={{ height: 58, flex: 1 }} data-testid="cab-select">Clear Picks</CabButton>
        <CabButton onClick={clearBets} disabled={!betting || !myTotal} size={21}
                   style={{ height: 58, flex: 1 }} data-testid="cab-clear">Cancel Bet</CabButton>
        <CabButton onClick={bet} disabled={!betting || !chip || !picks.length} tone="armed" size={24}
                   style={{ height: 58, flex: 2 }} data-testid="cab-bet-button">
          Bet {chip ? formatChips(chip) : ""} on {picks.length}
        </CabButton>
      </div>

      <Marquee style={{ ...at(40, CAB_H - 40, CAB_W - 80, 32) }} size={19}>{message}</Marquee>
    </Cabinet>
  );
}
