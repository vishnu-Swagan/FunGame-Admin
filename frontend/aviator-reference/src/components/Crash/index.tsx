/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import Unity from "react-unity-webgl";
import "./crash.scss";
import Context from "../../context";
import aviatorLogo from "../../assets/images/logo.svg";
import aviatorCraft from "../../assets/images/aviator-craft.svg";
import { aviatorUnityContext } from "../../unity";
import { playGameSound } from "../../sound";

export default function WebGLStarter() {
	const { GameState, currentNum, time, setCurrentTarget } = React.useContext(Context)
	const [target, setTarget] = React.useState(1);
	const [waiting, setWaiting] = React.useState(0);
	const [flightSeconds, setFlightSeconds] = React.useState(0);
	const [unityLoaded, setUnityLoaded] = React.useState(false);
	const [unityFailed, setUnityFailed] = React.useState(false);
	const lastUnityState = React.useRef(0);

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

	const spaceRef = React.useRef<HTMLDivElement>(null);
	const planeRef = React.useRef<HTMLImageElement>(null);
	const [planeVisible, setPlaneVisible] = React.useState(false);
	const [showLoading, setShowLoading] = React.useState(false);
	const [showLogo, setShowLogo] = React.useState(true);
	const visualProgress = GameState === "BET"
		? 0
		: GameState === "GAMEEND"
			? 1
			: Math.min(0.94, 1 - Math.exp(-flightSeconds / 7));

	// Handle game state changes
	React.useEffect(() => {
		if (GameState === "BET") {
			setShowLoading(true);
			setShowLogo(true);
			setPlaneVisible(false);
			if (planeRef.current) {
				planeRef.current.style.transform = 'translate(0px, 0px) rotate(0deg)';
			}
		} else if (GameState === "PLAYING") {
			setShowLoading(false);
			setShowLogo(false);
			setPlaneVisible(true);
		} else if (GameState === "GAMEEND") {
			setPlaneVisible(true);
			if (planeRef.current) {
				const stageWidth = spaceRef.current?.clientWidth || 900;
				const stageHeight = spaceRef.current?.clientHeight || 500;
				const x = Math.min(stageWidth * 0.75, 720);
				const y = -Math.min(stageHeight * 0.64, 320);
				planeRef.current.style.transform = `translate(${x}px, ${y}px) rotate(-18deg)`;
			}
		}
	}, [GameState]);

	// Update plane position during game
	React.useEffect(() => {
		if (GameState === "PLAYING" && planeRef.current && target > 1) {
			const stageWidth = spaceRef.current?.clientWidth || 900;
			const stageHeight = spaceRef.current?.clientHeight || 500;
			const maxX = Math.min(stageWidth * 0.75, 720);
			const maxY = Math.min(stageHeight * 0.64, 320);
			const x = maxX * visualProgress;
			const y = -maxY * visualProgress;
			const rot = -18 * visualProgress;
			planeRef.current.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
		}
	}, [target, GameState, visualProgress]);

	const displayedMultiplier = GameState === "PLAYING"
		? Math.max(target || 1, 1)
		: Math.max(Number(currentNum) || 1, 1);
	const flightProgress = visualProgress;

	React.useEffect(() => {
		if (!unityLoaded || unityFailed) return;

		let nextState = 1;
		if (GameState === "PLAYING") {
			nextState = target > 10 ? 4 : target > 2 ? 3 : 2;
		} else if (GameState === "GAMEEND") {
			nextState = 5;
		}

		if (lastUnityState.current !== nextState) {
			lastUnityState.current = nextState;
			aviatorUnityContext.send("GameManager", "RequestToken", JSON.stringify({ gameState: nextState }));
		}
	}, [GameState, target, unityLoaded, unityFailed]);

	return (
		<div className="crash-container">
			<div className={`space-box ${unityLoaded && !unityFailed ? "github-visual-ready" : ""}`} ref={spaceRef} id="space">
				<Unity
					unityContext={aviatorUnityContext}
					matchWebGLToCanvasSize={true}
					className="github-unity-stage"
				/>
				<div className="stage-grid" aria-hidden="true"></div>
				<div className={`round-state state-${GameState.toLowerCase()}`}>
					<span className="state-dot"></span>
					{GameState === "BET" ? "Next round" : GameState === "PLAYING" ? "Live round" : "Round ended"}
				</div>
				<div
					className={`flight-timer ${GameState === "PLAYING" || GameState === "GAMEEND" ? "show" : ""} ${GameState === "GAMEEND" ? "stopped" : ""}`}
					aria-live="off"
				>
					<span>Flight time</span>
					<strong>{flightSeconds.toFixed(1)}s</strong>
				</div>
				<svg className={`flight-curve fallback-flight-visual ${GameState === "PLAYING" ? "active" : ""}`} viewBox="0 0 720 360" preserveAspectRatio="none" aria-hidden="true">
					<defs>
						<linearGradient id="flight-area" x1="0" y1="1" x2="1" y2="0">
							<stop offset="0" stopColor="#6f071b" stopOpacity="0.72" />
							<stop offset="0.68" stopColor="#c20b31" stopOpacity="0.65" />
							<stop offset="1" stopColor="#ed1742" stopOpacity="0.52" />
						</linearGradient>
					</defs>
					<path
						className="curve-fill"
						d="M 18 338 C 178 337, 255 318, 350 252 C 468 170, 516 73, 700 24 L 700 360 L 18 360 Z"
						style={{ clipPath: `inset(0 ${100 - (flightProgress * 100)}% 0 0)` }}
					/>
					<path className="curve-shadow" d="M 18 338 C 178 337, 255 318, 350 252 C 468 170, 516 73, 700 24" />
					<path
						className="curve-line"
						d="M 18 338 C 178 337, 255 318, 350 252 C 468 170, 516 73, 700 24"
						style={{ strokeDashoffset: 820 - (flightProgress * 820) }}
					/>
				</svg>
				<img 
					src={aviatorCraft}
					alt="Aviator craft"
					className={`plane fallback-flight-visual ${planeVisible ? 'visible' : ''} ${GameState === "GAMEEND" ? "crashed" : ""}`}
					ref={planeRef}
				/>
				{/* Unity owns the aircraft whenever it is available. Rendering a
				    second DOM flyout here caused the duplicate plane at crash. */}
				<div className={`flew-away ${GameState === "GAMEEND" ? 'show' : ''}`}>FLEW AWAY!</div>
				<div className={`multiplier ${GameState !== "BET" ? 'show' : ''} ${GameState === "GAMEEND" ? 'crashed' : ''}`} aria-live="polite">
					{GameState === "BET" ? '' : displayedMultiplier.toFixed(2)}x
				</div>
				<div className={`center-logo ${showLogo ? '' : 'hide'}`} id="ufcLogo">
					<img src={aviatorLogo} alt="Aviator" />
					<span>Real-time multiplayer crash</span>
				</div>
				<div className={`loading-container ${showLoading ? 'show-loading' : ''}`}>
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
