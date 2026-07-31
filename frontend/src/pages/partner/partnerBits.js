import { formatChips } from "@/components/common";

/**
 * Small pieces shared by the four partner screens.
 *
 * They live together because they encode one rule between them: a figure that
 * is not final has to look different from one that is. Everywhere a provisional
 * number appears it carries the same amber tick, so a partner learns the mark
 * once rather than reading a disclaimer on every screen.
 */

/** Basis points to a percentage a person would say out loud. */
export const pct = (bps) => (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);

export const Money = ({ value, className = "" }) => (
  <span className={`tabular-nums ${value < 0 ? "text-rose-300" : ""} ${className}`}>
    {value < 0 ? `−${formatChips(Math.abs(value))}` : formatChips(value)}
  </span>
);

export const Card = ({ title, subtitle, action, children, testId }) => (
  <section data-testid={testId} className="rounded-2xl border border-white/10 bg-card/55 p-4">
    {(title || action) && (
      <header className="flex items-start justify-between gap-3 mb-3">
        <div>
          {title && <h2 className="text-sm font-bold text-white/85">{title}</h2>}
          {subtitle && <p className="text-[11px] text-white/45 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </header>
    )}
    {children}
  </section>
);

export const Metric = ({ label, value, hint, tone, provisional }) => (
  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
    <p className="text-[10px] tracking-wider text-white/45 flex items-center gap-1">
      {label}
      {provisional && <span title="Still running — this figure can move" className="text-amber-300">•</span>}
    </p>
    <p className={`text-lg font-bold tabular-nums ${
      tone === "loss" ? "text-rose-300" : tone === "win" ? "text-emerald-300" : "text-white"}`}>
      {value}
    </p>
    {hint && <p className="text-[10px] text-white/35 mt-0.5">{hint}</p>}
  </div>
);

/**
 * A table on a screen wide enough for one, and stacked cards on a phone.
 *
 * The stacked half is not decoration. A statement has eight columns and a
 * 360px handset fits about four, so the commission — the one number the screen
 * exists to show — sat off the right edge behind a horizontal scroll nobody
 * would think to try. Every column is visible in the card, labelled, with the
 * first cell as the heading it already is.
 */
export const Table = ({ head, rows, empty = "Nothing here yet.", right = [] }) => {
  if (!rows.length) return <p className="text-sm text-white/45">{empty}</p>;
  return (
    <>
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-white/45">
              {head.map((h, i) => (
                <th key={i} className={`font-medium py-1.5 pr-4 whitespace-nowrap ${right.includes(i) ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-white/8">
                {r.map((c, j) => (
                  <td key={j} className={`py-1.5 pr-4 whitespace-nowrap ${
                    right.includes(j) ? "text-right" : ""} ${
                    j === 0 ? "text-white/85 font-medium" : "text-white/70"}`}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sm:hidden space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-sm font-bold text-white">{r[0]}</span>
              {/* A trailing status pill is the row's own label, not a field. */}
              {head[r.length - 1] === "" && <span>{r[r.length - 1]}</span>}
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              {r.slice(1).map((c, j) => {
                const label = head[j + 1];
                if (label === "") return null;
                return (
                  <div key={j} className="flex items-baseline justify-between gap-2 border-t border-white/5 pt-1">
                    <dt className="text-[10px] text-white/40">{label}</dt>
                    <dd className="text-xs text-white/80 tabular-nums text-right">{c}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
};

const STATUS_TONE = {
  ACCRUED: "bg-amber-400/15 text-amber-300",
  QUEUED: "bg-sky-400/15 text-sky-300",
  PENDING: "bg-amber-400/15 text-amber-300",
  APPROVED: "bg-sky-400/15 text-sky-300",
  PAID: "bg-emerald-500/15 text-emerald-300",
  ACTIVE: "bg-emerald-500/15 text-emerald-300",
  REJECTED: "bg-white/8 text-white/45",
  SUSPENDED: "bg-rose-400/15 text-rose-300",
};

export const Pill = ({ children }) => (
  <span className={`rounded-full px-2 py-0.5 text-[9px] tracking-wider ${
    STATUS_TONE[children] || "bg-white/8 text-white/45"}`}>{children}</span>
);

/** ISO instant to a date a partner can match against a bank statement. */
export const shortDate = (iso) => (iso ? String(iso).slice(0, 10) : "—");
