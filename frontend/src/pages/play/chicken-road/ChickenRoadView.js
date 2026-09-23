import { useEffect, useId, useRef, useState } from "react";
import { CircleHelp, Maximize2, Menu, RotateCw, X } from "lucide-react";
import { FireBurst, AmbientFlame } from "./ChickenRoadEffects";
import "./chicken-road.css";

function ChickenCharacter() {
  const [blinkReady, setBlinkReady] = useState(false);
  const partId = useId().replace(/:/g, "");
  const original = "/games/chicken-road/chicken-idle.png";
  return <div className={`road-chicken road-chicken--alive${blinkReady ? " has-blink" : ""}`} role="img" aria-label="White chicken with a red comb">
    <svg viewBox="0 0 1254 1254" aria-hidden="true" focusable="false" className="road-chicken-rig">
      <defs>
        <clipPath id={`${partId}-body`}><path d="M0 0H1254V1015H850Q680 1110 400 1015H0Z" /></clipPath>
        <clipPath id={`${partId}-near`}><path d="M210 1015H560V1254H210Z" /></clipPath>
        <clipPath id={`${partId}-far`}><path d="M670 1015H1010V1254H670Z" /></clipPath>
        <clipPath id={`${partId}-eyes`}><ellipse cx="595" cy="389" rx="160" ry="183" /><ellipse cx="962" cy="345" rx="112" ry="159" /></clipPath>
      </defs>
      <g className="road-chicken-leg road-chicken-leg--far"><image href={original} width="1254" height="1254" clipPath={`url(#${partId}-far)`} /></g>
      <g className="road-chicken-leg road-chicken-leg--near"><image href={original} width="1254" height="1254" clipPath={`url(#${partId}-near)`} /></g>
      <image href={original} width="1254" height="1254" clipPath={`url(#${partId}-body)`} />
      <image className="road-chicken-frame--blink" href="/games/chicken-road/chicken-blink.png" width="1254" height="1254" clipPath={`url(#${partId}-eyes)`} onLoad={() => setBlinkReady(true)} onError={() => setBlinkReady(false)} />
    </svg>
  </div>;
}

function Roast({ plate = false }) {
  return <svg viewBox="0 0 150 110" width="150" height="110" aria-hidden="true" focusable="false">
    {plate && <ellipse cx="76" cy="98" rx="65" ry="9" fill="#f5e7d4" />}
    <g stroke="#9b641c" strokeWidth="3" strokeLinejoin="round">
      <path d="M39 39 26 17c-8 4-15-5-11-11 3-5 9-4 12 0 1-8 12-8 14-2 2 6-2 10-5 11l17 17M103 32l11-18c-6-6 2-15 8-9 4-7 14-4 13 3-1 6-6 8-12 8l-7 23" fill="#ffe09a" />
      <ellipse cx="78" cy="61" rx="48" ry="36" fill="#d99829" />
      <path d="M57 32c26-11 52 3 57 27 5 19-5 33-17 37 27-4 38-21 29-43-8-21-38-36-69-21" fill="#b97a1c" stroke="none" />
      <ellipse cx="41" cy="65" rx="23" ry="28" transform="rotate(-28 41 65)" fill="#b87a1d" />
      <path d="m65 29 11 9m-5-13 10 9m-17 0 12-7m-8 10 12-7m25 19 9 8m-6-12 10 8m-13-1 12-7" fill="none" stroke="#a66b1d" strokeWidth="1.5" opacity=".7" />
      <path d="m93 73 12 12m0-12L93 85" fill="none" strokeLinecap="round" />
    </g>
  </svg>;
}

function Flame() {
  return <svg viewBox="0 0 80 100" width="80" height="100" aria-hidden="true" focusable="false">
    <path d="M42 4C50 26 24 31 29 52c12-4 19-15 20-23 19 20 29 37 21 53-13 26-53 23-60 0C1 55 30 27 42 4Z" fill="#ef416a" stroke="#8e1b48" strokeWidth="4" />
    <path d="M43 46c7 12-3 16 0 24 6-2 7-5 9-8 16 24-14 40-23 22-6-11 6-27 14-38Z" fill="#ff9ca6" />
  </svg>;
}

function Coin({ multiplier, state }) {
  const id = useId().replace(/:/g, "");
  const palette = state === "current" ? ["#7dfd82", "#27ca43", "#197f35", "#239d49"]
    : state === "passed" ? ["#fff594", "#ffd52c", "#af781c", "#e5af24"]
      : state === "crashed" ? ["#ffb3bf", "#ff527b", "#9e2251", "#e64072"]
        : ["#a5afff", "#6977be", "#3b446c", "#5b66a4"];
  return <svg className="road-coin" viewBox="0 0 180 180" role="img" aria-label={state === "passed" ? `Passed ${multiplier.toFixed(2)} times` : state === "crashed" ? "Collision" : `${multiplier.toFixed(2)} times${state === "current" ? ", current multiplier" : ""}`}>
    <defs><linearGradient id={id} x1="0" y1="0" x2=".8" y2="1"><stop stopColor={palette[1]} /><stop offset="1" stopColor={palette[2]} /></linearGradient></defs>
    <circle cx="90" cy="94" r="87" fill="#292f49" opacity=".65" />
    <circle cx="90" cy="90" r="79" fill={`url(#${id})`} stroke="#343c5c" strokeWidth="8" />
    <circle cx="90" cy="90" r="65" fill={palette[3]} stroke={palette[2]} strokeWidth="7" />
    <path d="M16 84A75 75 0 0 1 66 19" fill="none" stroke={palette[0]} strokeWidth="8" />
    <path d="m39 137 108-92a66 66 0 0 1-25 104Z" fill="#141a37" opacity=".1" />
    <path d="M114 161A75 75 0 0 1 24 126" fill="none" stroke={palette[1]} strokeWidth="5" opacity=".7" />
    {state === "passed" ? <g transform="translate(30 37) scale(.8)"><Roast /></g>
      : state === "crashed" ? <g transform="translate(51 38) scale(.9)"><Flame /></g>
        : <text x="90" y="105" textAnchor="middle" fill="#fff" stroke="#303a63" strokeWidth="3" paintOrder="stroke" fontSize="39" fontWeight="900" letterSpacing="-2">{multiplier.toFixed(2)}x</text>}
  </svg>;
}

export function RoadDialog({ title, onClose, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    // Menu links replace their own focused element without remounting Dialog.
    // Keep focus inside the surviving modal while retaining its original trigger.
    dialogRef.current?.querySelector("button")?.focus();
  }, [title]);
  const handleKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const focusable = [...dialogRef.current.querySelectorAll("button:not(:disabled), a[href], input:not(:disabled)")];
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="road-dialog-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="road-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleKey}>
      <button className="road-close" aria-label="Close dialog" onClick={onClose}><X size={22} /></button>
      <h2 id={titleId}>{title}</h2>{children}
    </section>
  </div>;
}


function RoadBrand() {
  const [failed, setFailed] = useState(false);
  return <div className="road-brand"><h1 className="road-wordmark" aria-label="Chicken Road">
    {failed ? <>CHICKEN R<span className="road-egg" aria-hidden="true" />AD</>
      : <><img className="road-game-logo" src="/game-art/chicken-road.png" alt="" onError={() => setFailed(true)} /><span className="road-logo-title">CHICKEN ROAD</span></>}
  </h1><span className="road-brand-subtitle">CHAKRI.CASINO</span></div>;
}

/** Presentation only: money, rules, round state, and actions belong to its controller. */
export default function ChickenRoadView({
  rootRef, phase = "idle", roundKey, lane: currentLane = 0, multipliers = [], difficulties = [],
  balanceText = "—", balanceLabel = "Balance unavailable", stake = "", stakeLabel = "Stake",
  minimumLabel = "Minimum stake", maximumLabel = "Maximum stake", presetLabel = "Stake presets",
  presets = [], difficulty, visibleLane = 0, camera = 0, moving = false, resetting = false,
  hidden = false, locked = true, playDisabled = true, actionDisabled = false,
  goDisabled = actionDisabled, cashOutDisabled = actionDisabled, cashOutText = "—",
  result = null, error = "", banner = null, historyText = "", rulesLabel = "Game rules",
  chanceHint = "", statusPanel = null, dialog = null, animateOutcome = true, onStakeChange, onMinimum, onMaximum,
  onPreset, onDifficulty, onAction, onFullscreen, onDialogChange, escapeFromLane = 0,
}) {
  const [endedBurst, setEndedBurst] = useState(null);
  const [escapeBurst, setEscapeBurst] = useState(null);
  const collisionKey = `${roundKey}:${currentLane}`;
  const motionAllowed = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const showCollision = animateOutcome && endedBurst !== collisionKey && motionAllowed;
  useEffect(() => {
    if (!motionAllowed) {
      setEscapeBurst(null);
      if (phase === "crashed") setEndedBurst(collisionKey);
    } else if (moving && escapeFromLane > 0) {
      // The controller supplies this only for an already-confirmed safe hop.
      // Keep its decorative departure flame alive after the chicken lands.
      setEscapeBurst({ roundKey, lane: escapeFromLane });
    }
  }, [moving, escapeFromLane, roundKey, motionAllowed, phase, collisionKey]);
  return <main className={`road-game${resetting ? " is-resetting" : ""}${hidden ? " is-background" : ""}`} ref={rootRef} data-testid="chicken-road" data-phase={moving ? "hopping" : phase} data-difficulty={difficulty}>
    <header className="road-topbar">
      <RoadBrand />
      <div className="road-toolbar">
        <button className="road-top-button" onClick={() => onDialogChange("help")} aria-label="How to play"><CircleHelp size={18} /><span>How to play?</span></button>
        <span className="road-balance" aria-label={balanceLabel} data-testid="road-balance">{balanceText} <span aria-hidden="true">◉</span></span>
        <button className="road-top-button" aria-label="Toggle fullscreen" onClick={onFullscreen}><Maximize2 size={20} /></button>
        <button className="road-top-button" aria-label="Game menu" onClick={() => onDialogChange("menu")}><Menu size={23} /></button>
      </div>
    </header>
    {banner && <div className="road-preview-banner">{banner}</div>}

    <section className="road-viewport" aria-label="Chicken Road lanes">
      {statusPanel && <div className="road-result road-connection" role="status">{statusPanel}</div>}
      <div className="road-track" style={{ "--camera": camera, "--lane-count": multipliers.length + 1 }}>
        <div className="road-lane road-home"><div className="road-patch road-patch--one" /><div className="road-door" /></div>
        {multipliers.map((multiplier, index) => {
          const lane = index + 1;
          const state = !moving && phase === "crashed" && currentLane === lane ? "crashed"
            : currentLane === lane && phase !== "idle" && !moving ? "current"
              : lane < (moving ? visibleLane : currentLane) ? "passed"
                : lane === (moving ? visibleLane : currentLane + 1) ? "next" : "idle";
          const escaping = phase !== "idle" && motionAllowed && escapeBurst?.roundKey === roundKey && escapeBurst?.lane === lane;
          const colliding = state === "crashed" && showCollision;
          return <div className="road-lane" key={lane} data-state={state} style={{ "--lane-index": index }} onAnimationEnd={(event) => {
            if (!event.target.classList.contains("road-fx-burst") || event.animationName !== "road-fx-burst-envelope") return;
            if (event.target.classList.contains("road-fx-escape")) setEscapeBurst(null);
            else setEndedBurst(collisionKey);
          }}>
            <div className="road-lane-glow" /><div className="road-patch road-patch--one" /><div className="road-patch road-patch--two" />
            <Coin multiplier={multiplier} state={state} />
            <div className={`road-grate${colliding || escaping ? " is-firing" : ""}`}>{state !== "current" && state !== "crashed" && state !== "passed" && <AmbientFlame lane={lane} />}</div>
            {colliding && <FireBurst key={`collision:${roundKey}`} />}
            {escaping && <FireBurst key={`escape:${roundKey}:${lane}`} className="road-fx-escape" />}
          </div>;
        })}
        <div className={`road-character-layer${moving ? " is-hopping" : ""}${phase === "crashed" && !moving ? " is-crashed" : ""}`} style={{ "--lane": visibleLane }}>
          <div className="road-shadow" />
          {phase === "crashed" && !moving ? <div className="road-chicken" role="img" aria-label="Roasted chicken after a collision"><Roast plate /></div>
            : <ChickenCharacter />}
        </div>
      </div>
      {result && !moving && <div className={`road-result ${result.type}`} role="status">
        <strong>{result.title}</strong><span>{result.detail}</span>
      </div>}
    </section>

    <section className="road-dock" aria-label="Game controls">
      <div className="road-controls">
        <div className="road-stake">
          <div className="road-amount">
            <button onClick={onMinimum} disabled={locked} aria-label={minimumLabel}>MIN</button>
            <input aria-label={stakeLabel} inputMode="decimal" value={stake} onChange={(event) => onStakeChange(event.target.value)} disabled={locked} maxLength={9} />
            <button onClick={onMaximum} disabled={locked} aria-label={maximumLabel}>MAX</button>
          </div>
          <div className="road-presets" aria-label={presetLabel}>{presets.map((value) => <button key={value} onClick={() => onPreset(value)} disabled={locked}>{value} <span aria-hidden="true">◉</span></button>)}</div>
        </div>
        <div className="road-difficulty">
          <div className="road-risk"><span>Difficulty</span><span>Chance of collision <span title={chanceHint}>ⓘ</span></span></div>
          <div className="road-segments" role="group" aria-label="Difficulty">{difficulties.map(({ id, label }) => <button key={id} aria-pressed={difficulty === id} disabled={locked} onClick={() => onDifficulty(id)}>{label}</button>)}</div>
        </div>
        <div className="road-actions">
          {phase === "playing" || moving ? <>
            <button className="road-button road-button--cash" disabled={moving || cashOutDisabled} onClick={() => onAction("CASH_OUT")} data-testid="road-cashout"><span>CASH OUT</span><strong>{cashOutText} <small>◉</small></strong></button>
            <button className="road-button road-button--play" disabled={moving || goDisabled} onClick={() => onAction("HOP")} data-testid="road-go">{moving ? "…" : "GO"}</button>
          </> : <>
            <button className="road-button road-button--auto" disabled={actionDisabled} onClick={() => onDialogChange("auto")} aria-label="Auto play information"><RotateCw size={44} /><span>Auto</span></button>
            <button className="road-button road-button--play" disabled={playDisabled || actionDisabled} onClick={() => onAction("PLAY")} data-testid="road-play">Play</button>
          </>}
        </div>
      </div>
      {error && <p className="road-form-error" role="alert">{error}</p>}
      <footer className="road-footer"><span>18+ · Play responsibly</span><span className="road-history">{historyText}</span><button onClick={() => onDialogChange("rules")}>{rulesLabel}</button></footer>
    </section>


    {dialog && <RoadDialog title={dialog.title} onClose={() => onDialogChange(null)}>
      {dialog.content}
      <button className="road-button road-button--play" onClick={() => onDialogChange(null)}>Got it</button>
    </RoadDialog>}
  </main>;
}
