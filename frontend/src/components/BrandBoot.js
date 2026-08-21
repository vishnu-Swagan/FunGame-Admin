import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ChakriLogo } from "@/components/Brand";

/* Cinematic brand boot — shown once per app session the first time the app is
   opened: the complete 3D CHAKRI.CASINO lockup forms up, a loader sweeps,
   then it dissolves into the home screen. The lobby loads underneath meanwhile. */

const bootSeen = () => {
  try { return sessionStorage.getItem("fg_boot_v1") === "1"; } catch { return false; }
};

export const BrandBoot = () => {
  const reduced = useReducedMotion();
  const [show, setShow] = useState(() => !bootSeen());

  useEffect(() => {
    if (bootSeen()) return;
    try { sessionStorage.setItem("fg_boot_v1", "1"); } catch { /* ignore */ }
    const t = setTimeout(() => setShow(false), reduced ? 800 : 2900);
    return () => clearTimeout(t);
  }, [reduced]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          data-testid="brand-boot"
          onClick={() => setShow(false)}
          role="button"
          aria-label="Skip intro"
          className="fixed inset-0 z-[90] flex flex-col items-center justify-center cursor-pointer overflow-hidden"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.6 } }}
          style={{ background: "radial-gradient(circle at 50% 42%, #131b33 0%, #080c18 55%, #04060d 100%)" }}
        >
          <div aria-hidden="true" className="fg-scanlines absolute inset-0 opacity-30 pointer-events-none" />
          {!reduced && (
            <div aria-hidden="true" className="fg-home-sheen-el absolute inset-y-0 -left-1/3 w-1/3 pointer-events-none" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)" }} />
          )}
          <motion.div
            initial={{ scale: 0.4, rotate: reduced ? 0 : -30, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: reduced ? "tween" : "spring", stiffness: 140, damping: 13, duration: reduced ? 0.3 : undefined }}
          >
            <ChakriLogo className="h-56 w-56 sm:h-64 sm:w-64 drop-shadow-[0_0_42px_rgba(255,174,45,0.48)]" />
          </motion.div>
          <motion.p
            className="mt-2 font-gaming text-[11px] tracking-[0.45em] uppercase text-white/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            Play Chips · Live Worldwide
          </motion.p>
          {!reduced && (
            <div className="mt-6 h-1 w-44 rounded-full overflow-hidden bg-white/10">
              <motion.div
                className="h-full rounded-full"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: 2.3, ease: "easeInOut" }}
                style={{ background: "linear-gradient(90deg, #ffca3a, #fff4cf)" }}
              />
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
