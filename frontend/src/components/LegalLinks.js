import { Link } from "react-router-dom";
import { LEGAL_ROUTES } from "@/lib/legalContent";

const LINKS = [
  ["Terms", LEGAL_ROUTES.terms],
  ["Privacy", LEGAL_ROUTES.privacy],
  ["Payments", LEGAL_ROUTES.payments],
  ["Withdrawals", LEGAL_ROUTES.withdrawals],
  ["Responsible gambling", LEGAL_ROUTES.responsibleGambling],
  ["AML and KYC", LEGAL_ROUTES.amlKyc],
  ["Bonuses", LEGAL_ROUTES.bonuses],
  ["Complaints", LEGAL_ROUTES.complaints],
];

export default function LegalLinks({ className = "" }) {
  return (
    <nav aria-label="Policies" className={`flex flex-wrap justify-center gap-x-1 gap-y-1 ${className}`}>
      {LINKS.map(([label, to]) => (
        <Link
          key={to}
          to={to}
          className="inline-flex min-h-[44px] items-center rounded-lg px-2.5 text-[11px] font-semibold text-white/50 hover:bg-white/5 hover:text-white focus-visible:text-white"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
