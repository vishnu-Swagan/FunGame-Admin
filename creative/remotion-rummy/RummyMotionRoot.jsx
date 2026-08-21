import React from "react";
import { Composition } from "remotion";
import { RummyWinAtmosphere } from "./RummyWinAtmosphere";

export function RummyMotionRoot() {
  return (
    <Composition
      id="RummyWinAtmosphere"
      component={RummyWinAtmosphere}
      durationInFrames={120}
      fps={30}
      width={900}
      height={560}
    />
  );
}
