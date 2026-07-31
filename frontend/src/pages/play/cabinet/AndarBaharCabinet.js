import { useState, useEffect, useMemo } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W, CAB_H } from "@/components/play/arcade/Cabinet";
import { at, atMid, Plaque, TitleBoard, CabButton, ChipRail, Dial, Marquee, Card } from "@/components/play/arcade/parts";
import { DENOMINATIONS } from "@/pages/play/cabinet/StakeCabinet";

/**
 * Fun AB — Andar Bahar, on the blue felt.
 *
 * The reference lays a full spade suit across the top, three side-bet rails
 * under it, then the two boxes with the joker between them and the dealt run
 * along the bottom. The rails on the original take bets our engine does not
 * settle — suit, colour pair, and the A–6 / 7 / 8–K bands — so they are drawn
 * as the reference has them but marked as the round's own information rather
 * than as controls. A control that looks live and refuses the bet is worse than
 * no control; showing the joker's rank band as it lands is what the strip is
 * actually useful for.
 */
const GROUND = "radial-gradient(120% 100% at 50% 0%, #1a4f9e 0%, #0b2a63 45%, #04122e 100%)";
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const parseCard = (s) => {
  if (!s) return null;
  const str = String(s);
  return { rank: str.slice(0, -1), suit: str.slice(-1).toLowerCase() };
};

export default function AndarBaharCabinet({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result,
          placeBet, clearBets, myBets, myTotal } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `${String(s.outcome.winner).toUpperCase()} took it`,
      }),
    });

  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 100000;
  const chips = useMemo(() => DENOMINATIONS.filter((c) => c >= minBet && c <= maxBet), [minBet, maxBet]);
  const [chip, setChip] = useState(null);
  useEffect(() => { if (chips.length && (chip == null || !chips.includes(chip))) setChip(chips[0]); }, [chips, chip]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });

  const joker = showFinal ? parseCard(outcome?.joker) : null;
  const run = showFinal ? (outcome?.sequence || []) : [];
  const options = state?.options || {};

  const lay = (sel) => { if (betting && chip) placeBet(sel, chip); };

  const message = (() => {
    if (phase === "REVEAL") return "Dealing…";
    if (phase === "RESULT" && outcome) {
      const won = result && result.payout > 0;
      return `${String(outcome.winner).toUpperCase()} wins. ${won ? `You won ${formatChips(result.payout)}` : "Game over. Press Bet Ok or Make Bet."}`;
    }
    if (!myTotal) return `Please Bet to Start Game. Minimum Bet = ${formatChips(minBet)}`;
    return `Your bet of ${formatChips(myTotal)} has been accepted.`;
  })();

  const Box = ({ sel, label }) => {
    const on = staked[sel] > 0;
    const won = showFinal && outcome?.winner === sel;
    return (
      <button type="button" onClick={() => lay(sel)} disabled={!betting} data-testid={`cab-${sel}`}
        style={{
          width: 300, height: 210, borderRadius: 12, position: "relative",
          border: `3px solid ${won ? "#7bf59b" : on ? "#ffeaa0" : "rgba(217,168,60,.6)"}`,
          background: won ? "rgba(60,220,120,.14)" : "rgba(4,18,46,.55)",
          boxShadow: won ? "0 0 30px rgba(60,235,130,.5)" : "inset 0 0 30px rgba(0,0,0,.6)",
          display: "grid", placeItems: "center", opacity: betting || showFinal ? 1 : 0.7,
        }}>
        <span className="cab-script" style={{ fontSize: 34 }}>{label}</span>
        <span style={{ position: "absolute", bottom: 10, fontSize: 17, color: "#cfe0ff" }}>
          pays {(options[sel] || 0).toFixed(2)}x
        </span>
        {on && (
          <span style={{ position: "absolute", top: 10, right: 10, background: "linear-gradient(180deg,#ffe38f,#d9a83c)",
                         color: "#0a0913", borderRadius: 999, padding: "2px 12px", fontWeight: 800, fontSize: 17 }}>
            {formatChips(staked[sel])}
          </span>
        )}
      </button>
    );
  };

  return (
    <Cabinet ground={GROUND} exitTo={`/games/${game.slug}`} testId="cab-andar-bahar">
      <Plaque label="Score" value={balance === null ? "…" : formatChips(balance)}
              width={280} height={46} style={at(44, 24)} testId="cab-score" />
      <TitleBoard size={52} style={atMid(CAB_W, 420, 18)}>Fun AB</TitleBoard>
      <Plaque label="Winner" value={formatChips(result?.payout || 0)}
              width={280} height={46} style={at(CAB_W - 280 - 124, 24)} testId="cab-winner" />

      {/* the suit across the top, as the reference draws it */}
      <div style={{ ...at(0, 108, CAB_W), display: "flex", justifyContent: "center", gap: 8 }}>
        {RANKS.map((r) => (
          <div key={r} style={{
            width: 84, height: 100, borderRadius: 6, background: "linear-gradient(180deg,#fff,#e8ecf4)",
            border: "1px solid #b9b9c6", display: "grid", placeItems: "center", position: "relative",
            fontFamily: "ui-serif, Georgia, serif", fontWeight: 700,
            outline: joker && joker.rank === r ? "3px solid #ffd54a" : "none",
          }}>
            <span style={{ position: "absolute", top: 4, left: 6, fontSize: 20, color: "#14141c" }}>{r}</span>
            <span style={{ fontSize: 34, color: "#14141c" }}>♠</span>
          </div>
        ))}
      </div>

      {/* the round's own information: which band the joker fell in */}
      <div style={{ ...at(0, 226, CAB_W), display: "flex", justifyContent: "center", gap: 20 }}>
        {["A To 6", "7", "8 To K"].map((b) => {
          const idx = joker ? RANKS.indexOf(joker.rank) : -1;
          const hit = idx >= 0 && ((b === "A To 6" && idx < 6) || (b === "7" && idx === 6) || (b === "8 To K" && idx > 6));
          return (
            <span key={b} style={{
              padding: "8px 34px", borderRadius: 999, fontFamily: "ui-serif, Georgia, serif", fontSize: 22,
              color: hit ? "#08202f" : "#cfe0ff",
              background: hit ? "linear-gradient(180deg,#9fd8ff,#2f7fb8)" : "rgba(4,18,46,.6)",
              border: "2px solid rgba(217,168,60,.5)",
            }}>{b}</span>
          );
        })}
      </div>

      <Dial seconds={betting ? countdown : 0} size={92} style={atMid(CAB_W, 92, 300)} />

      {/* the two boxes, with the joker between them */}
      <div style={{ ...at(0, 410, CAB_W), display: "flex", justifyContent: "center", alignItems: "center", gap: 60 }}>
        <Box sel="andar" label="Andar" />
        <div style={{ display: "grid", placeItems: "center", gap: 8 }}>
          <Card card={joker} w={132} h={186} />
          <span className="cab-script" style={{ fontSize: 20 }}>Joker</span>
        </div>
        <Box sel="bahar" label="Bahar" />
      </div>

      {/* the dealt run along the bottom */}
      <div className="cab-rail" style={{ ...atMid(CAB_W, 700, 636, 92), gap: 10, justifyContent: "center", padding: "0 14px" }}
           data-testid="cab-run">
        {(run.length ? run.slice(0, 9) : Array.from({ length: 9 })).map((c, i) => (
          <Card key={i} card={parseCard(c)} w={54} h={76} />
        ))}
      </div>

      <ChipRail chips={chips} value={chip} onPick={setChip} size={54} gap={16}
                style={{ ...at(40, 640, 380) }} />
      <CabButton onClick={clearBets} disabled={!betting || !myTotal} size={20}
                 style={{ ...at(CAB_W - 300, 640, 260, 56) }} data-testid="cab-clear">
        Cancel Bet
      </CabButton>

      <Marquee style={{ ...at(40, CAB_H - 38, CAB_W - 80, 32) }} size={19}>{message}</Marquee>
    </Cabinet>
  );
}
