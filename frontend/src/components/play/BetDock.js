export const BetDock = ({ children }) => (
  <div
    className="shrink-0 border-t border-white/10 bg-[hsl(var(--background)/0.92)] backdrop-blur-xl px-3 pt-2.5"
    style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}
    data-testid="bet-dock"
  >
    {children}
  </div>
);
