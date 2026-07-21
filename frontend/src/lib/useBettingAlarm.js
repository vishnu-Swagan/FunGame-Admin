import { useEffect, useRef } from "react";
import { sfx, isMuted } from "@/lib/sound";

/** Whole-second countdown -> tick step 5..1, else null (only the final 5s). */
export function alarmStep(countdown) {
  const s = Math.floor(countdown);
  return s >= 1 && s <= 5 ? s : null;
}

/** Escalating end-of-betting alarm. Ticks 5..1 during BETTING, thunk at lock. */
export function useBettingAlarm({ phase, countdown, roundNumber }) {
  const lastTickRef = useRef(""); // `${round}:${step}` already played
  const lockedRoundRef = useRef(null);
  const prevPhaseRef = useRef(phase);

  useEffect(() => {
    if (phase === "BETTING") {
      const step = alarmStep(countdown);
      if (step != null && !isMuted()) {
        const key = `${roundNumber}:${step}`;
        if (lastTickRef.current !== key) {
          lastTickRef.current = key;
          sfx.tick && sfx.tick(step);
        }
      }
    }
    if (prevPhaseRef.current === "BETTING" && phase !== "BETTING") {
      if (lockedRoundRef.current !== roundNumber) {
        lockedRoundRef.current = roundNumber;
        if (!isMuted()) sfx.betLock && sfx.betLock();
      }
    }
    prevPhaseRef.current = phase;
  }, [phase, countdown, roundNumber]);
}
