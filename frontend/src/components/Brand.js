/* Chakri.Casino's approved 3D roulette lockup. The wordmark is part of the
   artwork, so every branded surface uses this single asset instead of
   recreating the lettering with a flat web font. */

export const BRAND_ASSET = "/chakri-roulette-brand.png";

export const ChakriLogo = ({ className = "h-auto w-40", alt = "CHAKRI.CASINO" }) => (
  <img
    src={BRAND_ASSET}
    className={`block shrink-0 object-contain select-none ${className}`}
    alt={alt}
    width="1600"
    height="400"
    draggable="false"
    decoding="async"
  />
);

/** Full approved roulette-and-wordmark artwork. */
export const BrandWordmark = ({ logoClassName = "h-auto w-40", className = "" }) => (
  <span className={`inline-flex items-center ${className}`}>
    <ChakriLogo className={logoClassName} />
  </span>
);
