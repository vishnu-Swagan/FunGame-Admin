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
export const AviatorCabinet = () => <AviatorGame />;
