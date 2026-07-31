import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { formatChips } from "@/components/common";
import { Die } from "@/pages/play/DiceGame";
import { Cabinet, CAB_W } from "@/components/play/arcade/Cabinet";
import { at, atMid, Plaque, TitleBoard, CabButton, ChipRail, Dial, Marquee, Filigree } from "@/components/play/arcade/parts";

/**
 * 7Up 7Down, in the cabinet.
 *
 * The layout is the client's: score and winner plaques flanking a gold title,
 * a countdown dial under it, the denomination chips on a rail, a price list
 * down each side, and three long buttons across the bottom.
 *
 * WHAT IS DIFFERENT, DELIBERATELY. On the client's machine the two side panels
 * list poker hands — theirs deals ten cards. Ours rolls two dice and pays the
 * sides and the exact total, so the panels list the totals and their real
 * prices, read from the server's own paytable. Printing the reference's hand
 * list over a dice engine would put prices on the felt that the backend would
 * refuse to pay, which is the one thing a paytable must never do.
 *
 * The prices multiply by the staked chip, exactly as the machines do — laying a
 * chip rescales both panels, which is what makes the screen worth its size.
 */

/* The denominations the reference machines carry. Which of them are OFFERED is
   decided by the server's stake limits, not by this list — a chip the table
   would refuse is a chip that must not be on the rail. */
const DENOMINATIONS = [1, 5, 10, 50, 100, 500, 1000, 5000];

/* The totals, split down the two panels the way the reference splits its hands:
   the long shots at the top of each, descending to the near-even money. */
const LEFT = [2, 3, 4, 5, 6];
const RIGHT = [12, 11, 10, 9, 8];

const GROUND =
  "radial-gradient(120% 100% at 50% 0%, #4a1d6e 0%, #26103f 38%, #0d0618 78%, #050208 100%)";

export default function SevenUpDownCabinet({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result,
          placeBet, clearBets, myBets, myTotal } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `Rolled ${s.outcome.dice[0]} + ${s.outcome.dice[1]} = ${s.outcome.total}`,
      }),
    });

  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 1000;
  const chips = DENOMINATIONS.filter((c) => c >= minBet && c <= maxBet);

  const [chip, setChip] = useState(null);
  /* Settle on the smallest chip the table takes, once the table has said what
     that is. Picking a number before then risks arming a chip the server turns
     out to refuse. */
  useEffect(() => {
    if (!chips.length) return;
    if (chip == null || !chips.includes(chip)) setChip(chips[0]);
  }, [chips, chip]);
  const [frames, setFrames] = useState([0, 3]);
  const [rollCfg, setRollCfg] = useState([{ v: false, d: "0.8s" }, { v: true, d: "0.9s" }]);
  const placedRef = useRef([]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const rolling = phase === "REVEAL" && !showFinal;
  const dice = showFinal ? outcome.dice : [3, 4];

  /* The throw: the flicker decays so the dice slow into their faces rather than
     strobing at a constant rate. Lifted from the portrait table, where it was
     worked out — the cabinet only changes where they are drawn. */
  useEffect(() => {
    if (!rolling) return;
    let timer;
    const step = (gap) => {
      setFrames(([a, b]) => [a + 1, b + 1]);
      const next = Math.min(230, gap * 1.16);
      timer = setTimeout(() => step(next), next);
    };
    step(55);
    return () => clearTimeout(timer);
  }, [rolling]);

  useEffect(() => {
    if (!rolling) return;
    const mk = () => ({ v: Math.random() < 0.5, d: (0.66 + Math.random() * 0.34).toFixed(2) + "s" });
    setRollCfg([mk(), mk()]);
    sfx.dice();
    const t = setInterval(sfx.dice, 1150);
    return () => clearInterval(t);
  }, [rolling]);
  useEffect(() => { if (showFinal && phase === "REVEAL") sfx.diceLand(); }, [showFinal, phase]);

  useEffect(() => { if (phase === "BETTING") placedRef.current = []; }, [state?.round_number, phase]);

  const options = state?.options || {};
  const staked = {};
  myBets.forEach((b) => { staked[b.selection] = (staked[b.selection] || 0) + b.amount; });

  const lay = async (sel) => {
    if (!betting || !chip) return;
    const res = await placeBet(sel, chip);
    if (res) placedRef.current.push({ sel, amount: chip });
  };

  /* The odds the server will actually pay, as the machines print them: the
     return on one staked chip. */
  const priceOf = (sel) => {
    const m = options[sel];
    return m ? Math.round((m - 1) * chip) : null;
  };

  /* The odds as the machines print them — "26:1" — next to what that pays on
     the chip currently selected. One is the price, the other is the money, and
     a panel showing only the money makes the long shots look generous. */
  const oddsOf = (sel) => {
    const m = options[sel];
    if (!m) return "";
    const p = m - 1;
    return `${Number.isInteger(p) ? p : p.toFixed(1)}:1`;
  };

  const message = (() => {
    if (phase === "REVEAL") return "Rolling…";
    if (phase === "RESULT" && outcome) {
      const side = outcome.total === 7 ? "Lucky 7" : outcome.total > 7 ? "7 Up" : "7 Down";
      const won = result && result.payout > 0;
      return `${outcome.dice[0]} + ${outcome.dice[1]} = ${outcome.total} — ${side}. ${won ? `You won ${formatChips(result.payout)}` : "You Lost! Try Again"}`;
    }
    if (!myTotal) return `Please Bet to Start Game. Minimum Bet = ${formatChips(minBet)} and Maximum Bet = ${formatChips(maxBet)}`;
    return `Your bet of ${formatChips(myTotal)} has been accepted.`;
  })();

  /* A price row doubles as its betting cell — which is what the panel is for on
     a machine with no separate felt, and keeps every wager the server accepts
     reachable without inventing a control the reference does not have. */
  const TotalRow = ({ n, i }) => {
    const sel = `t${n}`;
    const on = staked[sel] > 0;
    return (
      <button type="button" onClick={() => lay(sel)} disabled={!betting}
        data-testid={`cab-total-${n}`}
        className={`cab-paytable-row ${i % 2 ? "cab-row-b" : "cab-row-a"}`}
        style={{
          width: "100%", fontSize: 25, lineHeight: 2.35, padding: "0 14px", borderRadius: 6,
          background: on ? "rgba(255,214,120,.14)" : "transparent",
          boxShadow: on ? "inset 0 0 0 1px rgba(255,214,120,.55)" : "none",
          opacity: betting ? 1 : 0.55, cursor: betting ? "pointer" : "default",
        }}>
        <span style={{ minWidth: 132, textAlign: "left" }}>Total {n}</span>
        <span style={{ opacity: 0.6, fontSize: 17 }}>{oddsOf(sel)}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {on && (
            <span style={{ fontSize: 15, color: "#0a0913", background: "linear-gradient(180deg,#ffe38f,#d9a83c)",
                           borderRadius: 999, padding: "1px 9px", fontWeight: 800 }}>
              {formatChips(staked[sel])}
            </span>
          )}
          <span>{formatChips(priceOf(sel) || 0)}</span>
        </span>
      </button>
    );
  };

  const SideButton = ({ sel, label, tone }) => {
    const on = staked[sel] > 0;
    return (
      <CabButton onClick={() => lay(sel)} disabled={!betting} tone={on ? tone : undefined}
        data-testid={`cab-side-${sel}`} size={30} style={{ height: 84, flex: 1, gap: 16 }}>
        {label}
        {on && (
          <span style={{ fontSize: 18, background: "rgba(0,0,0,.35)", borderRadius: 999, padding: "2px 12px" }}>
            {formatChips(staked[sel])}
          </span>
        )}
      </CabButton>
    );
  };

  return (
    <Cabinet ground={GROUND} exitTo={`/games/${game.slug}`} testId="cab-seven-up-down">
      {/* ---- header: score, title, winner --------------------------------- */}
      <Plaque label="Score" value={balance === null ? "…" : formatChips(balance)}
              width={300} height={48} style={at(48, 26)} testId="cab-score" />
      <TitleBoard size={58} style={atMid(CAB_W, 520, 20)}>7Up 7Down</TitleBoard>
      <Plaque label="Winner" value={formatChips(result?.payout || 0)}
              width={300} height={48} style={at(CAB_W - 300 - 128, 26)} testId="cab-winner" />

      {/* ---- centre column: bet, dial, chips ------------------------------ */}
      <Plaque label="Bet" value={formatChips(myTotal || 0)} width={210} height={40}
              labelSize={24} valueSize={22} style={atMid(CAB_W, 210, 100)} testId="cab-bet" />
      <Dial seconds={betting ? countdown : 0} size={112} style={atMid(CAB_W, 112, 186)} />
      <ChipRail chips={chips} value={chip} onPick={setChip} size={64} gap={26}
                style={atMid(CAB_W, 600, 316)} />

      {/* ---- the two price panels ----------------------------------------- */}
      <div className="cab-paytable" style={{ ...at(40, 172, 452), padding: "16px 12px", borderRadius: 10 }}
           data-testid="cab-paytable-left">
        <PanelHead>Totals — low</PanelHead>
        {LEFT.map((n, i) => <TotalRow key={n} n={n} i={i} />)}
      </div>

      <div className="cab-paytable" style={{ ...at(CAB_W - 452 - 40, 172, 452), padding: "16px 12px", borderRadius: 10 }}
           data-testid="cab-paytable-right">
        <PanelHead>Totals — high</PanelHead>
        {RIGHT.map((n, i) => <TotalRow key={n} n={n} i={i} />)}
      </div>

      {/* ---- the dice, on their rail --------------------------------------- */}
      <div className="cab-rail" style={{ ...atMid(CAB_W, 620, 402, 200), justifyContent: "center", gap: 56 }}
           data-testid="cab-dice">
        <Filigree size={34} />
        <Die value={dice[0]} rolling={rolling} variant={rollCfg[0].v} duration={rollCfg[0].d} frame={frames[0]} />
        <Die value={dice[1]} rolling={rolling} variant={rollCfg[1].v} duration={rollCfg[1].d} frame={frames[1]} />
        <Filigree size={34} flip />
      </div>

      {/* ---- the three buttons --------------------------------------------- */}
      <div style={{ ...at(40, 606, CAB_W - 80), display: "flex", gap: 28 }}>
        <SideButton sel="down" label="7 Down" tone="hot" />
        <SideButton sel="seven" label="Lucky 7" tone="take" />
        <SideButton sel="up" label="7 Up" tone="armed" />
      </div>

      {/* ---- the message rail ---------------------------------------------- */}
      <Marquee style={{ ...at(40, 698, CAB_W - 80, 34) }} size={20}>{message}</Marquee>

      {/* Clearing sits away from the three betting buttons on purpose: on these
          machines the bottom row is where you commit, and a control that takes
          bets off does not belong in the row your thumb is already in. */}
      <CabButton onClick={clearBets} disabled={!betting || !myTotal} size={19}
        data-testid="cab-clear" style={{ ...at(CAB_W / 2 + 104, 206, 148, 42) }}>
        Cancel Bet
      </CabButton>
    </Cabinet>
  );
}

const PanelHead = ({ children }) => (
  <div className="cab-script" style={{ fontSize: 22, textAlign: "center", marginBottom: 6,
                                        borderBottom: "1px solid rgba(217,168,60,.4)", paddingBottom: 4 }}>
    {children}
  </div>
);
