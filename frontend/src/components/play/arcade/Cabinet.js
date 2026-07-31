import { useLayoutEffect, useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X, Volume2, VolumeX } from "lucide-react";
import { isMuted, toggleMuted, onMuteChange } from "@/lib/sound";
import "./arcade.css";

/**
 * The cabinet: a fixed landscape screen, scaled to whatever it is shown on.
 *
 * The client's machines draw to one screen size and every layout is composed
 * against it — two paytables flanking a card rail, a button bar pinned to the
 * bottom edge, filigree that meets the frame at an exact point. Rebuilding
 * fifteen of those as fluid layouts would mean fifteen sets of breakpoint
 * decisions and fifteen chances for the ornament to stop lining up. Composing
 * against the same fixed canvas they were designed on, then scaling the whole
 * thing, keeps every screen identical to the reference on every device and
 * makes each new game a layout problem rather than a responsive one.
 *
 * ORIENTATION. These layouts are 2.16:1. On a phone held upright there is no
 * honest way to show one — shrunk to fit the width it is the height of a
 * postcard. So the cabinet asks for landscape, and when the browser will not
 * give it, rotates itself: the stage is laid out landscape and turned 90°, so
 * the player turns the handset and the game fills it. That is what the client's
 * own machines do, and it is why the reference screenshots are all sideways.
 *
 * The rest of the app stays portrait. Only the table rotates.
 */

/* The design canvas. Every game composes against exactly this, in these units,
   and never reads the viewport itself. */
export const CAB_W = 1600;
export const CAB_H = 740;

/** Ask Android for landscape. Silently unavailable on iOS, which is what the
 *  rotation fallback below is for. */
function lockLandscape() {
  const o = window.screen && window.screen.orientation;
  if (!o || typeof o.lock !== "function") return () => {};
  o.lock("landscape").catch(() => {});
  return () => { try { o.unlock(); } catch (e) { /* not locked */ } };
}

export const Cabinet = ({
  ground,                 // CSS background for the machine's screen
  children,
  onExit,
  exitTo,
  className = "",
  testId = "cabinet",
}) => {
  const navigate = useNavigate();
  const boxRef = useRef(null);
  const [fit, setFit] = useState({ scale: 1, rotate: false });
  const [muted, setMuted] = useState(isMuted());

  useEffect(() => onMuteChange(setMuted), []);
  useEffect(() => lockLandscape(), []);

  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      if (!box) return;
      const vw = box.clientWidth;
      const vh = box.clientHeight;
      if (!vw || !vh) return;

      /* Two candidate fits: as laid out, and turned 90°. Whichever draws the
         cabinet bigger wins, which picks rotation on a portrait phone and
         leaves a laptop alone without either being special-cased. */
      const flat = Math.min(vw / CAB_W, vh / CAB_H);
      const turned = Math.min(vh / CAB_W, vw / CAB_H);
      setFit(turned > flat ? { scale: turned, rotate: true } : { scale: flat, rotate: false });
    };

    measure();
    const ro = new ResizeObserver(measure);
    if (boxRef.current) ro.observe(boxRef.current);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  const leave = () => (onExit ? onExit() : navigate(exitTo || -1));

  return (
    <div ref={boxRef} className={`cab-viewport ${className}`} data-testid={testId}>
      <div
        className="cab-screen"
        style={{
          width: CAB_W,
          height: CAB_H,
          background: ground,
          transform: `translate(-50%, -50%) rotate(${fit.rotate ? 90 : 0}deg) scale(${fit.scale})`,
        }}
      >
        {/* Glass: a faint vignette and a sheen, so the art reads as something
            behind a screen rather than a flat page. */}
        <div className="cab-glass" aria-hidden="true" />
        {children}

        <div className="cab-syscontrols">
          <button type="button" onClick={toggleMuted} data-testid="cab-mute"
            aria-label={muted ? "Unmute" : "Mute"} className="cab-sysbtn">
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
          <button type="button" onClick={leave} data-testid="cab-exit"
            aria-label="Leave the table" className="cab-sysbtn cab-sysbtn-exit">
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
};
