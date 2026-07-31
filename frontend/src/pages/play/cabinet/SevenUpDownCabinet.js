import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useLiveRound } from "@/lib/useLiveRound";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W } from "@/components/play/arcade/Cabinet";
import { at, atMid } from "@/components/play/arcade/parts";
import { Scroll, TitleWing, CARD_BACK } from "./sudArt";
import "./sevenUpDown.css";

/**
 * 7Up 7Down, matched to the machine.
 *
 * The screen has two states and they are laid out differently, which is the
 * detail that makes it feel like the original:
 *
 * WHILE BETS ARE OPEN the two sides are large pills lying across the middle of
 * the card positions, Cancel Bet sits on the dealt strip, and Take is alone
 * under the board.
 *
 * ONCE THE ROUND CLOSES they collapse to the compact row beneath the board —
 * 7 up, Take, 7 down — the chips green over, and the last position turns face
 * up. Between rounds the table dims behind the "next round starts in" notice
 * rather than leaving a live-looking board that refuses every press.
 */

const CHIPS = [1, 5, 50, 100, 500, 1000];

/* The machine's price list, at one chip. Both panels scale with the bet. */
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

const StripCard = ({ rank, suit }) => {
  const [glyph, colour] = SUITS[suit] || SUITS.s;
  return (
    <div className="sud-strip-card">
      <span className="sud-strip-tl" style={{ color: colour }}>{rank}<i>{glyph}</i></span>
      <span className="sud-strip-br" style={{ color: colour }}>{rank}<i>{glyph}</i></span>
    </div>
  );
};

const FaceDown = () => (
  <div className="sud-back" style={{ backgroundImage: `url("data:image/svg+xml,${CARD_BACK}")` }} />
);

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
  const navigate = useNavigate();
  const { state, countdown, balance, betting, phase, outcome, result,
          placeBet, clearBets, myBets, myTotal, lastResults } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `${s.outcome.dice[0]} + ${s.outcome.dice[1]} = ${s.outcome.total}`,
      }),
    });

  const minBet = state?.min_bet ?? 1;
  const maxBet = state?.max_bet ?? 1000;
  const chips = useMemo(() => CHIPS.filter((c) => c >= minBet && c <= maxBet), [minBet, maxBet]);
  const [chip, setChip] = useState(null);
  useEffect(() => { if (chips.length && (chip == null || !chips.includes(chip))) setChip(chips[0]); }, [chips, chip]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });

  const strip = useMemo(() => {
    const suits = ["c", "s", "d", "c", "s", "h", "h", "h", "d", "h"];
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
  const won = showFinal && result && result.payout > 0;
  const winner = showFinal && outcome
    ? (outcome.total > 7 ? "up" : outcome.total < 7 ? "down" : null)
    : null;

  const message = (() => {
    if (phase === "REVEAL") return "Please wait... Round is in progress";
    if (phase === "RESULT" && outcome) {
      return won
        ? "Please take your winning amount or Press '7Up' or '7Down' Button"
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

  /* A side button. Big pills over the board while bets are open, the compact
     row underneath once they are not. */
  const Side = ({ sel, label, big }) => (
    <button type="button" onClick={() => lay(sel)} disabled={!betting}
      data-testid={`cab-side-${sel}`}
      className={`sud-btn ${winner === sel ? "won" : staked[sel] ? "armed" : ""}`}
      style={{ height: "100%", width: "100%", fontSize: big ? 34 : 27 }}>
      {label}{staked[sel] ? <em>{formatChips(staked[sel])}</em> : null}
    </button>
  );

  return (
    <Cabinet ground="#0a0418" exitTo={`/games/${game.slug}`} testId="cab-seven-up-down" className="sud">
      <div className="sud-ground" aria-hidden="true" />
      <div className="sud-sparkle" aria-hidden="true" />

      {/* ---- title, with its wings, and the X in its box ----------------- */}
      <div className="sud-titlebar" style={atMid(CAB_W, 760, 4)}>
        <TitleWing w={116} />
        <div className="sud-title"><span>7Up 7Down</span></div>
        <TitleWing w={116} flip />
      </div>

      <button type="button" onClick={() => navigate(`/games/${game.slug}`)} data-testid="cab-exit-x"
        className="sud-x" style={at(CAB_W - 96, 14, 52, 52)} aria-label="Leave the table">×</button>

      {/* ---- score and winner ------------------------------------------- */}
      <div className="sud-plaque-wrap" style={at(78, 40, 330)} data-testid="cab-score">
        <span className="sud-label">Score</span>
        <div className="sud-plaque-row">
          <Scroll w={44} flip />
          <div className="sud-plaque"><span>{balance === null ? "…" : formatChips(balance)}</span></div>
          <Scroll w={44} />
        </div>
      </div>

      <div className="sud-plaque-wrap" style={at(CAB_W - 78 - 330, 40, 330)} data-testid="cab-winner">
        <span className="sud-label">Winner</span>
        <div className="sud-plaque-row">
          <Scroll w={44} flip />
          <div className="sud-plaque"><span>{formatChips(result?.payout || 0)}</span></div>
          <Scroll w={44} />
        </div>
      </div>

      {/* ---- bet and the dial -------------------------------------------- */}
      <div className="sud-plaque-wrap" style={atMid(CAB_W, 190, 96)} data-testid="cab-bet">
        <span className="sud-label sud-label-sm">Bet</span>
        <div className="sud-plaque-row">
          <div className="sud-plaque sud-plaque-sm"><span>{formatChips(myTotal || 0)}</span></div>
        </div>
      </div>

      {/* The dial sits above the rail, and the rail passes behind it. */}
      <div className="sud-dial" style={{ ...atMid(CAB_W, 96, 168, 96), zIndex: 3 }} data-testid="cab-dial">
        {String(Math.max(0, Math.ceil(betting ? countdown : 0))).padStart(2, "0")}
      </div>

      {/* ---- the arced chip rail ----------------------------------------- */}
      <div className={`sud-chiprail ${!betting ? "lit" : ""}`}
           style={{ ...atMid(CAB_W, 880, 196, 150), zIndex: 2 }}>
        <div className="sud-chiprail-track" />
        <div className="sud-chips">
          {chips.map((c) => (
            <button key={c} type="button" onClick={() => setChip(c)} aria-pressed={chip === c}
              data-testid={`cab-chip-${c}`} className={`sud-chip ${chip === c ? "on" : ""}`}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* ---- price panels ------------------------------------------------ */}
      <div style={at(26, 130, 400)}><Panel rows={LEFT_ROWS} /></div>
      <div style={at(CAB_W - 26 - 400, 130, 400)}><Panel rows={RIGHT_ROWS} /></div>

      {/* ---- the dealt strip, with Cancel Bet across it while betting ----- */}
      <div className="sud-strip" style={{ ...atMid(CAB_W, 720, 350, 76), zIndex: 1 }} data-testid="cab-strip">
        <Scroll w={52} flip />
        <div className="sud-strip-inner">
          {(strip.length ? strip : Array.from({ length: 10 }, () => ({ rank: "—", suit: "s" })))
            .map((c, i) => <StripCard key={i} rank={c.rank} suit={c.suit} />)}
        </div>
        <Scroll w={52} />
      </div>

      {betting && (
        <button type="button" onClick={clearBets} disabled={!myTotal} data-testid="cab-clear"
          className="sud-cancel" style={{ ...atMid(CAB_W, 230, 348, 36), zIndex: 4 }}>
          Cancel Bet
        </button>
      )}

      {/* ---- the ten positions -------------------------------------------- */}
      <div className="sud-board" style={at(44, 440, CAB_W - 88, 176)} data-testid="cab-board">
        {Array.from({ length: 10 }, (_, i) =>
          i === 9 && revealed
            ? <FaceUp key={i} rank={revealed.rank} suit={revealed.suit} />
            : <FaceDown key={i} />)}
      </div>

      {/* ---- the sides: over the board while betting, under it after ------ */}
      {betting ? (
        <>
          <div style={{ ...at(410, 500, 320, 62), zIndex: 5 }}><Side sel="up" label="7 up" big /></div>
          <div style={{ ...at(CAB_W - 410 - 320, 500, 320, 62), zIndex: 5 }}><Side sel="down" label="7 down" big /></div>
          <div className="sud-takewrap" style={atMid(CAB_W, 420, 632, 52)}>
            <Scroll w={44} flip />
            <button type="button" onClick={clearBets} disabled={!myTotal} data-testid="cab-take"
              className="sud-take" style={{ flex: 1, height: 52, fontSize: 28 }}>Take</button>
            <Scroll w={44} />
          </div>
        </>
      ) : (
        <div style={{ ...at(44, 628, CAB_W - 88, 56), display: "flex", gap: 40 }}>
          <div style={{ flex: 1 }}><Side sel="up" label="7 up" /></div>
          <div style={{ flex: 1 }}>
            <button type="button" onClick={clearBets} disabled={!myTotal} data-testid="cab-take"
              className="sud-take" style={{ height: "100%", width: "100%", fontSize: 27 }}>Take</button>
          </div>
          <div style={{ flex: 1 }}><Side sel="down" label="7 down" /></div>
        </div>
      )}

      <div className="sud-marquee" style={at(120, 692, CAB_W - 240, 38)} data-testid="cab-marquee">
        {message}
      </div>

      {/* ---- between rounds ------------------------------------------------ */}
      {phase === "REVEAL" && (
        <div className="sud-gate" data-testid="cab-gate">
          <div className="sud-gate-box">
            <span className="sud-gate-spin" />
            {/* "Game Over" reads as the session ending. The round is simply
                closed to bets, so that is what it says. */}
            <span>NO MORE BETTING</span>
          </div>
        </div>
      )}
    </Cabinet>
  );
}
