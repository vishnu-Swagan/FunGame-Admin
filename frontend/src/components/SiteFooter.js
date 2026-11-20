import { Link } from "react-router-dom";
import { BrandWordmark } from "@/components/Brand";
import { AGE_AND_CHIPS, OPERATOR, footerNav } from "@/lib/siteLegal";

export default function SiteFooter({ signedIn = false }) {
  const year = new Date().getFullYear();
  return (
    <footer data-testid="site-footer" className="mt-10 border-t border-white/10 pt-8 pb-6 text-white/70">
      <div className="flex flex-col gap-6">
        <div>
          <BrandWordmark logoClassName="h-auto w-[min(72vw,220px)]" />
          <p className="mt-3 text-xs leading-relaxed text-white/55">
            Chakri.Casino is designed and developed by SKY-AMC LIMITED, incorporated in Hong Kong with limited liability.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {Object.entries(footerNav(signedIn)).map(([heading, links]) => (
            <nav key={heading} aria-label={heading}>
              <p className="text-[10px] font-bold tracking-[0.16em] uppercase text-white/40">{heading}</p>
              <ul className="mt-2 space-y-1.5">
                {links.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className="text-xs text-white/75 hover:text-primary"
                      data-testid={`footer-link-${item.to.replaceAll("/", "").replaceAll(" ", "-")}`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>


        <p data-testid="site-footer-disclaimer" className="text-[10px] tracking-[0.14em] uppercase text-white/45">
          {AGE_AND_CHIPS}
        </p>
        <p className="text-[10px] text-white/35">
          © {year} {OPERATOR.legalName}. {OPERATOR.productName}. {signedIn ? "Signed-in player view." : "Public information."}
        </p>
      </div>
    </footer>
  );
}
