/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import "./crash.scss";
import Context from "../../context";
import aviatorLogo from "../../assets/images/logo.svg";
import { ReactComponent as AviatorCraft } from "../../assets/images/aviator-craft.svg";
import { aviatorUnityContext } from "../../unity";
import { playGameSound } from "../../sound";

const BETTING_WINDOW_MS = 5000;
const FLIGHT_HOVER_PROGRESS = 0.82;
const REDUCED_MOTION_PLANE_PROGRESS = 0.035;
const RADIAL_RAY_ANGLES = Array.from({ length: 24 }, (_, index) => index * 15);
// The bundled Unity project has no editable source, so its opaque canvas cannot
// expose independent atmosphere and propeller layers. Keep it available as a
// reversible presentation fallback, while the server-driven React renderer is
// the primary visual surface. Round state and outcomes remain unchanged.
const REACT_RENDERER_PRIMARY = true;
const flightCurveValue = (seconds: number) => (
	1
	+ (0.06 * seconds)
	+ Math.pow(0.06 * seconds, 2)
	- Math.pow(0.04 * seconds, 3)
	+ Math.pow(0.04 * seconds, 4)
);

export const interpolateVisualProgress = (
	currentProgress: number,
	targetProgress: number,
	deltaMs: number,
) => {
	const interpolationStep = Math.min(1, Math.max(0, deltaMs) / VISUAL_INTERPOLATION_MS);
	return currentProgress + ((targetProgress - currentProgress) * interpolationStep);
};

export const flightGeometryFor = (rawProgress: number) => {
	const progress = Math.max(0.035, Math.min(FLIGHT_HOVER_PROGRESS, rawProgress));
	const horizontalProgress = 1 - Math.pow(1 - progress, 1.3);
	const verticalProgress = Math.min(
		0.88,
		(1.165 * Math.pow(progress, 2)) + (0.35 * Math.pow(progress, 3)),
	);
	const tailX = 28 + (810 * horizontalProgress);
	const tailY = FLIGHT_FLOOR_Y - (420 * verticalProgress);
	const firstControlX = tailX * 0.34;
	const secondControlX = tailX * 0.76;
	const secondControlY = tailY + Math.max(42, (FLIGHT_FLOOR_Y - tailY) * 0.42);
	const horizontalDerivative = 810 * 1.3 * Math.pow(Math.max(0.001, 1 - progress), 0.3);
	const verticalDerivative = 420 * (
		(2.33 * progress) + (1.05 * Math.pow(progress, 2))
	);
	const rawTangentDegrees = Math.atan2(verticalDerivative, horizontalDerivative) * (180 / Math.PI);
	const restrainedTangentRotation = -Math.min(12, Math.max(7, 6.7 + (rawTangentDegrees * 0.09)));
	const path = [
		`M 4 ${FLIGHT_FLOOR_Y}`,
		`C ${firstControlX.toFixed(2)} ${FLIGHT_FLOOR_Y}`,
		`${secondControlX.toFixed(2)} ${secondControlY.toFixed(2)}`,
		`${tailX.toFixed(2)} ${tailY.toFixed(2)}`,
	].join(" ");

	return {
		path,
		fillPath: `${path} L ${tailX.toFixed(2)} ${FLIGHT_FLOOR_Y} L 4 ${FLIGHT_FLOOR_Y} Z`,
		tailX,
		tailY,
		planeX: tailX - PLANE_TAIL_X,
		planeY: tailY - PLANE_TAIL_Y,
		planeRotation: restrainedTangentRotation,
		planeWidth: PLANE_WIDTH,
		planeHeight: PLANE_HEIGHT,
		propellerX: tailX - PLANE_TAIL_X + PLANE_PROPELLER_X,
		propellerY: tailY - PLANE_TAIL_Y + PLANE_PROPELLER_Y,
		propellerRadius: PLANE_PROPELLER_RADIUS,
	};
};

export default function CrashStage() {
	const { GameState, currentNum, time, setCurrentTarget, latestRoundNumber } = React.useContext(Context);
	const [target, setTarget] = React.useState(1);
	const [waiting, setWaiting] = React.useState(0);
	const [flightSeconds, setFlightSeconds] = React.useState(0);
	const [unityLoaded, setUnityLoaded] = React.useState(false);
	const [unityFailed, setUnityFailed] = React.useState(false);
	const [fallbackActive, setFallbackActive] = React.useState(REACT_RENDERER_PRIMARY);
	const lastUnityState = React.useRef(0);
	const [rendererSyncKey, setRendererSyncKey] = React.useState("");
	const [decorativeMotionPaused, setDecorativeMotionPaused] = React.useState(
		() => typeof document !== "undefined" && document.hidden,
	);
	const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(
		() => typeof window !== "undefined"
			&& typeof window.matchMedia === "function"
			&& window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const planeExitRef = React.useRef<HTMLDivElement>(null);
	const propellerAnimationRef = React.useRef<Animation | null>(null);
	const stateReady = GameState === "BET" || GameState === "PLAYING" || GameState === "GAMEEND";
	const phaseSyncKey = `${latestRoundNumber || 0}:${GameState}`;
	const unityRendererReady = !REACT_RENDERER_PRIMARY && stateReady && unityLoaded && !unityFailed && !fallbackActive && rendererSyncKey === phaseSyncKey;
	const reactRendererReady = stateReady && (REACT_RENDERER_PRIMARY || fallbackActive);
	const rendererReady = stateReady && (unityRendererReady || reactRendererReady);
	const rendererMode = unityRendererReady ? "unity" : reactRendererReady ? "react" : "pending";
	const visualPhase = GameState === "PLAYING"
		? "is-flying"
		: GameState === "GAMEEND"
			? "is-ended"
			: "is-waiting";

	React.useEffect(() => {
		const syncVisibility = () => setDecorativeMotionPaused(document.hidden);
		document.addEventListener("visibilitychange", syncVisibility);
		syncVisibility();
		return () => document.removeEventListener("visibilitychange", syncVisibility);
	}, []);

	React.useEffect(() => {
		if (typeof window.matchMedia !== "function") return undefined;
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const syncPreference = () => setPrefersReducedMotion(query.matches);
		query.addEventListener?.("change", syncPreference);
		syncPreference();
		return () => query.removeEventListener?.("change", syncPreference);
	}, []);

	React.useEffect(() => {
		if (REACT_RENDERER_PRIMARY) return undefined;
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

	React.useEffect(() => {
		if (typeof window.matchMedia !== "function") return undefined;
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const syncPreference = () => setPrefersReducedMotion(query.matches);
		query.addEventListener?.("change", syncPreference);
		syncPreference();
		return () => query.removeEventListener?.("change", syncPreference);
	}, []);

	React.useEffect(() => {
		let interval: number | undefined;
		if (GameState === "PLAYING") {
			const startTime = Date.now() - time;
			const updateFlight = () => {
				const currentTime = Math.max(0, (Date.now() - startTime) / 1000);
				setFlightSeconds(currentTime);
				const computedMultiplier = Math.max(1, Math.floor(flightCurveValue(currentTime) * 100) / 100);
				setTarget(computedMultiplier);
				setCurrentTarget(computedMultiplier);
			};
			updateFlight();
			interval = window.setInterval(updateFlight, 20);
		} else if (GameState === "GAMEEND") {
			setFlightSeconds(time / 1000);
			setCurrentTarget(Number(currentNum));
			setTarget(Number(currentNum));
		} else if (GameState === "BET") {
			const startWaiting = Date.now() - time;
			setFlightSeconds(0);
			setTarget(1);
			setCurrentTarget(1);
			setWaiting(Math.max(0, time));
			interval = window.setInterval(() => {
				setWaiting(Math.max(0, Date.now() - startWaiting));
			}, 20);
		}
		return () => {
			if (interval !== undefined) window.clearInterval(interval);
		};
	}, [GameState, time]);

	const previousGameState = React.useRef("");
	React.useEffect(() => {
		if (GameState === previousGameState.current) return;
		previousGameState.current = GameState;
		if (GameState === "PLAYING") playGameSound("takeoff");
		if (GameState === "GAMEEND") playGameSound("flewAway");
	}, [GameState]);

	const displayedMultiplier = GameState === "PLAYING"
		? Math.max(target || 1, 1)
		: Math.max(Number(currentNum) || 1, 1);
	const continuousFlightMultiplier = flightCurveValue(Math.max(0, flightSeconds));
	const multiplierProgress = Math.min(
		FLIGHT_HOVER_PROGRESS,
		Math.max(0.035, Math.sqrt(Math.max(0, continuousFlightMultiplier - 1) / 1.2)),
	);
	const flightProgress = GameState === "PLAYING" || GameState === "GAMEEND"
		? multiplierProgress
		: 0;
	const planeFlightProgress = prefersReducedMotion && flightProgress > 0
		? REDUCED_MOTION_PLANE_PROGRESS
		: flightProgress;
	const planeVerticalProgress = Math.min(
		0.88,
		(1.165 * Math.pow(planeFlightProgress, 2)) + (0.35 * Math.pow(planeFlightProgress, 3)),
	);
	const curveMotionProgress = prefersReducedMotion && flightProgress > 0
		? REDUCED_MOTION_PLANE_PROGRESS
		: flightProgress;
	const curveRemaining = 1 - curveMotionProgress;
	const horizontalProgress = 1 - Math.pow(1 - curveMotionProgress, 1.3);
	const planeHorizontalProgress = 1 - Math.pow(1 - planeFlightProgress, 1.3);
	const horizontalTravel = Math.min(74, 82 * planeHorizontalProgress);
	const verticalTravel = Math.min(82.72, 94 * planeVerticalProgress);
	const horizontalDerivative = 82 * 1.3 * Math.pow(Math.max(0.001, 1 - planeFlightProgress), 0.3);
	const verticalDerivative = 94 * (
		(2.33 * planeFlightProgress) + (1.05 * Math.pow(planeFlightProgress, 2))
	);
	const rawTangentDegrees = Math.atan2(verticalDerivative, horizontalDerivative) * (180 / Math.PI);
	// The artwork is intentionally kept within the restrained 7–12° pitch seen
	// in the reference, but its pitch still responds to the local curve tangent.
	const planeAngle = -Math.min(12, Math.max(7, 6.4 + (rawTangentDegrees * 0.14)));
	const planeStyle = {
		transform: `translate3d(${horizontalTravel}cqw, ${-verticalTravel}cqh, 0) translate(-2%, 55%) rotate(${planeAngle}deg)`,
	};

	// CSS is the no-WAAPI fallback. In modern browsers, Web Animations lets the
	// crash coast start from the propeller's actual phase, avoiding a zero-degree
	// snap while keeping flight positioning and propeller rotation independent.
	React.useLayoutEffect(() => {
		const propeller = planeExitRef.current?.querySelector<SVGGraphicsElement>(".plane-propeller");
		if (!propeller || typeof propeller.animate !== "function") return;

		propeller.dataset.motionDriver = "waapi";
		const computedTransform = window.getComputedStyle(propeller).transform;
		const matrix = computedTransform.match(/^matrix\(([^)]+)\)$/)?.[1]
			.split(",")
			.map((value) => Number(value.trim()));
		const currentAngle = matrix && matrix.length >= 2
			? Math.atan2(matrix[1], matrix[0]) * (180 / Math.PI)
			: 0;

		propellerAnimationRef.current?.cancel();
		propellerAnimationRef.current = null;

		if (prefersReducedMotion || GameState === "BET") {
			propeller.style.transform = "rotate(0deg)";
			return;
		}

		propeller.style.transform = `rotate(${currentAngle}deg)`;
		const isFlying = GameState === "PLAYING";
		propellerAnimationRef.current = propeller.animate(
			[
				{ transform: `rotate(${currentAngle}deg)` },
				{ transform: `rotate(${currentAngle + (isFlying ? 360 : 150)}deg)` },
			],
			{
				duration: isFlying ? 110 : 200,
				iterations: isFlying ? Infinity : 1,
				easing: isFlying ? "linear" : "cubic-bezier(0.23, 1, 0.32, 1)",
				fill: "forwards",
			},
		);
	}, [GameState, prefersReducedMotion, reactRendererReady]);

	React.useEffect(() => {
		const animation = propellerAnimationRef.current;
		if (!animation) return;
		if (decorativeMotionPaused) animation.pause();
		else if (animation.playState === "paused") animation.play();
	}, [decorativeMotionPaused, GameState]);

	React.useEffect(() => () => {
		propellerAnimationRef.current?.cancel();
		propellerAnimationRef.current = null;
	}, []);

	React.useLayoutEffect(() => {
		if (REACT_RENDERER_PRIMARY || !stateReady || !unityLoaded || unityFailed) return undefined;
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

		cancelVisualFrame();
		if (GameState !== "PLAYING" || prefersReducedMotion || decorativeMotionPaused) {
			return cancelVisualFrame;
		}

		// Entering or resuming a live round starts from the latest authoritative
		// sample. Subsequent 20 ms logic samples only retarget this visual loop.
		visualProgressRef.current = visualTargetProgressRef.current;
		setVisualFlightProgress(visualTargetProgressRef.current);

		const updateVisualProgress = (timestamp: number) => {
			const previousTimestamp = visualLastFrameRef.current ?? timestamp;
			const deltaMs = Math.min(64, Math.max(0, timestamp - previousTimestamp));
			visualLastFrameRef.current = timestamp;

			const nextProgress = interpolateVisualProgress(
				visualProgressRef.current,
				visualTargetProgressRef.current,
				deltaMs,
			);
			visualProgressRef.current = nextProgress;
			setVisualFlightProgress((previousProgress) => (
				Math.abs(previousProgress - nextProgress) < 0.00001
					? previousProgress
					: nextProgress
			));
			visualAnimationFrameRef.current = window.requestAnimationFrame(updateVisualProgress);
		};

		visualAnimationFrameRef.current = window.requestAnimationFrame(updateVisualProgress);
		return cancelVisualFrame;
	}, [GameState, prefersReducedMotion, decorativeMotionPaused]);

	const flightGeometry = flightGeometryFor(visualFlightProgress);
	const showFlightTrail = GameState === "PLAYING" || GameState === "GAMEEND";
	const bettingProgress = Math.max(0, Math.min(100, 100 - ((waiting / BETTING_WINDOW_MS) * 100)));

	React.useLayoutEffect(() => {
		const propeller = propellerRef.current;
		if (!propeller || typeof propeller.animate !== "function") return;

		propeller.dataset.motionDriver = "waapi";
		const computedTransform = window.getComputedStyle(propeller).transform;
		const matrix = computedTransform.match(/^matrix\(([^)]+)\)$/)?.[1]
			.split(",")
			.map((value) => Number(value.trim()));
		const currentAngle = matrix && matrix.length >= 2
			? Math.atan2(matrix[1], matrix[0]) * (180 / Math.PI)
			: 0;

		propellerAnimationRef.current?.cancel();
		propellerAnimationRef.current = null;

		if (prefersReducedMotion || GameState === "BET") {
			propeller.style.transform = "rotate(0deg)";
			return;
		}

		propeller.style.transform = `rotate(${currentAngle}deg)`;
		const isFlying = GameState === "PLAYING";
		propellerAnimationRef.current = propeller.animate(
			[
				{ transform: `rotate(${currentAngle}deg)` },
				{ transform: `rotate(${currentAngle + (isFlying ? 360 : 150)}deg)` },
			],
			{
				duration: isFlying ? 110 : 200,
				iterations: isFlying ? Infinity : 1,
				easing: isFlying ? "linear" : "cubic-bezier(0.23, 1, 0.32, 1)",
				fill: "forwards",
			},
		);
	}, [GameState, prefersReducedMotion, stateReady]);

	React.useEffect(() => {
		if (REACT_RENDERER_PRIMARY || !fallbackActive || !unityLoaded || unityFailed) return;
		if (GameState !== "BET" || rendererSyncKey !== phaseSyncKey) return;
		setFallbackActive(false);
	}, [fallbackActive, unityLoaded, unityFailed, GameState, rendererSyncKey, phaseSyncKey]);

	React.useEffect(() => {
		if (REACT_RENDERER_PRIMARY || !unityRendererReady || GameState !== "PLAYING") return;
		const nextState = target > 10 ? 4 : target > 2 ? 3 : 2;
		if (lastUnityState.current === nextState) return;
		lastUnityState.current = nextState;
		aviatorUnityContext.send("GameManager", "RequestToken", JSON.stringify({ gameState: nextState }));
	}, [GameState, unityRendererReady, target]);

	return (
		<div className="crash-container">
			<div
				className={`space-box phase-${GameState.toLowerCase() || "pending"} ${unityRendererReady ? "github-visual-ready" : reactRendererReady ? "fallback-visual-ready" : "renderer-pending"}`}
				id="space"
				data-server-state-ready={stateReady ? "true" : "false"}
				data-renderer-ready={rendererReady ? "true" : "false"}
				data-renderer-mode={rendererMode}
				data-motion-paused={decorativeMotionPaused ? "true" : "false"}
			>
				{!REACT_RENDERER_PRIMARY && <Unity
					unityContext={aviatorUnityContext}
					matchWebGLToCanvasSize={true}
					className="github-unity-stage"
				/>}
				<div className="flight-atmosphere" aria-hidden="true">
					<svg className="flight-rays" viewBox="0 0 156 156" preserveAspectRatio="none">
						<defs>
							<path id="aviator-flight-ray-wedge" d="M32 124 L174 124 L173.1 140.1 Z" />
						</defs>
						<g className="flight-rays-rotor">
							{RADIAL_RAY_ANGLES.map((angle) => (
								<use key={angle} href="#aviator-flight-ray-wedge" transform={`rotate(${angle} 32 124)`} />
							))}
						</g>
					</svg>
					<div className="flight-glow">
						<div className="flight-glow-core" />
					</div>
				</div>
				{reactRendererReady && <div className="fallback-flight-visual" aria-hidden="true">
					<svg className="flight-curve" viewBox="0 0 820 420" preserveAspectRatio="none">
						<defs>
							<path id="aviator-flight-ray-wedge" d="M32 124 L174 124 L173.1 140.1 Z" />
						</defs>
						<g className="flight-rays-rotor">
							{RADIAL_RAY_ANGLES.map((angle) => (
								<use key={angle} href="#aviator-flight-ray-wedge" transform={`rotate(${angle} 32 124)`} />
							))}
						</g>
					</svg>
					<div
						className={`plane ${visualPhase} ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""} ${GameState === "GAMEEND" ? "crashed" : ""}`}
						style={planeStyle}
						data-motion-role="flight-position"
					>
						<div ref={planeExitRef} className="plane-exit-motion" data-motion-role="flight-exit">
							<AviatorCraft className="plane-craft" data-motion-role="aircraft-art" />
						</div>
					</div>
					<div className={`center-logo ${GameState !== "BET" ? "hide" : ""}`}>
						<img src={aviatorLogo} alt="" />
						<span>Preparing live round</span>
					</div>
				</div>
				{stateReady && (
					<div className="native-flight-visual" aria-hidden="true">
						<svg className="flight-curve" viewBox={`0 0 ${FLIGHT_VIEWBOX_WIDTH} 560`} preserveAspectRatio="none">
							<defs>
								<linearGradient id="flight-area" x1="0" y1="1" x2="1" y2="0">
									<stop offset="0" stopColor="#e11942" stopOpacity="0.04" />
									<stop offset="1" stopColor="#e11942" stopOpacity="0.24" />
								</linearGradient>
							</defs>
							{showFlightTrail && (
								<g className="flight-trail" data-flight-trail-state="active">
									<path className="curve-fill" d={flightGeometry.fillPath} />
									<path className="curve-shadow" d={flightGeometry.path} />
									<path
										className="curve-line"
										data-flight-trail="tail-locked"
										data-tail-x={flightGeometry.tailX.toFixed(2)}
										data-tail-y={flightGeometry.tailY.toFixed(2)}
										d={flightGeometry.path}
									/>
									<circle className="curve-tip" cx={flightGeometry.tailX} cy={flightGeometry.tailY} r="4" />
								</g>
							)}
							<g
								className={`plane-flight ${GameState === "GAMEEND" ? "crashed" : ""}`}
								data-tail-x={flightGeometry.tailX.toFixed(2)}
								data-tail-y={flightGeometry.tailY.toFixed(2)}
								transform={`translate(${flightGeometry.tailX.toFixed(2)} ${flightGeometry.tailY.toFixed(2)}) rotate(${flightGeometry.planeRotation.toFixed(2)})`}
							>
								<g className={`aircraft-sprite ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""}`}>
									<image
										href={aviatorCraft}
										data-flight-style="attachment-line-art"
										data-aircraft-asset="transparent-png"
										x={-PLANE_TAIL_X}
										y={-PLANE_TAIL_Y}
										width={flightGeometry.planeWidth}
										height={flightGeometry.planeHeight}
										className={`plane ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""}`}
									/>
									<g transform={`translate(${(-PLANE_TAIL_X + PLANE_PROPELLER_X).toFixed(2)} ${(-PLANE_TAIL_Y + PLANE_PROPELLER_Y).toFixed(2)})`}>
									<g
										ref={propellerRef}
										className={`aircraft-propeller ${visualPhase} ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""}`}
										data-propeller={GameState === "PLAYING" ? "spinning" : GameState === "GAMEEND" ? "coasting" : "stopped"}
										>
											<path
												className="propeller-blade"
												d={`M -2 -5 C -7 -18 -7 -33 0 -${flightGeometry.propellerRadius.toFixed(2)} C 8 -34 8 -18 3 -5 Z M 2 5 C 8 18 8 34 0 ${flightGeometry.propellerRadius.toFixed(2)} C -8 34 -8 18 -3 5 Z`}
											/>
											<circle className="propeller-hub" cx="0" cy="0" r="5" />
										</g>
									</g>
								</g>
							</g>
						</svg>
						<div className={`center-logo ${GameState !== "BET" ? "hide" : ""}`}>
							<div className="stage-brand" aria-hidden="true">
								<span>Chakri</span>
								<strong>Aviator</strong>
							</div>
							<small>Preparing live round</small>
						</div>
					</div>
				)}
				{!stateReady && (
					<div className="aviator-renderer-gate" aria-live="polite">
						<div className="stage-brand" aria-label="Chakri Aviator">
							<span>Chakri</span>
							<strong>Aviator</strong>
						</div>
						<span>Synchronising live round</span>
					</div>
				)}
				<div className="stage-grid" aria-hidden="true" />
				{stateReady && (
					<div className={`round-state state-${GameState.toLowerCase()}`}>
						<span className="state-dot" />
						<span>{GameState === "BET" ? "Next round" : GameState === "PLAYING" ? "Live round" : "Round ended"}</span>
						{latestRoundNumber > 0 && <small>#{latestRoundNumber}</small>}
					</div>
				)}
				<div className={`flight-timer ${stateReady && (GameState === "PLAYING" || GameState === "GAMEEND") ? "show" : ""} ${GameState === "GAMEEND" ? "stopped" : ""}`} aria-live="off">
					<span>Flight time</span>
					<strong>{flightSeconds.toFixed(1)}s</strong>
				</div>
				<div className={`flew-away ${stateReady && GameState === "GAMEEND" ? "show" : ""}`}>FLEW AWAY!</div>
				<div className={`multiplier ${stateReady && GameState !== "BET" ? "show" : ""} ${GameState === "GAMEEND" ? "crashed" : ""}`} aria-live="polite">
					{stateReady && GameState !== "BET" ? `${displayedMultiplier.toFixed(2)}x` : null}
				</div>
				<div className={`loading-container ${stateReady && GameState === "BET" ? "show-loading" : ""}`}>
					<div className="loading-bar">
						<div className="loading-fill" id="fill" style={{ width: `${bettingProgress}%` }} />
					</div>
					<div className="loading-text">Preparing next round</div>
				</div>
			</div>
		</div>
	);
}
