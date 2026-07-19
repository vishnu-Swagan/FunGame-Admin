import { motion, AnimatePresence } from "framer-motion";
import { formatChips } from "@/components/common";

export const ResultBanner = ({ result }) => {
  // result: null | { win: bool, push?: bool, title, subtitle?, payout }
  return (
    <AnimatePresence>
      {result && (
        <motion.div
          key={result.key || result.title}
          initial={{ opacity: 0, scale: 0.9, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          data-testid="result-banner"
          className={`rounded-2xl border p-4 text-center ${
            result.push
              ? "border-white/20 bg-white/5"
              : result.win
              ? "border-[hsl(var(--emerald)/0.45)] bg-[hsl(var(--emerald)/0.12)]"
              : "border-destructive/40 bg-destructive/10"
          }`}
        >
          <p className={`font-display text-2xl ${result.push ? "text-white/85" : result.win ? "text-[hsl(var(--emerald))]" : "text-red-400"}`}>
            {result.title}
          </p>
          {result.subtitle && <p className="text-xs text-white/60 mt-1">{result.subtitle}</p>}
          {result.payout > 0 && (
            <p className="tabular-nums text-lg font-extrabold text-primary mt-1" data-testid="result-payout">
              +{formatChips(result.payout)} chips
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
