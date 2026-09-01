/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import "./crash.scss";
import Context from "../../context";
import aviatorLogo from "../../assets/images/logo.svg";
import aviatorCraft from "../../assets/images/aviator-craft.svg";
import { playGameSound } from "../../sound";

// The plane reaches its hovering zone in the upper-right of the stage around
// this multiplier; after that it holds position while the number keeps climbing,
// exactly like the real Aviator flight. This is presentation only — round
// outcomes stay wholly server-authoritative.
const HOVER_MULTIPLIER = 2.2;
// A convex climb: nearly flat off the runway, then rising steeply.
const CURVE_EXPONENT = 1.72;
const CURVE_SAMPLES = 30;
// Deterministic default so the stage renders identically under SSR and tests
// where layout measurement is unavailable.
const DEFAULT_STAGE = { width: 900, height: 480 };

const flightCurveValue = (seconds: number) => (
	1
	+ (0.06 * seconds)
	+ Math.pow(0.06 * seconds, 2)
	- Math.pow(0.04 * seconds, 3)
	+ Math.pow(0.04 * seconds, 4)
);

type Stage = { width: number; height: number };

type FlightGeometry = {
	fillPath: string;
	linePath: string;
	planeX: number;
	planeY: number;
	planeAngle: number;
};

// Build the filled flight curve and the plane's position/pitch from a single
// parametric quadratic so the aircraft always rides exactly on the tip of the
// curve, rotated to its tangent. Everything is computed in the stage's own
// pixel space, so the plane and curve cannot drift apart at any aspect ratio.
const buildFlightGeometry = (stage: Stage, progress: number): FlightGeometry => {
	const width = stage.width || DEFAULT_STAGE.width;
	const height = stage.height || DEFAULT_STAGE.height;
	const startX = 0;
	const startY = height;
	const hoverX = width * 0.7;
	const hoverY = height * 0.17;
	const spanX = hoverX - startX;
	const spanY = hoverY - startY;
	const p = Math.max(0, Math.min(1, progress));

	let linePath = `M ${startX.toFixed(2)} ${startY.toFixed(2)}`;
	let planeX = startX;
	let planeY = startY;
	for (let i = 1; i <= CURVE_SAMPLES; i += 1) {
		const u = (i / CURVE_SAMPLES) * p;
		const x = startX + (spanX * u);
		const y = startY + (spanY * Math.pow(u, CURVE_EXPONENT));
		linePath += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
		planeX = x;
		planeY = y;
	}
	const fillPath = `${linePath} L ${planeX.toFixed(2)} ${startY.toFixed(2)} Z`;

	// Tangent of the curve at the plane's position (dy/dx). Screen y grows
	// downward, so a rising curve yields a negative angle (nose up).
	const derivativeU = spanX;
	const derivativeV = spanY * CURVE_EXPONENT * Math.pow(Math.max(p, 1e-3), CURVE_EXPONENT - 1);
	const planeAngle = (Math.atan2(derivativeV, derivativeU) * 180) / Math.PI;

	return { fillPath, linePath, planeX, planeY, planeAngle };
};

export default function WebGLStarter() {
	const { GameState, currentNum, time, setCurrentTarget } = React.useContext(Context);
	const [target, setTarget] = React.useState(1);
	const [waiting, setWaiting] = React.useState(0);
	const [flightSeconds, setFlightSeconds] = React.useState(0);
	const [showLoading, setShowLoading] = React.useState(false);
	const [stage, setStage] = React.useState<Stage>(DEFAULT_STAGE);
	const stageRef = React.useRef<HTMLDivElement | null>(null);

	const stateReady = GameState === "BET" || GameState === "PLAYING" || GameState === "GAMEEND";
	const inFlight = GameState === "PLAYING" || GameState === "GAMEEND";

	// Keep the flight geometry locked to the stage's real pixel size so the
	// plane and curve line up on every screen. Falls back to DEFAULT_STAGE when
	// measurement is unavailable (SSR / jsdom).
	React.useLayoutEffect(() => {
		const node = stageRef.current;
		if (!node) return undefined;
		const measure = () => {
			const rect = node.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				setStage((previous) => (
					previous.width === rect.width && previous.height === rect.height
						? previous
						: { width: rect.width, height: rect.height }
				));
			}
		};
		measure();
		let observer: ResizeObserver | undefined;
		if (typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(measure);
			observer.observe(node);
		}
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
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
				const curve = flightCurveValue(currentTime);
				computedMultiplier = Math.max(1, Math.floor(curve * 100) / 100);
				setTarget(computedMultiplier);
				setCurrentTarget(computedMultiplier);
			};
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
	}, [GameState, time]);

	const previousGameState = React.useRef("");
	React.useEffect(() => {
		if (GameState === previousGameState.current) return;
		previousGameState.current = GameState;
		if (GameState === "PLAYING") playGameSound("takeoff");
		if (GameState === "GAMEEND") playGameSound("flewAway");
	}, [GameState]);

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

	// Drive the aircraft motion from the same server-synchronised flight time
	// that produces the on-screen multiplier. Presentation only — outcomes stay
	// server-authoritative, and reusing this value at GAMEEND keeps the aircraft
	// from jumping when a round settles.
	const continuousFlightMultiplier = flightCurveValue(Math.max(0, flightSeconds));
	const rawProgress = Math.sqrt(
		Math.max(0, continuousFlightMultiplier - 1) / (HOVER_MULTIPLIER - 1),
	);
	const flightProgress = inFlight ? Math.min(1, rawProgress) : 0;
	const geometry = React.useMemo(
		() => buildFlightGeometry(stage, flightProgress),
		[stage.width, stage.height, flightProgress],
	);
	const planeStyle = {
		left: `${geometry.planeX.toFixed(2)}px`,
		top: `${geometry.planeY.toFixed(2)}px`,
		transform: `translate(-42%, -58%) rotate(${geometry.planeAngle.toFixed(2)}deg)`,
	};

	const rendererMode = stateReady ? "flight" : "pending";

	return (
		<div className="crash-container">
			<div
				className={`space-box ${stateReady ? "flight-visual-ready" : "renderer-pending"}`}
				id="space"
				ref={stageRef}
				data-server-state-ready={stateReady ? "true" : "false"}
				data-renderer-ready={stateReady ? "true" : "false"}
				data-renderer-mode={rendererMode}
			>
				<div className="stage-grid" aria-hidden="true"></div>
				{stateReady && <div className="flight-stage" aria-hidden="true">
					{inFlight && <svg className="flight-curve" viewBox={`0 0 ${stage.width} ${stage.height}`} preserveAspectRatio="none">
						<defs>
							<linearGradient id="flight-area" x1="0" y1="1" x2="0.15" y2="0">
								<stop offset="0" stopColor="#c8102e" stopOpacity="0.78" />
								<stop offset="0.55" stopColor="#e11942" stopOpacity="0.9" />
								<stop offset="1" stopColor="#ff2d55" stopOpacity="0.96" />
							</linearGradient>
						</defs>
						<path className="curve-fill" d={geometry.fillPath} />
						<path className="curve-glow" d={geometry.linePath} />
						<path className="curve-line" d={geometry.linePath} />
					</svg>}
					{inFlight && <div
						className={`plane-anchor ${GameState === "GAMEEND" ? "crashed" : ""}`}
						style={planeStyle}
					>
						<img
							src={aviatorCraft}
							alt=""
							className={`plane ${inFlight ? "visible" : ""} ${GameState === "GAMEEND" ? "crashed" : ""}`}
						/>
					</div>}
					<div className={`center-logo ${GameState !== "BET" ? "hide" : ""}`}>
						<img src={aviatorLogo} alt="" />
					</div>
				</div>}
				<div className="aviator-renderer-gate" aria-live="polite">
					<img src={aviatorLogo} alt="Aviator" />
					<span>Synchronising live round</span>
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
					<div className="loading-text">WAITING FOR NEXT ROUND</div>
				</div>
			</div>
		</div>
	);
};
