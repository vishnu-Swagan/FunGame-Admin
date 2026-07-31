import { Cabinet } from "@/components/play/arcade/Cabinet";
import AviatorGame from "@/pages/play/AviatorGame";

/**
 * The machine that already fits itself.
 *
 * Aviator sizes its sky to the viewport, so it gets the cabinet — landscape,
 * the frame, the exit and mute — but not the fixed canvas: scaling something
 * that is already scaling itself puts its screen geometry and its layout
 * coordinates out of step by the square of the scale.
 *
 * Roulette used to be here for the same reason. It is now drawn directly in
 * cabinet units instead, which removes the second scale altogether and matches
 * the reference felt exactly — see RouletteCabinet.
 */
export const AviatorCabinet = ({ game }) => (
  <Cabinet fluid ground="radial-gradient(120% 100% at 50% 100%, #0d2a1c 0%, #061410 50%, #020506 100%)"
           exitTo={`/games/${game.slug}`} testId="cab-aviator">
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <AviatorGame game={game} />
    </div>
  </Cabinet>
);
