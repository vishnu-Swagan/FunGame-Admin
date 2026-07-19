import { motion } from "framer-motion";
import { PlayingCard } from "./PlayingCard";

const DIMS = { sm: "h-14 w-10", md: "h-20 w-14", lg: "h-24 w-[66px]" };

/** Empty slot placeholder so the table layout never jumps while dealing. */
export const CardSlot = ({ size = "md" }) => (
  <div className={`${DIMS[size]} rounded-lg border border-dashed border-white/12 bg-white/[0.03]`} />
);

/**
 * A card that is dealt onto the table (slide-in) and can flip face-up later.
 * Deal + flip moments are driven by the universal server clock, so every
 * player sees the exact same card at the exact same time.
 */
export const FlipCard = ({ code, size = "md", dealt = true, flipped = true, highlight = false, dim = false }) => {
  if (!dealt) return <CardSlot size={size} />;
  return (
    <motion.div
      initial={{ opacity: 0, y: -28, rotate: -7, scale: 0.88 }}
      animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className={`fg-card3d ${DIMS[size]}`}
    >
      <div className="fg-card3d-inner h-full w-full" style={{ transform: flipped ? "rotateY(0deg)" : "rotateY(180deg)" }}>
        <div className="fg-card3d-face">
          <PlayingCard code={code} size={size} dimmed={dim} selected={highlight} />
        </div>
        <div className="fg-card3d-back">
          <PlayingCard faceDown size={size} />
        </div>
      </div>
    </motion.div>
  );
};
