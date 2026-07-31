import { Cabinet } from "@/components/play/arcade/Cabinet";
import RouletteGame from "@/pages/play/RouletteGame";
import AviatorGame from "@/pages/play/AviatorGame";

/**
 * The two machines that already fit themselves.
 *
 * Roulette's felt measures its own board and hit-tests taps against that
 * measurement; Aviator sizes its sky to the viewport. Both get the cabinet —
 * landscape, the frame, the exit and mute — but not the fixed canvas, because
 * scaling something that is already scaling itself puts its screen geometry and
 * its layout coordinates out of step by the square of the scale. That is the
 * fault that once dropped roulette chips an inch from the number they were
 * aimed at, and it is not worth reintroducing for a frame.
 *
 * So the chrome comes from the cabinet and the board keeps its own fitting.
 */
export const RouletteCabinet = ({ game }) => (
  <Cabinet fluid ground="radial-gradient(120% 100% at 50% 0%, #0d5c2e 0%, #063d1c 45%, #021208 100%)"
           exitTo={`/games/${game.slug}`} testId="cab-fun-roulette">
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <RouletteGame game={game} />
    </div>
  </Cabinet>
);

export const AviatorCabinet = ({ game }) => (
  <Cabinet fluid ground="radial-gradient(120% 100% at 50% 100%, #0d2a1c 0%, #061410 50%, #020506 100%)"
           exitTo={`/games/${game.slug}`} testId="cab-aviator">
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <AviatorGame game={game} />
    </div>
  </Cabinet>
);
