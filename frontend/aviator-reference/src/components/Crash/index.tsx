/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import "./crash.scss";
import Context from "../../context";
import aviatorCraft from "../../assets/images/aviator-craft-attachment.png";
import { playGameSound } from "../../sound";

const BETTING_WINDOW_MS = 5000;
const FLIGHT_HOVER_PROGRESS = 0.82;
const FLIGHT_VIEWBOX_WIDTH = 1000;
const FLIGHT_FLOOR_Y = 532;
const PLANE_WIDTH = 190;
const PLANE_HEIGHT = PLANE_WIDTH * (887 / 1774);
// The supplied aircraft's trail visually meets the lower rear spar, not the
// transparent image edge. Keep that attachment point locked to the curve tip.
const PLANE_TAIL_X = PLANE_WIDTH * (240 / 1774);
const PLANE_TAIL_Y = PLANE_HEIGHT * (840 / 887);
const PLANE_PROPELLER_X = PLANE_WIDTH * (1508 / 1774);
const PLANE_PROPELLER_Y = PLANE_HEIGHT * (354 / 887);
const PLANE_PROPELLER_RADIUS = PLANE_HEIGHT * 0.47;

export const flightCurveValue = (seconds: number) => (
	1
	+ (0.06 * seconds)
	+ Math.pow(0.06 * seconds, 2)
	- Math.pow(0.04 * seconds, 3)
	+ Math.pow(0.04 * seconds, 4)
);

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
		planeRotation: -7 - (5 * progress),
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
	const stateReady = GameState === "BET" || GameState === "PLAYING" || GameState === "GAMEEND";

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
	const flightGeometry = flightGeometryFor(flightProgress);
	const showFlightTrail = GameState === "PLAYING" || GameState === "GAMEEND";
	const bettingProgress = Math.max(0, Math.min(100, 100 - ((waiting / BETTING_WINDOW_MS) * 100)));

	return (
		<div className="crash-container">
			<div
				className={`space-box ${stateReady ? "native-visual-ready" : "renderer-pending"}`}
				id="space"
				data-server-state-ready={stateReady ? "true" : "false"}
				data-renderer-ready={stateReady ? "true" : "false"}
				data-renderer-mode={stateReady ? "native" : "pending"}
			>
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
								transform={`rotate(${flightGeometry.planeRotation.toFixed(2)} ${flightGeometry.tailX.toFixed(2)} ${flightGeometry.tailY.toFixed(2)})`}
							>
								<g className={`aircraft-sprite ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""}`}>
									<image
										href={aviatorCraft}
										data-flight-style="attachment-line-art"
										data-aircraft-asset="transparent-png"
										x={flightGeometry.planeX}
										y={flightGeometry.planeY}
										width={flightGeometry.planeWidth}
										height={flightGeometry.planeHeight}
										className={`plane ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""}`}
									/>
									<g transform={`translate(${flightGeometry.propellerX.toFixed(2)} ${flightGeometry.propellerY.toFixed(2)})`}>
										<g
											className={`aircraft-propeller ${GameState === "PLAYING" || GameState === "GAMEEND" ? "visible" : ""}`}
											data-propeller="spinning"
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
