/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import Unity from "react-unity-webgl";
import "./crash.scss";
import Context from "../../context";
import aviatorLogo from "../../assets/images/logo.svg";
import { aviatorUnityContext } from "../../unity";
import { playGameSound } from "../../sound";

export default function WebGLStarter() {
	const { GameState, currentNum, time, setCurrentTarget, latestRoundNumber } = React.useContext(Context)
	const [target, setTarget] = React.useState(1);
	const [waiting, setWaiting] = React.useState(0);
	const [flightSeconds, setFlightSeconds] = React.useState(0);
	const [unityLoaded, setUnityLoaded] = React.useState(false);
	const [unityFailed, setUnityFailed] = React.useState(false);
	const lastUnityState = React.useRef(0);
	const [rendererSyncKey, setRendererSyncKey] = React.useState("");
	const stateReady = GameState === "BET" || GameState === "PLAYING" || GameState === "GAMEEND";
	const phaseSyncKey = `${latestRoundNumber || 0}:${GameState}`;
	const rendererReady = stateReady && unityLoaded && !unityFailed && rendererSyncKey === phaseSyncKey;

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

	React.useEffect(() => {
		let myInterval;
		if (GameState === "PLAYING") {
			let startTime = Date.now() - time;
			let currentTime;
			let computedMultiplier;
			const getCurrentTime = () => {
				currentTime = (Date.now() - startTime) / 1000;
				setFlightSeconds(currentTime);
				const curve = 1 + 0.06 * currentTime + Math.pow((0.06 * currentTime), 2) - Math.pow((0.04 * currentTime), 3) + Math.pow((0.04 * currentTime), 4);
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
		if (!rendererReady || GameState !== "PLAYING") return;
		const nextState = target > 10 ? 4 : target > 2 ? 3 : 2;
		if (lastUnityState.current === nextState) return;
		lastUnityState.current = nextState;
		aviatorUnityContext.send("GameManager", "RequestToken", JSON.stringify({ gameState: nextState }));
	}, [GameState, rendererReady, target]);

	return (
		<div className="crash-container">
			<div className={`space-box ${rendererReady ? "github-visual-ready" : "renderer-pending"}`} id="space" data-server-state-ready={stateReady ? "true" : "false"} data-renderer-ready={rendererReady ? "true" : "false"}>
				<Unity
					unityContext={aviatorUnityContext}
					matchWebGLToCanvasSize={true}
					className="github-unity-stage"
				/>
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
