import "@/components/Brand.css";

export const BRAND_ASSET = "/chakri-roulette-emblem-transparent.png";

/* The 3D crest has a genuine alpha channel. The corrected wordmark and tagline
   remain live type so every surface stays page-native and the approved words
   cannot drift inside a bitmap. */
export const ChakriLogo = ({ className = "h-auto w-40", alt = "CHAKRI.CASINO — PLAY IN THE LIGHT" }) => (
  <span
    className={`chakri-logo block shrink-0 select-none ${className}`}
    role="img"
    aria-label={alt}
  >
    <img
      className="chakri-logo__wheel"
      src={BRAND_ASSET}
      alt=""
      aria-hidden="true"
      width="1254"
      height="1254"
      draggable="false"
      decoding="async"
    />
    <span className="chakri-logo__type" aria-hidden="true">
      <strong>CHAKRI.CASINO</strong>
      <small>PLAY IN THE LIGHT</small>
    </span>
  </span>
);

/** Full approved roulette-and-wordmark artwork. */
export const BrandWordmark = ({ logoClassName = "h-auto w-40", className = "" }) => (
  <ChakriLogo className={`${logoClassName} ${className}`} />
);
