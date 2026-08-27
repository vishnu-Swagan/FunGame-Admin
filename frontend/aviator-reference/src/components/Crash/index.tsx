/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import Unity from "react-unity-webgl";
import "./crash.scss";
import Context from "../../context";
import aviatorLogo from "../../assets/images/logo.svg";
import aviatorCraft from "../../assets/images/aviator-craft.svg";
import { aviatorUnityContext } from "../../unity";
import { playGameSound } from "../../sound";

const RENDERER_STARTUP_LIMIT_MS = 3500;
const FLIGHT_HOVER_PROGRESS = 0.82;
const flightCurveValue = (seconds: number) => (
	1
	+ (0.06 * seconds)
	+ Math.pow(0.06 * seconds, 2)
	- Math.pow(0.04 * seconds, 3)
	+ Math.pow(0.04 * seconds, 4)
);

export default function WebGLStarter() {
	const { GameState, currentNum, time, setCurrentTarget, latestRoundNumber } = React.useContext(Context)
	const [target, setTarget] = React.useState(1);
	const [waiting, setWaiting] = React.useState(0);
	const [flightSeconds, setFlightSeconds] = React.useState(0);
	const [unityLoaded, setUnityLoaded] = React.useState(false);
	const [unityFailed, setUnityFailed] = React.useState(false);
	const [fallbackActive, setFallbackActive] = React.useState(false);
	const lastUnityState = React.useRef(0);
	const [rendererSyncKey, setRendererSyncKey] = React.useState("");
	const stateReady = GameState === "BET" || GameState === "PLAYING" || GameState === "GAMEEND";
	const phaseSyncKey = `${latestRoundNumber || 0}:${GameState}`;
	const unityRendererReady = stateReady && unityLoaded && !unityFailed && !fallbackActive && rendererSyncKey === phaseSyncKey;
	const rendererReady = stateReady && (unityRendererReady || fallbackActive);

	React.useEffect(() => {
		const handleLoaded = () => setUnityLoaded(true);
		const handleProgress = (progress: number) => {
			if (progress >= 1) setUnityLoaded(true);
		};
		const handleError = (error: unknown) => {
			// Unity 2021 emits this compatibility notice through the library's
			// error channel even though the bundled game continues normally.
			if (String(error).includes("Pointer_stringify")) return;
			console.error("Original Aviator renderer failed to load", error);
			setUnityFailed(true);
			setFallbackActive(true);
		};

		aviatorUnityContext.on("loaded", handleLoaded);
		aviatorUnityContext.on("progress", handleProgress);
		aviatorUnityContext.on("error", handleError);

		return () => {
			aviatorUnityContext.removeEventListener("loaded");
			aviatorUnityContext.removeEventListener("progress");
			aviatorUnityContext.removeEventListener("error");
		};
	}, []);

	// The bundled Unity scene is an enhancement, not a reason to block a live
	// round. Some browsers download all WebGL files successfully but never emit
	// Unity's final `loaded` callback. Move to the deterministic, server-driven
	// renderer after a short bounded wait. If Unity finishes later, it may take
	// over only after it has synchronised during the next BET phase. Keeping the
	// fallback for the active flight prevents two aircraft appearing at once.
	React.useEffect(() => {
		if (!stateReady || unityLoaded || fallbackActive) return undefined;
		const timeout = window.setTimeout(() => setFallbackActive(true), RENDERER_STARTUP_LIMIT_MS);
		return () => window.clearTimeout(timeout);
	}, [stateReady, unityLoaded, fallbackActive]);

	React.useEffect(() => {
		let myInterval;
		if (GameState === "PLAYING") {
			let startTime = Date.now() - time;
			let currentTime;
			let computedMultiplier;
			const getCurrentTime = () => {
				currentTime = (Date.now() - startTime) / 1000;
				setFlightSeconds(currentTime);
				const curve = flightCurveValue(currentTime);
				computedMultiplier = Math.max(1, Math.floor(curve * 100) / 100);
				setTarget(computedMultiplier);
				setCurrentTarget(computedMultiplier);
			}
			myInterval = setInterval(() => {
				getCurrentTime();
			}, 20);
		} else if (GameState === "GAMEEND") {
			setFlightSeconds(time / 1000);
			setCurrentTarget(Number(currentNum));
			setTarget(Number(currentNum));
		} else if (GameState === "BET") {
			setFlightSeconds(0);
			let startWaiting = Date.now() - time;
			setTarget(1);
			setCurrentTarget(1);

			myInterval = setInterval(() => {
				setWaiting(Date.now() - startWaiting);
			}, 20);
		}
		return () => clearInterval(myInterval);
	}, [GameState, time])

	const previousGameState = React.useRef("");
	React.useEffect(() => {
		if (GameState === previousGameState.current) return;
		previousGameState.current = GameState;
		if (GameState === "PLAYING") playGameSound("takeoff");
		if (GameState === "GAMEEND") playGameSound("flewAway");
	}, [GameState]);

	const [showLoading, setShowLoading] = React.useState(false);

	// Handle game state changes
	React.useEffect(() => {
		if (GameState === "BET") {
			setShowLoading(true);
		} else if (GameState === "PLAYING") {
			setShowLoading(false);
		} else if (GameState === "GAMEEND") {
			setShowLoading(false);
		}
	}, [GameState]);

	const displayedMultiplier = GameState === "PLAYING"
		? Math.max(target || 1, 1)
		: Math.max(Number(currentNum) || 1, 1);
	// Keep the aircraft motion tied to the already displayed, server-synchronised
	// multiplier. This changes presentation only; round outcomes remain wholly
	// server-authoritative. Reusing the same value at GAMEEND also prevents the
	// aircraft from jumping to a different position when a round settles.
	const continuousFlightMultiplier = flightCurveValue(Math.max(0, flightSeconds));
	const multiplierProgress = Math.min(
		FLIGHT_HOVER_PROGRESS,
		Math.max(0.035, Math.sqrt(Math.max(0, continuousFlightMultiplier - 1) / 1.2)),
	);
	const flightProgress = GameState === "PLAYING" || GameState === "GAMEEND"
		? multiplierProgress
		: 0;
	const verticalProgress = Math.min(
		0.88,
		(1.165 * Math.pow(flightProgress, 2)) + (0.35 * Math.pow(flightProgress, 3)),
	);
	const curveRemaining = 1 - flightProgress;
	const horizontalProgress = 1 - Math.pow(1 - flightProgress, 1.3);
	const planeStyle = {
		left: `${Math.min(78, 4 + (82 * horizontalProgress))}%`,
		bottom: `${4 + (94 * verticalProgress)}%`,
		transform: `translate(-2%, 55%) rotate(${-5 - (2.5 * flightProgress)}deg)`,
	};

	React.useLayoutEffect(() => {
		if (!stateReady || !unityLoaded || unityFailed) return undefined;
		const phaseState = GameState === "PLAYING" ? 2 : GameState === "GAMEEND" ? 5 : 1;
		lastUnityState.current = phaseState;
		aviatorUnityContext.send("GameManager", "RequestToken", JSON.stringify({ gameState: phaseState }));
		let secondFrame = 0;
		const firstFrame = window.requestAnimationFrame(() => {
			secondFrame = window.requestAnimationFrame(() => setRendererSyncKey(phaseSyncKey));
		});
		return () => {
			window.cancelAnimationFrame(firstFrame);
			window.cancelAnimationFrame(secondFrame);
		};
	}, [GameState, phaseSyncKey, stateReady, unityLoaded, unityFailed]);

	React.useEffect(() => {
		if (!fallbackActive || !unityLoaded || unityFailed) return;
		if (GameState !== "BET" || rendererSyncKey !== phaseSyncKey) return;
		setFallbackActive(false);
	}, [fallbackActive, unityLoaded, unityFailed, GameState, rendererSyncKey, phaseSyncKey]);

	React.useEffect(() => {
		if (!unityRendererReady || GameState !== "PLAYING") return;
		const nextState = target > 10 ? 4 : target > 2 ? 3 : 2;
		if (lastUnityState.current === nextState) return;
		lastUnityState.current = nextState;
		aviatorUnityContext.send("GameManager", "RequestToken", JSON.stringify({ gameState: nextState }));
	}, [GameState, unityRendererReady, target]);

	return (
		<div className="crash-container">
			<div className={`space-box ${unityRendererReady ? "github-visual-ready" : fallbackActive && stateReady ? "fallback-visual-ready" : "renderer-pending"}`} id="space" data-server-state-ready={stateReady ? "true" : "false"} data-renderer-ready={rendererReady ? "true" : "false"} data-renderer-mode={unityRendererReady ? "unity" : fallbackActive && stateReady ? "fallback" : "pending"}>
				<Unity
					unityContext={aviatorUnityContext}
					matchWebGLToCanvasSize={true}
					className="github-unity-stage"
				/>
				{fallbackActive && stateReady && <div className="fallback-flight-visual" aria-hidden="true">
					<svg className="flight-curve" viewBox="0 0 820 420" preserveAspectRatio="none">
						<defs>
							<linearGradient id="flight-area" x1="0" y1="1" x2="1" y2="0">
								<stop offset="0" stopColor="#e11942" stopOpacity="0.04" />
								<stop offset="1" stopColor="#e11942" stopOpacity="0.24" />
							</linearGradient>
						</defs>
						<path className="curve-fill" style={{ clipPath: `inset(0 ${100 - (horizontalProgress * 100)}% 0 0)` }} d="M0 420 C273 420 546 265 820 -186 L820 420 Z" />
						<path className="curve-shadow" pathLength="1" style={{ strokeDashoffset: curveRemaining }} d="M0 420 C273 420 546 265 820 -186" />
						<path className="curve-line" pathLength="1" style={{ strokeDashoffset: curveRemaining }} d="M0 420 C273 420 546 265 820 -186" />
					</svg>
					<img
						src={aviatorCraft}
						alt=""
						className={`plane ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""} ${GameState === "GAMEEND" ? "crashed" : ""}`}
						style={planeStyle}
					/>
					<div className={`center-logo ${GameState !== "BET" ? "hide" : ""}`}>
						<img src={aviatorLogo} alt="" />
						<span>Preparing live round</span>
					</div>
				</div>}
				<div className="aviator-renderer-gate" aria-live="polite">
					<img src={aviatorLogo} alt="Aviator" />
					<span>{unityFailed ? "Live renderer unavailable" : "Synchronising live round"}</span>
				</div>
				<div className="stage-grid" aria-hidden="true"></div>
				{stateReady && <div className={`round-state state-${GameState.toLowerCase()}`}>
					<span className="state-dot"></span>
					{GameState === "BET" ? "Next round" : GameState === "PLAYING" ? "Live round" : "Round ended"}
				</div>}
				<div
					className={`flight-timer ${stateReady && (GameState === "PLAYING" || GameState === "GAMEEND") ? "show" : ""} ${GameState === "GAMEEND" ? "stopped" : ""}`}
					aria-live="off"
				>
					<span>Flight time</span>
					<strong>{flightSeconds.toFixed(1)}s</strong>
				</div>
				<div className={`flew-away ${stateReady && GameState === "GAMEEND" ? 'show' : ''}`}>FLEW AWAY!</div>
				<div className={`multiplier ${stateReady && GameState !== "BET" ? 'show' : ''} ${GameState === "GAMEEND" ? 'crashed' : ''}`} aria-live="polite">
					{stateReady && GameState !== "BET" ? `${displayedMultiplier.toFixed(2)}x` : null}
				</div>
				<div className={`loading-container ${stateReady && showLoading ? 'show-loading' : ''}`}>
					<div className="loading-bar">
						<div 
							className="loading-fill" 
							id="fill"
							style={{ 
								width: showLoading ? `${Math.max(0, Math.min(100, (5000 - waiting) * 100 / 5000))}%` : '0%',
								animation: showLoading ? 'loadingRightToLeft 5s linear forwards' : 'none'
							}}
						></div>
					</div>
					<div className="loading-text">Preparing next round</div>
				</div>
			</div>
		</div>
	);
};
