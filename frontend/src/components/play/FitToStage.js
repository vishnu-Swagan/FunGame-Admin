import { useLayoutEffect, useRef, useState } from "react";

/**
 * Scales a game board down until it fits the box it is given.
 *
 * Every table is authored at one size, but phones are not one size. The content
 * column is 430px at its widest and 328px on a 360px handset, and the stage's
 * height moves with the browser chrome. The boards themselves are fluid, but
 * what is inside them is not: a 104px panel, a 30px numeral, the glass dome and
 * the card faces are fixed pixels that do not shrink with the column. On a small
 * screen the table therefore spills out of its box and has to be scrolled to be
 * played, and text that sits comfortably side by side at 430px collides.
 *
 * Measuring both boxes and scaling the difference away keeps a table looking the
 * same on every device: the proportions authored at 430px are what a 360px phone
 * sees, only smaller. A transform is what does it, so nothing inside has to know
 * — and because layout geometry is read back through getBoundingClientRect,
 * which reports post-transform pixels, hit-testing keeps working untouched.
 *
 * Scaling stops at `min`, and the floor is set by the thumb rather than by the
 * eye. Controls in this app are built to a 44px minimum touch target; scaling
 * shrinks that along with everything else, and a betting chip that has become
 * 27px is one the player misses. 0.85 keeps the smallest control at ~37px,
 * which is still comfortably tappable. A board that would need to shrink past
 * that is one with genuinely long content rather than one slightly too big, so
 * below the floor it keeps its size and scrolls, exactly as it did before.
 */
export const FitToStage = ({ children, min = 0.85, fluid = false, className = "" }) => {
  const boxRef = useRef(null);
  const innerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [reserved, setReserved] = useState(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;

    /* The board is never laid out at its scaled size — a transform does not
       affect layout — so these stay the natural measurements however far it is
       being scaled. That is what stops the observer below from feeding on its
       own output. */
    const measure = () => {
      const bw = box.clientWidth;
      const iw = inner.scrollWidth;
      const ih = inner.scrollHeight;
      if (!bw || !iw || !ih) return;
      /* Fluid mode is for a board in ordinary document flow, where there is no
         height to fit to and only the width binds. Reading the box's height
         there would be reading back the height this function just set. */
      const bh = fluid ? 0 : box.clientHeight;
      if (!fluid && !bh) return;
      const s = Math.max(min, fluid ? Math.min(1, bw / iw) : Math.min(1, bw / iw, bh / ih));
      setScale(s);
      /* A transform leaves layout alone, so the board still occupies its full
         unscaled height however small it is drawn. Left at that, the box would
         reserve — and scroll through — hundreds of pixels of nothing below a
         board that visually ends much higher up. The spacer holds the height the
         board actually takes on screen. */
      setReserved(Math.ceil(ih * s));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(inner);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("resize", measure);
    };
  }, [min, fluid]);

  return (
    <div
      ref={boxRef}
      /* Content shorter than the box is centred rather than pinned to the top.
         A board that needs 300px of a 700px stage looked like a bug — a strip of
         game with a screen of nothing under it — when it was only ever unused
         room. */
      className={`${fluid ? "overflow-hidden" : "overflow-y-auto"} overflow-x-hidden ${
        fluid ? "" : "flex flex-col justify-center"} ${className}`}
      data-testid="fit-to-stage"
    >
      <div style={scale < 1 && reserved ? { height: reserved } : undefined}>
        <div
          ref={innerRef}
          style={{ transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: "top center" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
