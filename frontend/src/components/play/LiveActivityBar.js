import { motion, AnimatePresence } from "framer-motion";
import { Users } from "lucide-react";
import { usePlayersOnline, useWinFeed } from "@/lib/liveActivity";

/** A live "casino floor" strip shown on every game: playing-now count + a
    rolling win ticker. Ambient by default; pass realEvents to merge live ones. */
export const LiveActivityBar = ({ slug, realEvents }) => {
  const online = usePlayersOnline(slug);
  const feed = useWinFeed(slug, realEvents);
  const latest = feed[0];
  return (
    <div
      data-testid="live-activity-bar"
      className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-black/25 px-3 py-1.5 overflow-hidden"
    >
      <span className="flex items-center gap-1.5 shrink-0">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--emerald))] opacity-70 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[hsl(var(--emerald))]" />
        </span>
        <Users className="h-3.5 w-3.5 text-white/45" />
        <span className="tabular-nums text-[11px] font-extrabold text-[hsl(var(--emerald))]">{online.toLocaleString()}</span>
        <span className="text-[10px] text-white/45">playing</span>
      </span>
      <span className="h-3.5 w-px bg-white/12 shrink-0" />
      <div className="relative flex-1 h-4 overflow-hidden">
        <AnimatePresence mode="wait">
          {latest && (
            <motion.div
              key={latest.id}
              initial={{ y: 14, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -14, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="absolute inset-0 flex items-center gap-1.5 text-[11px] whitespace-nowrap"
            >
              <span className="font-semibold text-white/75 shrink-0">{latest.name}</span>
              <span className={`truncate ${latest.tone === "gold" ? "font-bold text-primary" : latest.tone === "win" ? "text-[hsl(var(--emerald))]" : "text-white/50"}`}>
                {latest.text}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
