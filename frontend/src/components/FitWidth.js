import { useLayoutEffect, useRef, useState } from "react";

/**
 * FitWidth - makes fixed-width game boards render on ANY screen size.
 * Measures the natural width of its content; when the container is narrower,
 * the content is scaled down proportionally (transform: scale) and the
 * wrapper height is adjusted so the layout stays tight. No horizontal
 * scrolling, no clipped boards - works from 320px phones up to desktop.
 */
export const FitWidth = ({ children, className = "" }) => {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(null);

  useLayoutEffect(() => {
    const measure = () => {
      const ow = outerRef.current ? outerRef.current.clientWidth : 0;
      const iw = innerRef.current ? innerRef.current.scrollWidth : 0;
      const ih = innerRef.current ? innerRef.current.offsetHeight : 0;
      const s = ow > 0 && iw > ow ? ow / iw : 1;
      setScale(s);
      setHeight(ih ? Math.ceil(ih * s) : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (outerRef.current) ro.observe(outerRef.current);
    if (innerRef.current) ro.observe(innerRef.current);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  return (
    <div ref={outerRef} className={className} style={{ height: height ?? undefined, overflow: "visible" }}>
      <div
        ref={innerRef}
        style={{ width: "max-content", transform: `scale(${scale})`, transformOrigin: "top left", margin: "0 auto" }}
      >
        {children}
      </div>
    </div>
  );
};
