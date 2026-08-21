import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

const CONFETTI = Array.from({ length: 34 }, (_, index) => ({
  left: (index * 47) % 100,
  hue: 36 + (index % 5) * 17,
  delay: (index % 11) * 2,
  drift: ((index % 7) - 3) * 12,
}));

export function RummyWinAtmosphere() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = spring({ frame, fps, config: { damping: 15, stiffness: 115, mass: .75 } });
  const glow = interpolate(frame, [0, 24, 72, 119], [0, .78, .54, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "transparent" }}>
      <div style={{ position: "absolute", left: "12%", right: "12%", top: "-32%", aspectRatio: "1", borderRadius: "50%", opacity: glow, transform: `scale(${.65 + entrance * .35})`, background: "radial-gradient(circle, rgba(255,223,126,.78), rgba(115,73,160,.28) 43%, transparent 70%)", filter: "blur(10px)" }} />
      {[-1, 1].map((side) => (
        <Img
          key={side}
          src={staticFile("game-art/rummy-card-back.jpg")}
          style={{ position: "absolute", left: side < 0 ? "9%" : "auto", right: side > 0 ? "9%" : "auto", top: "20%", width: 118, borderRadius: 10, opacity: .72 * entrance, transform: `translateY(${(1 - entrance) * 90}px) rotate(${side * (18 + entrance * 12)}deg)`, boxShadow: "0 18px 34px rgba(0,0,0,.42)" }}
        />
      ))}
      {CONFETTI.map((piece, index) => {
        const progress = interpolate(frame - piece.delay, [0, 82], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return <i key={index} style={{ position: "absolute", left: `${piece.left}%`, top: -24, width: 8, height: 18, borderRadius: 2, opacity: progress > .94 ? (1 - progress) / .06 : progress, background: `hsl(${piece.hue} 82% 60%)`, transform: `translate(${piece.drift * progress}px, ${progress * 610}px) rotate(${progress * (420 + index * 9)}deg)` }} />;
      })}
    </AbsoluteFill>
  );
}
