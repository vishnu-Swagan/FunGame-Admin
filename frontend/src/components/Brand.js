/* Chakri.Casino's approved 3D roulette lockup. The wordmark is part of the
   artwork, so every branded surface uses this single asset instead of
   recreating the lettering with a flat web font. */

export const BRAND_ASSET = "/chakri-roulette-brand.png";

export const ChakriLogo = ({ className = "h-10 w-10", alt = "CHAKRI.CASINO" }) => (
  <img
    src={BRAND_ASSET}
    className={`block shrink-0 object-contain select-none ${className}`}
    alt={alt}
    draggable="false"
    decoding="async"
  />
);

/** Full 3D brand lockup. Legacy sizing props remain accepted at call sites;
    logoClassName controls the complete roulette-and-wording artwork. */
export const BrandWordmark = ({ logoClassName = "h-10 w-10", className = "" }) => (
  <span className={`inline-flex items-center ${className}`}>
    <ChakriLogo className={logoClassName} />
  </span>
);
