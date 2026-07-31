import StakeCabinet from "@/pages/play/cabinet/StakeCabinet";
import { Card } from "@/components/play/arcade/parts";
import { ReelWindow, Wheel, StarStrip, HoldCard } from "@/components/play/arcade/pieces";

/**
 * The eight machines that are one game underneath: stake, spin or deal, get paid
 * by a multiplier.
 *
 * They live in one file because each is genuinely a few lines — a ground, a
 * title, and what happens in the middle — and spreading eight ten-line
 * descriptions across eight files would hide how alike they are. The moment one
 * grows its own behaviour it earns its own file, as Andar Bahar, Keno, Target,
 * Checker, Roulette and Aviator already have.
 */

/* The server sends cards as strings like "AS" / "10H". */
const parseCard = (s) => {
  if (!s) return null;
  const str = String(s);
  const suit = str.slice(-1).toLowerCase();
  return { rank: str.slice(0, -1), suit };
};

const CardRow = ({ cards, hidden, w = 132, h = 186, gap = 22 }) => (
  <div className="cab-rail" style={{ gap, padding: "16px 24px", justifyContent: "center" }} data-testid="cab-cards">
    {(cards && cards.length ? cards : Array.from({ length: 5 })).map((c, i) => (
      <Card key={i} card={hidden ? null : parseCard(c)} w={w} h={h} />
    ))}
  </div>
);

/* ------------------------------------------------------------------ posters */

const GROUNDS = {
  noHold: "radial-gradient(120% 100% at 50% 10%, #1b2b6b 0%, #0d1436 42%, #04060f 100%)",
  champion: "linear-gradient(150deg, #7a5a12 0%, #d9b45c 26%, #8a6a1c 55%, #2c2008 100%)",
  fever: "linear-gradient(180deg, #1d6b28 0%, #0d3d16 60%, #05200a 100%)",
  giant: "radial-gradient(120% 100% at 50% 0%, #3a2a06 0%, #16100a 45%, #030303 100%)",
  lucky8: "radial-gradient(120% 100% at 50% 20%, #b8a45c 0%, #6d5c22 45%, #221c07 100%)",
  triple: "radial-gradient(120% 100% at 50% 0%, #8a7a2a 0%, #4a3f10 45%, #171204 100%)",
  bingo: "radial-gradient(120% 100% at 50% 0%, #1d6b3a 0%, #0d3d1e 55%, #04180a 100%)",
  wheel: "radial-gradient(120% 100% at 50% 10%, #12356b 0%, #071634 48%, #020610 100%)",
};

/* ------------------------------------------------------- the card machines */

export const NoHoldCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="No Hold" ground={GROUNDS.noHold} paytableSide="left" centreTop={330}
    render={({ outcome, showFinal, revealing }) => (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <StarStrip count={11} lit={showFinal && outcome?.multiplier ? 11 : 0} />
        <CardRow cards={showFinal ? outcome?.cards : null} hidden={!showFinal || revealing} />
      </div>
    )}
  />
);

export const ChampionPokerCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="Champion Poker" ground={GROUNDS.champion} paytableSide="right" centreTop={340}
    render={({ outcome, showFinal }) => (
      /* The engine holds for you and deals the rest, so the hold badges report
         what it kept rather than offering a choice the server will not read. */
      <div className="cab-rail" style={{ gap: 20, padding: "16px 24px" }} data-testid="cab-cards">
        {(showFinal ? outcome?.cards : Array.from({ length: 5 })).map((c, i) => (
          <HoldCard key={i} held={showFinal && outcome?.holds?.[i]} disabled w={132}>
            <Card card={showFinal ? parseCard(c) : null} w={132} h={186} />
          </HoldCard>
        ))}
      </div>
    )}
  />
);

export const FeverJokerCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="Fever Joker Bonus" ground={GROUNDS.fever} paytableSide="left" centreTop={206}
    render={({ outcome, showFinal, revealing }) => (
      <ReelWindow
        grid={outcome?.grid && showFinal ? outcome.grid : Array.from({ length: 5 }, () => ["--", "--", "--"])}
        cellW={104} cellH={100} spinning={revealing} />
    )}
  />
);

/* -------------------------------------------------------- the reel machines */

export const GiantJackpotCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="Giant Jackpot" ground={GROUNDS.giant} paytableSide="left" centreTop={188}
    render={({ outcome, showFinal, revealing }) => (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <StarStrip count={11} lit={showFinal && outcome?.multiplier ? 11 : 0} size={24} />
        <ReelWindow
          grid={outcome?.grid && showFinal ? outcome.grid : Array.from({ length: 5 }, () => ["coin", "bar", "bell"])}
          cellW={100} cellH={90} spinning={revealing} />
      </div>
    )}
  />
);

export const Lucky8LineCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="Lucky 8 Line" ground={GROUNDS.lucky8} paytableSide="left" centreTop={200}
    render={({ outcome, showFinal, revealing }) => (
      <ReelWindow
        grid={outcome?.grid && showFinal ? outcome.grid : Array.from({ length: 3 }, () => ["blossom", "ingot", "coin"])}
        cellW={140} cellH={104} spinning={revealing} />
    )}
  />
);

export const TripleFunCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="Triple Fun" ground={GROUNDS.triple} paytableSide="left" centreTop={200}
    render={({ outcome, showFinal, revealing }) => (
      <ReelWindow
        grid={outcome?.grid && showFinal ? outcome.grid : Array.from({ length: 3 }, () => ["--", "CH", "--"])}
        cellW={140} cellH={104} spinning={revealing} />
    )}
  />
);

/* ------------------------------------------------------------ bingo & wheel */

export const BingoCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="Bingo" ground={GROUNDS.bingo} paytableSide="left" centreTop={300}
    messageFor={({ outcome, phase }) =>
      phase === "RESULT" && outcome?.drawn ? `Drawn: ${outcome.drawn.slice(0, 12).join("  ")}…` : null}
    render={({ outcome, showFinal }) => (
      /* The bingo card belongs to the player and is issued at bet time, so
         before a bet there is nothing to draw but the balls. */
      <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 62px)", gap: 8 }} data-testid="cab-balls">
        {(showFinal && outcome?.drawn ? outcome.drawn.slice(0, 30) : Array.from({ length: 30 }, () => null))
          .map((n, i) => (
            <span key={i} style={{
              height: 62, width: 62, borderRadius: "50%", display: "grid", placeItems: "center",
              fontFamily: "ui-serif, Georgia, serif", fontWeight: 700, fontSize: 24,
              fontVariantNumeric: "tabular-nums",
              color: n ? "#0a2a12" : "rgba(255,255,255,.18)",
              background: n ? "radial-gradient(circle at 36% 28%, #ffe9a0, #d9a83c)" : "rgba(255,255,255,.05)",
              border: "2px solid rgba(217,168,60,.5)",
            }}>{n || ""}</span>
          ))}
      </div>
    )}
  />
);

export const GoldenWheelCabinet = ({ game }) => (
  <StakeCabinet
    game={game} title="Super Golden Wheel" ground={GROUNDS.wheel} paytableSide="left" centreTop={250}
    render={({ outcome, showFinal, revealing, state }) => {
      const segs = (state?.paytable || []).map(([label]) => label.replace("x segment", "x"));
      const labels = segs.length ? segs : ["0", "1.2x", "1.5x", "2.3x", "4x", "8x", "15x", "40x"];
      /* The wheel is turned to the segment the server already chose — the
         outcome exists before the spin starts, and the spin has to agree. */
      const idx = showFinal && outcome
        ? Math.max(0, labels.findIndex((l) => parseFloat(l) === outcome.multiplier))
        : 0;
      const angle = revealing ? 360 * 4 : 360 * 4 + (360 - (idx + 0.5) * (360 / labels.length));
      return <Wheel labels={labels} size={300} angle={angle} spinning={revealing || showFinal} />;
    }}
  />
);
