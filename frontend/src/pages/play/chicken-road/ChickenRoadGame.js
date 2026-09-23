import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Volume2, VolumeX } from "lucide-react";
import { createChickenRoadAudio } from "./chickenRoadAudio";
import ChickenRoadView from "./ChickenRoadView";
import {
  createDemoState, transitionDemoState, currentMultiplier, cashOutCents,
  getDemoMultipliers, DIFFICULTIES,
} from "./chickenRoadDemo";

const HOP_MS = 480;
const PRESETS = [2, 3, 8, 20];
const money = (cents) => (cents / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const SOUND_KEY = "chakri.chicken-road.sound-muted";
const savedMute = () => {
  try { return window.localStorage.getItem(SOUND_KEY) === "true"; } catch { return false; }
};

/** Reference-only, development route. No authentication, wallet, or gameplay API.
 * Scripted demo outcomes are deliberately separate from any future real game.
 */
export default function ChickenRoadGame() {
  const [round, setRound] = useState(() => createDemoState());
  const [stake, setStake] = useState("3");
  const [difficulty, setDifficulty] = useState("medium");
  const [moving, setMoving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [visibleLane, setVisibleLane] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState("");
  const [reduceMotion, setReduceMotion] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth <= 600);
  const [muted, setMuted] = useState(savedMute);
  const [hidden, setHidden] = useState(() => document.hidden);
  const busy = useRef(false);
  const roundRef = useRef(round);
  const hopTimer = useRef(null);
  const rootRef = useRef(null);
  const audioRef = useRef(null);
  const mutedRef = useRef(muted);
  const soundEpoch = useRef(0);
  const active = round.phase === "playing";
  const terminal = ["crashed", "cashed_out"].includes(round.phase);
  const stakeCents = Math.round(Number(stake) * 100);
  const stakeValid = /^\d+(\.\d{0,2})?$/.test(stake) && stakeCents >= 100 && stakeCents <= Math.min(round.balanceCents, 1000000);
  const camera = Math.max(0, visibleLane - (compact ? 1 : 2));
  const locked = active || moving;
  const shownDifficulty = round.phase === "idle" ? difficulty : round.difficulty;
  const multipliers = getDemoMultipliers(shownDifficulty);

  useEffect(() => () => clearTimeout(hopTimer.current), []);
  useEffect(() => {
    const audio = createChickenRoadAudio();
    audioRef.current = audio;
    audio.setMuted(mutedRef.current);
    const visibility = () => {
      setHidden(document.hidden);
      if (document.hidden) { soundEpoch.current += 1; audio.stopAll(); }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      soundEpoch.current += 1;
      document.removeEventListener("visibilitychange", visibility);
      audio.dispose();
      audioRef.current = null;
    };
  }, []);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 600px)");
    if (!query) return undefined;
    const update = () => setCompact(query.matches);
    update(); query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = () => setReduceMotion(query.matches);
    update(); query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  const commit = (next) => { roundRef.current = next; setRound(next); };
  const toggleSound = () => {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted; setMuted(nextMuted);
    soundEpoch.current += 1;
    audioRef.current?.setMuted(nextMuted);
    // Resume only inside this explicit user gesture; never replay old sounds.
    if (!nextMuted) audioRef.current?.unlock();
    try { window.localStorage.setItem(SOUND_KEY, String(nextMuted)); } catch { /* Storage is optional. */ }
  };
  const walkSound = (duration) => {
    const audio = audioRef.current;
    if (!audio || mutedRef.current || document.hidden) return;
    audio.stopAll();
    const epoch = ++soundEpoch.current;
    const start = performance.now();
    const ready = audio.unlock();
    if (duration <= 0) return;
    if (audio.playWalk(duration)) return;
    ready.then((unlocked) => {
      const remaining = duration - (performance.now() - start);
      if (unlocked && soundEpoch.current === epoch && busy.current && !mutedRef.current && !document.hidden && remaining > 60) audio.playWalk(remaining);
    });
  };
  const act = (type) => {
    if (busy.current) return;
    let base = roundRef.current;
    const replay = type === "PLAY" && ["crashed", "cashed_out"].includes(base.phase);
    if (type === "PLAY") {
      if (!stakeValid) { setError("Choose an amount from 1 to your available demo credits (maximum 10,000)."); return; }
      if (base.phase !== "idle") base = transitionDemoState(base, { type: "RESET" });
    }
    const next = transitionDemoState(base, { type, stakeCents, difficulty });
    if (next === base) return;
    setError("");
    if (type === "CASH_OUT") { soundEpoch.current += 1; audioRef.current?.stopAll(); commit(next); return; }
    // Synchronous lock prevents two rapid clicks from advancing twice before
    // React renders the disabled controls. No financial request is made.
    busy.current = true;
    roundRef.current = next;
    if (replay) {
      // Commit the home position with transitions off before the next crossing.
      // A layout read makes the starting frame real instead of a backwards hop.
      flushSync(() => { setRound(base); setVisibleLane(0); setResetting(true); });
      rootRef.current?.getBoundingClientRect();
      flushSync(() => setResetting(false));
    } else if (type === "PLAY") setRound(base);
    setVisibleLane(next.lane);
    setMoving(true);
    const duration = reduceMotion ? 0 : HOP_MS;
    walkSound(duration);
    hopTimer.current = setTimeout(() => {
      soundEpoch.current += 1;
      commit(next); setMoving(false); busy.current = false;
      if (next.phase === "crashed" && !mutedRef.current && !document.hidden) audioRef.current?.playFire();
    }, duration);
  };

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (rootRef.current?.requestFullscreen) await rootRef.current.requestFullscreen();
      else setError("Fullscreen is not supported by this browser. Use landscape orientation for a wider road.");
    } catch { setError("Fullscreen could not be opened. The game still works in this window."); }
  };
  const latest = round.history?.[round.history.length - 1];
  const dialogView = dialog ? {
    title: dialog === "help" ? "How to play" : dialog === "menu" ? "Chicken Road" : dialog === "auto" ? "Auto play" : "About this preview",
    content: <>      {dialog === "help" ? <><ol><li>Choose a demo stake and press <b>Play</b>. The chicken attempts the first lane.</li><li>Press <b>GO</b> to attempt one more crossing. Each safe lane raises the displayed multiplier.</li><li>Press <b>CASH OUT</b> to bank the current amount. A collision ends the round and loses its demo stake.</li></ol><p>Bet size and difficulty stay locked during a crossing.</p></>
        : dialog === "auto" ? <><p>The reference includes an auto-play control but does not show its settings or stopping rules.</p><p>This preview uses manual Play / GO / Cash Out only. No automatic stakes are placed.</p></>
          : dialog === "menu" ? <><p>Chakri.Casino · Chicken Road visual prototype</p><button className="road-top-button" onClick={() => setDialog("help")}>How to play</button><button className="road-top-button" onClick={() => setDialog("rules")}>Preview rules & limits</button><button className="road-top-button" onClick={toggleSound} aria-pressed={!muted} aria-label={muted ? "Turn game sounds on" : "Mute game sounds"}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}<span>Sound {muted ? "off" : "on"}</span></button><p>Soft footsteps accompany each crossing. Fire and chicken sounds play on collision. Audio starts only after your interaction and stops when this tab is hidden.</p><p>Animations follow your device’s reduced-motion preference.</p></>
            : <><p>This is an isolated design preview. Demo credits have no cash value and never affect a player wallet.</p><p>All four difficulties use fixed demonstration sequences, not real probabilities. The Medium labels follow the reference; the other ladders are design-only proposals.</p><p>Each preview can finish at the last displayed multiplier. Production odds, payout limits and server settlement must be approved and tested before real play is enabled.</p></>}
</>,
  } : null;
  return <ChickenRoadView
    rootRef={rootRef} phase={round.phase} roundKey={round.roundNumber} lane={round.lane}
    multipliers={multipliers} difficulties={DIFFICULTIES}
    balanceText={money(round.balanceCents)} balanceLabel={`Demo balance ${money(round.balanceCents)} credits`}
    stake={stake} stakeLabel="Demo stake" minimumLabel="Minimum demo stake" maximumLabel="Maximum demo stake"
    presetLabel="Demo stake presets" presets={PRESETS} difficulty={difficulty}
    visibleLane={visibleLane} camera={camera} moving={moving} resetting={resetting} hidden={hidden}
    escapeFromLane={moving && roundRef.current.phase !== "crashed" ? visibleLane - 1 : 0}
    locked={locked} playDisabled={!stakeValid || multipliers.length === 0} cashOutText={money(cashOutCents(round))}
    result={terminal ? {
      type: round.phase === "crashed" ? "error" : "success",
      title: round.phase === "crashed" ? "Oh, cluck!" : `${currentMultiplier(round).toFixed(2)}x · Cashed out`,
      detail: round.phase === "crashed" ? "The crossing ended. Play again when you’re ready." : `+${money(round.payoutCents)} demo credits`,
    } : null}
    error={error} banner="DESIGN PREVIEW · Demo credits only · Scripted outcomes, not real odds"
    historyText={latest ? `Last demo round: ${latest.phase === "cashed_out" ? `+${money(latest.payoutCents)} credits` : "collision"}` : "Four scripted difficulties · No money or wallet connection"}
    rulesLabel="Preview rules" chanceHint="Design-only scripted crossings, not production probabilities"
    onStakeChange={(value) => { setStake(value); setError(""); }}
    onMinimum={() => setStake("1")} onMaximum={() => setStake(String(Math.min(round.balanceCents / 100, 10000)))}
    onPreset={(value) => setStake(String(value))}
    onDifficulty={(id) => {
      if (busy.current || roundRef.current.phase === "playing" || !getDemoMultipliers(id).length) return;
      if (["crashed", "cashed_out"].includes(roundRef.current.phase)) {
        commit(transitionDemoState(roundRef.current, { type: "RESET" }));
        setVisibleLane(0);
      }
      setDifficulty(id); setError("");
    }}
    onAction={act} onFullscreen={fullscreen} dialog={dialogView} onDialogChange={setDialog}
  />;
}
