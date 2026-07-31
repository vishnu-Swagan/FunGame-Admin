import { useState, useEffect, useMemo } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W } from "@/components/play/arcade/Cabinet";
import { at, atMid, Filigree } from "@/components/play/arcade/parts";
import "./sevenUpDown.css";

/**
 * 7Up 7Down, laid out as the client's machine.
 *
 * Header: the gold cartouche between the Score and Winner plaques, the Bet
 * plaque and the LED dial beneath it, then the six denomination chips on their
 * rail. Down each side, the fourteen-row price list. Across the middle, the ten
 * dealt cards on a gold rail; under them the ten positions in the red and gold
 * frame. Along the bottom, 7 up / Take / 7 down, then the message rail.
 *
 * Both panels multiply by the staked chip exactly as the machine does — one
 * chip shows 2,000 against Super FunGame, five shows 10,000, six shows 12,000.
 */

const CHIPS = [1, 5, 50, 100, 500, 1000];

/* The machine's price list, at one chip. */
const LEFT_ROWS = [
  ["Super FunGame", 2000], ["FunGame", 1000], ["Royal Flush(DOUBLE)", 1000],
  ["Royal Flush", 500], ["Straight Flush (DOUBLE)", 450], ["Four of a Kind (DOUBLE)", 300],
  ["5 of a Kind", 200], ["Straight Flush", 150], ["4 of a Kind", 100],
  ["5 Jacks or Better", 100], ["Full House (10 CARDS)", 50], ["5 Pairs", 50],
  ["3 of a Kind(TRIPLE)", 30], ["4 Jacks or Better", 30],
];

const RIGHT_ROWS = [
  ["Flush (10 CARDS)", 25], ["Straight (10 CARDS)", 15], ["Straight (DOUBLE)", 15],
  ["Flush 2 (5 CARDS)", 15], ["4 Pair", 15], ["3 of a Kind(DOUBLE)", 10],
  ["3 Jacks or Better", 10], ["Flush (5 CARDS)", 7], ["Straight (5 CARDS)", 5],
  ["3 Pair", 5], ["3 of a Kind (Single)", 3], ["2 Jacks or Better", 3],
  ["2 Pair", 2], ["Jacks or Better", 1],
];

const SUITS = { s: ["♠", "#101018"], c: ["♣", "#101018"], h: ["♥", "#c8102e"], d: ["♦", "#c8102e"] };
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

/* The strip along the middle: small cards, rank upright at the top left and
   inverted at the bottom right, exactly as the machine prints them. */
const StripCard = ({ rank, suit }) => {
  const [glyph, colour] = SUITS[suit] || SUITS.s;
  return (
    <div className="sud-strip-card">
      <span className="sud-strip-tl" style={{ color: colour }}>{rank}<i>{glyph}</i></span>
      <span className="sud-strip-br" style={{ color: colour }}>{rank}<i>{glyph}</i></span>
    </div>
  );
};

const FaceDown = () => <div className="sud-back" />;

const FaceUp = ({ rank, suit }) => {
  const [glyph, colour] = SUITS[suit] || SUITS.s;
  return (
    <div className="sud-face">
      <span className="sud-face-tl" style={{ color: colour }}>{rank}</span>
      <span className="sud-face-pip" style={{ color: colour }}>{glyph}</span>
      <span className="sud-face-br" style={{ color: colour }}>{rank}</span>
    </div>
  );
};

export default function SevenUpDownCabinet({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result,
          placeBet, clearBets, myBets, myTotal, lastResults } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `${s.outcome.dice[0]} + ${s.outcome.dice[1]} = ${s.outcome.total}`,
      }),
    });

  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 1000;
  const chips = useMemo(() => CHIPS.filter((c) => c >= minBet && c <= maxBet), [minBet, maxBet]);
  const [chip, setChip] = useState(null);
  useEffect(() => { if (chips.length && (chip == null || !chips.includes(chip))) setChip(chips[0]); }, [chips, chip]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });

  /* The strip keeps the last ten rounds, which is what the machine leaves
     there between deals. */
  const strip = useMemo(() => {
    const suits = ["s", "h", "d", "c"];
    return (lastResults || []).slice(0, 10).map((r, i) => ({
      rank: RANKS[Math.max(0, Math.min(RANKS.length - 1, (r.total ?? 7) - 2))],
      suit: suits[i % suits.length],
    }));
  }, [lastResults]);

  const revealed = showFinal && outcome
    ? { rank: RANKS[Math.max(0, Math.min(RANKS.length - 1, outcome.total - 2))],
        suit: outcome.total > 7 ? "s" : "h" }
    : null;

  const stake = myTotal || chip || 1;

  const message = (() => {
    if (phase === "REVEAL") return "Please wait... Round is in progress";
    if (phase === "RESULT" && outcome) {
      return result && result.payout > 0
        ? `You Won ${formatChips(result.payout)} — please take your winning amount`
        : "You Lost! Try Again - Please wait... Round is in progress";
    }
    if (myTotal) return `Your Bet on '${staked.up ? "7Up" : "7Down"}' has been Accepted.`;
    return `Please Bet to Start Game. Minimum Bet = ${formatChips(minBet)} and Maximum Bet = ${formatChips(maxBet)}`;
  })();

  const lay = (sel) => { if (betting && chip) placeBet(sel, chip); };

  const Panel = ({ rows }) => (
    <div className="sud-panel">
      {rows.map(([label, value], i) => (
        <div key={label} className={`sud-row ${i % 2 ? "sud-row-b" : "sud-row-a"}`}>
          <span>{label}</span>
          <span>{formatChips(value * stake)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <Cabinet ground="#0a0418" exitTo={`/games/${game.slug}`} testId="cab-seven-up-down" className="sud">
      <div className="sud-ground" aria-hidden="true" />

      <div className="sud-title" style={atMid(CAB_W, 620, 2)}><span>7Up 7Down</span></div>

      <div className="sud-plaque-wrap" style={at(30, 36)} data-testid="cab-score">
        <span className="sud-label">Score</span>
        <div className="sud-plaque"><span>{balance === null ? "…" : formatChips(balance)}</span></div>
      </div>

      <div className="sud-plaque-wrap" style={at(CAB_W - 30 - 372, 36)} data-testid="cab-winner">
        <span className="sud-label">Winner</span>
        <div className="sud-plaque"><span>{formatChips(result?.payout || 0)}</span></div>
      </div>

      <div className="sud-bet-wrap" style={atMid(CAB_W, 260, 92)} data-testid="cab-bet">
        <span className="sud-label sud-label-sm">Bet</span>
        <div className="sud-plaque sud-plaque-sm"><span>{formatChips(myTotal || 0)}</span></div>
      </div>

      <div className="sud-dial" style={atMid(CAB_W, 104, 154)} data-testid="cab-dial">
        {String(Math.max(0, Math.ceil(betting ? countdown : 0))).padStart(2, "0")}
      </div>

      <div className="sud-chiprail" style={atMid(CAB_W, 720, 262)}>
        {chips.map((c) => (
          <button key={c} type="button" onClick={() => setChip(c)} aria-pressed={chip === c}
            data-testid={`cab-chip-${c}`} className={`sud-chip ${chip === c ? "on" : ""}`}>
            {c}
          </button>
        ))}
      </div>

      <div style={at(26, 130, 456)}><Panel rows={LEFT_ROWS} /></div>
      <div style={at(CAB_W - 26 - 456, 130, 456)}><Panel rows={RIGHT_ROWS} /></div>

      <div className="sud-strip" style={atMid(CAB_W, 660, 348)} data-testid="cab-strip">
        <Filigree size={30} />
        <div className="sud-strip-inner">
          {(strip.length ? strip : Array.from({ length: 10 }, () => ({ rank: "—", suit: "s" })))
            .map((c, i) => <StripCard key={i} rank={c.rank} suit={c.suit} />)}
        </div>
        <Filigree size={30} flip />
      </div>

      <div className="sud-board" style={at(44, 428, CAB_W - 88, 190)} data-testid="cab-board">
        {Array.from({ length: 10 }, (_, i) =>
          i === 9 && revealed
            ? <FaceUp key={i} rank={revealed.rank} suit={revealed.suit} />
            : <FaceDown key={i} />)}
      </div>

      <div className="sud-buttons" style={at(44, 630, CAB_W - 88, 62)}>
        <button type="button" onClick={() => lay("up")} disabled={!betting}
          data-testid="cab-side-up" className={`sud-btn ${staked.up ? "armed" : ""}`}>
          7 up{staked.up ? <em>{formatChips(staked.up)}</em> : null}
        </button>
        <button type="button" onClick={clearBets} disabled={!betting || !myTotal}
          data-testid="cab-clear" className="sud-btn sud-btn-take">Take</button>
        <button type="button" onClick={() => lay("down")} disabled={!betting}
          data-testid="cab-side-down" className={`sud-btn ${staked.down ? "armed" : ""}`}>
          7 down{staked.down ? <em>{formatChips(staked.down)}</em> : null}
        </button>
      </div>

      <div className="sud-marquee" style={at(44, 698, CAB_W - 88, 34)} data-testid="cab-marquee">
        {message}
      </div>
    </Cabinet>
  );
}
