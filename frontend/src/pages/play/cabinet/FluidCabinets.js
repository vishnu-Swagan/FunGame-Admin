import AviatorGame from "@/pages/play/AviatorGame";
import ChickenRoadGame from "@/pages/play/ChickenRoadGame";

/**
 * The machine that already fits itself.
 *
 * Aviator sizes its sky to the viewport, so it gets the cabinet — landscape,
 * the frame, the exit and mute — but not the fixed canvas: scaling something
 * that is already scaling itself puts its screen geometry and its layout
 * coordinates out of step by the square of the scale.
 *
 * American Roulette now has its own synchronized table engine and no longer
 * shares this wrapper.
 */
export const AviatorCabinet = () => <AviatorGame />;

/**
 * Chicken Road is the second self-sizing crash cabinet. Like Aviator it renders
 * its own fullscreen Canvas surface inside the frame, so it gets the wrapper but
 * not the fixed-canvas scaling.
 */
export const ChickenRoadCabinet = () => <ChickenRoadGame />;
