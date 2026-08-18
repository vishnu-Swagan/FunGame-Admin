import flewAwayUrl from "./assets/audio/flew_away.mp3";
import { gameAssetUrl } from "./config";

type EffectName = "takeoff" | "flewAway" | "cashout";

const canUseAudio = typeof window !== "undefined" && typeof window.Audio !== "undefined";
const listeners = new Set<() => void>();
const storedPreference = canUseAudio ? window.localStorage.getItem("aviator-sound-enabled") : "false";

let preferred = storedPreference !== "false";
let unlocked = false;

const ambient = canUseAudio ? new Audio(gameAssetUrl("sound/main.wav")) : null;
const effects: Record<EffectName, HTMLAudioElement | null> = {
  takeoff: canUseAudio ? new Audio(gameAssetUrl("sound/take_off.mp3")) : null,
  flewAway: canUseAudio ? new Audio(flewAwayUrl) : null,
  cashout: canUseAudio ? new Audio(gameAssetUrl("sound/cashout.mp3")) : null,
};

if (ambient) {
  ambient.loop = true;
  ambient.volume = 0.16;
}
if (effects.takeoff) effects.takeoff.volume = 0.5;
if (effects.flewAway) effects.flewAway.volume = 0.62;
if (effects.cashout) effects.cashout.volume = 0.55;

function notify() {
  listeners.forEach((listener) => listener());
}

export function getSoundSnapshot() {
  return preferred && unlocked;
}

export function subscribeSound(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function toggleSound() {
  if (!unlocked || !preferred) {
    preferred = true;
    unlocked = true;
    window.localStorage.setItem("aviator-sound-enabled", "true");
    notify();
    if (ambient) {
      try {
        await ambient.play();
      } catch (_error) {
        unlocked = false;
        notify();
      }
    }
    return;
  }

  preferred = false;
  window.localStorage.setItem("aviator-sound-enabled", "false");
  ambient?.pause();
  Object.values(effects).forEach((audio) => audio?.pause());
  notify();
}

export function playGameSound(name: EffectName) {
  if (!preferred || !unlocked) return;
  const audio = effects[name];
  if (!audio) return;
  audio.currentTime = 0;
  void audio.play().catch(() => undefined);
}
