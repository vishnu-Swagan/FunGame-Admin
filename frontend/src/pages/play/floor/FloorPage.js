// The 3D casino floor page. React owns the chrome (HUD, joystick, station
// card, enter overlay); FloorScene owns the canvas. Playing a game routes to
// the existing 2D screens — the server keeps settling every chip.

import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Volume2, VolumeX, Play, Gamepad2 } from "lucide-react";
import { useGames } from "@/lib/useGames";
import { FloorScene } from "./FloorScene";
import { FloorAudio } from "./audio";
import { layoutStations } from "./catalog3d";

function Joystick({ onMove }) {
  const baseRef = useRef(null);
  const [knob, setKnob] = useState([0, 0]);
  const active = useRef(false);

  const handle = useCallback(
    (e) => {
      const r = baseRef.current.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2);
      let dy = (e.clientY - cy) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      setKnob([dx, dy]);
      onMove(dx, -dy);
    },
    [onMove]
  );

  return (
    <div
      ref={baseRef}
      data-testid="floor-joystick"
      className="absolute bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-6 w-28 h-28 rounded-full border border-white/20 bg-white/5 backdrop-blur-sm touch-none select-none md:hidden"
      onPointerDown={(e) => { active.current = true; baseRef.current.setPointerCapture(e.pointerId); handle(e); }}
      onPointerMove={(e) => active.current && handle(e)}
      onPointerUp={() => { active.current = false; setKnob([0, 0]); onMove(0, 0); }}
      onPointerCancel={() => { active.current = false; setKnob([0, 0]); onMove(0, 0); }}
    >
      <div
        className="absolute w-12 h-12 rounded-full bg-white/25 border border-white/40"
        style={{ left: `calc(50% - 24px + ${knob[0] * 28}px)`, top: `calc(50% - 24px + ${knob[1] * 28}px)` }}
      />
    </div>
  );
}

export default function FloorPage() {
  const navigate = useNavigate();
  const { games, loading } = useGames();
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const audioRef = useRef(null);
  const [entered, setEntered] = useState(false);
  const [focused, setFocused] = useState(null);
  const [sound, setSound] = useState(true);

  // build the scene when the player enters (the click is also the audio unlock)
  const enter = useCallback(() => {
    if (sceneRef.current) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;
    const audio = new FloorAudio();
    audio.start();
    audioRef.current = audio;

    const scene = new FloorScene(canvasRef.current, {
      reducedMotion,
      onFocusStation: (st) => setFocused(st),
      onActivateStation: (st) => navigate(`/games/${st.slug}/play`),
      onTick: (_t, camera) => audio.updateListener(camera),
    });
    sceneRef.current = scene;
    setEntered(true);
  }, [navigate]);

  // feed the live catalog into the scene + audio emitters
  useEffect(() => {
    if (!entered || loading || !games.length) return;
    sceneRef.current?.setGames(games);
    const placed = layoutStations(games);
    for (const st of placed) audioRef.current?.addEmitter(st.kind, st.position);
  }, [entered, games, loading]);

  useEffect(() => {
    return () => {
      sceneRef.current?.dispose();
      audioRef.current?.dispose();
      sceneRef.current = null;
      audioRef.current = null;
    };
  }, []);

  const toggleSound = () => {
    setSound((s) => {
      audioRef.current?.setEnabled(!s);
      return !s;
    });
  };

  return (
    <div className="fixed inset-x-0 top-0 h-dvh bg-[#05060a] text-white overflow-hidden" data-testid="floor-page">
      <canvas ref={canvasRef} className="w-full h-full block" style={{ touchAction: "none" }} />

      {/* top HUD */}
      {entered && (
        <div className="absolute top-0 inset-x-0 flex items-center justify-between p-4 pt-[calc(1rem+env(safe-area-inset-top))] bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
          <button
            data-testid="floor-exit"
            onClick={() => navigate("/games")}
            className="pointer-events-auto flex items-center gap-2 rounded-full bg-white/10 border border-white/15 px-4 py-2 text-xs font-semibold hover:bg-white/20"
          >
            <ArrowLeft className="w-4 h-4" /> Lobby
          </button>
          <div className="text-center">
            <div className="text-sm font-black tracking-[0.3em] text-amber-300">CHAKRI</div>
            <div className="text-[10px] tracking-[0.4em] text-white/60">3D CASINO FLOOR</div>
          </div>
          <button
            data-testid="floor-sound-toggle"
            onClick={toggleSound}
            className="pointer-events-auto rounded-full bg-white/10 border border-white/15 p-2.5 hover:bg-white/20"
            aria-label={sound ? "Mute sound" : "Unmute sound"}
          >
            {sound ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
        </div>
      )}

      {/* station card */}
      {entered && focused && (
        <div
          data-testid="floor-station-card"
          className="absolute bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-10 w-[min(92vw,380px)] rounded-2xl border border-amber-300/25 bg-black/70 backdrop-blur-md p-4 shadow-[0_0_40px_rgba(255,200,80,0.15)]"
        >
          <div className="text-[10px] font-semibold tracking-[0.25em] text-amber-300/80 uppercase">{focused.category || "Game"}</div>
          <div className="text-xl font-black mt-0.5">{focused.name}</div>
          {focused.tagline && <div className="text-xs text-white/55 mt-1">{focused.tagline}</div>}
          <button
            data-testid="floor-station-play"
            onClick={() => { audioRef.current?.click(); navigate(`/games/${focused.slug}/play`); }}
            className="mt-3 w-full flex items-center justify-center gap-2 rounded-xl bg-amber-400 text-black font-bold py-3 text-sm hover:bg-amber-300 active:scale-[0.98] transition"
          >
            <Play className="w-4 h-4" /> Play {focused.name}
          </button>
        </div>
      )}

      {/* mobile joystick */}
      {entered && <Joystick onMove={(x, y) => sceneRef.current?.setJoystick(x, y)} />}

      {/* desktop hint */}
      {entered && (
        <div className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 hidden md:block text-[11px] text-white/40">
          WASD / arrows to walk · drag to look · tap a table to approach · Enter to play
        </div>
      )}

      {/* enter overlay */}
      {!entered && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0a0812] via-[#120a18] to-[#05060a] px-6 text-center">
          <div className="text-[11px] tracking-[0.5em] text-white/50 mb-3">WELCOME TO THE</div>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight bg-gradient-to-b from-amber-200 via-amber-400 to-amber-600 bg-clip-text text-transparent drop-shadow-[0_0_35px_rgba(255,190,60,0.35)]">
            CHAKRI 3D CASINO
          </h1>
          <p className="text-sm text-white/55 mt-4 max-w-sm">
            Walk a cinematic casino floor — every table and cabinet is one of your games, live from the lobby.
          </p>
          <button
            data-testid="floor-enter"
            onClick={enter}
            disabled={loading}
            className="mt-8 flex items-center gap-3 rounded-full bg-amber-400 text-black font-black tracking-wide px-8 py-4 text-base hover:bg-amber-300 active:scale-[0.97] transition disabled:opacity-50"
          >
            <Gamepad2 className="w-5 h-5" /> {loading ? "LOADING GAMES…" : "ENTER CASINO"}
          </button>
          <div className="text-[10px] text-white/35 mt-6">Headphones recommended — the floor uses 3D spatial audio.</div>
        </div>
      )}
    </div>
  );
}
