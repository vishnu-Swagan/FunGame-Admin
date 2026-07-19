const SUIT = {
  S: { glyph: "\u2660", color: "#1e293b" },
  C: { glyph: "\u2663", color: "#1e293b" },
  H: { glyph: "\u2665", color: "#dc2626" },
  D: { glyph: "\u2666", color: "#dc2626" },
};

export const PlayingCard = ({ code, size = "md", faceDown = false, dimmed = false, onClick, selected = false }) => {
  const dims = size === "sm" ? "h-14 w-10 text-xs" : size === "lg" ? "h-24 w-[66px] text-lg" : "h-20 w-14 text-sm";
  if (faceDown || !code) {
    return (
      <div className={`${dims} rounded-lg border border-white/20 bg-gradient-to-br from-[#1a2547] to-[#0d1530] shadow-md flex items-center justify-center`}>
        <span className="text-primary/40 text-lg">✦</span>
      </div>
    );
  }
  const suitChar = code.slice(-1);
  const rank = code.slice(0, -1);
  const s = SUIT[suitChar] || SUIT.S;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`${dims} rounded-lg bg-white shadow-md flex flex-col items-center justify-center font-bold leading-none transition-[transform,box-shadow] duration-150 ${
        onClick ? "cursor-pointer active:scale-95" : ""
      } ${selected ? "ring-2 ring-primary -translate-y-1.5" : ""} ${dimmed ? "opacity-40" : ""}`}
      style={{ color: s.color }}
      aria-label={`Card ${rank} of ${suitChar}`}
    >
      <span>{rank}</span>
      <span className="text-xl mt-0.5">{s.glyph}</span>
    </button>
  );
};
