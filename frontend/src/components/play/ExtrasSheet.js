import { useState } from "react";
import { ChevronUp } from "lucide-react";

export const ExtrasSheet = ({ children, label = "History & info" }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        data-testid="extras-sheet-toggle"
        onClick={() => setOpen((o) => !o)}
        className="shrink-0 w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-white/55 border-t border-white/8"
      >
        <ChevronUp className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} /> {label}
      </button>
      {open && (
        <div data-testid="extras-sheet" className="shrink-0 max-h-[42vh] overflow-y-auto px-3 pb-3 space-y-3 border-t border-white/8 bg-black/25">
          {children}
        </div>
      )}
    </>
  );
};
