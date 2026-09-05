import React from "react";
import { Composition } from "remotion";
import { WagerMissionPreview } from "./WagerMissionPreview";

export function WagerMotionRoot() {
  return (
    <Composition
      id="WagerMissionPreview"
      component={WagerMissionPreview}
      durationInFrames={210}
      fps={30}
      width={1080}
      height={1920}
    />
  );
}
