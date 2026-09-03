import { Link, useLocation } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Disclaimer } from "@/components/common";
import { BrandWordmark } from "@/components/Brand";
import SiteFooter from "@/components/SiteFooter";
import { OPERATOR } from "@/lib/siteLegal";

function Shell({ title, children }) {
  return (
    <div className="App fg-noise min-h-dvh bg-background">
      <div className="mx-auto max-w-[560px] px-5 pb-16 pt-8">
        <Link to="/welcome" className="inline-flex items-center gap-2 text-xs text-white/50 hover:text-white" data-testid="legal-back">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <BrandWordmark logoClassName="mt-5 h-auto w-[min(70vw,240px)]" />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">{title}</h1>
        <Disclaimer className="mt-2" />
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-white/70">{children}</div>
        <SiteFooter />
      </div>
    </div>
  );
}

export function AboutPage() {
  return (
    <Shell title="About Chakri.Casino">
      <p>
        {OPERATOR.productName} is a virtual-chip entertainment lobby operated by {OPERATOR.legalName}
        (company no. {OPERATOR.companyNumber}), a United Kingdom private limited company.
        The company develops, sells and produces software and digital entertainment.
      </p>
      <p>
        Players use virtual chips to enter games on this service. Chips are not money, have no cash value,
        and cannot be exchanged for cash, goods or prizes of monetary value.
      </p>
      <p>Registered office:</p>
      <p>{OPERATOR.addressLines.join(", ")}</p>
      <p>
        Company website:{" "}
        <a className="text-primary" href={OPERATOR.companyUrl} target="_blank" rel="noreferrer">libertymarketsltd.uk</a>
      </p>
    </Shell>
  );
}

export function TermsPage() {
  return (
    <Shell title="Terms of use">
      <p>These terms cover use of {OPERATOR.productName} by {OPERATOR.legalName}. By creating an account you agree to them.</p>
      <p><strong className="text-white">1. Entertainment only.</strong> This is a virtual-chip entertainment service. It is not a licensed gambling product. Chips have no cash value.</p>
      <p><strong className="text-white">2. Eligibility.</strong> You must be 18 or over. We may ask for age checks and close accounts that fail them.</p>
      <p><strong className="text-white">3. Account.</strong> Keep your login details private. You are responsible for activity on the account.</p>
      <p><strong className="text-white">4. Chips.</strong> Buy Chips and Withdraw in the app move virtual chips on this service under operator review. They do not convert chips into cash winnings.</p>
      <p><strong className="text-white">5. Fair play.</strong> Do not cheat, collude, automate play, or abuse promotions. We may suspend or close accounts that do.</p>
      <p><strong className="text-white">6. Availability.</strong> Games, features and chip actions can change, pause or end for maintenance or compliance.</p>
      <p><strong className="text-white">7. Liability.</strong> The service is provided as entertainment. We are not liable for lost chips, downtime, or device issues beyond what applicable UK law requires.</p>
      <p><strong className="text-white">8. Changes.</strong> We may update these terms. Continued use after a notice in the app counts as acceptance.</p>
      <p>Questions: use in-app Support.</p>
    </Shell>
  );
}

export function PrivacyPage() {
  return (
    <Shell title="Privacy">
      <p>{OPERATOR.legalName} is the controller of personal data for {OPERATOR.productName}.</p>
      <p>We process account details, device and security logs, play history, and payment-status records needed to run the lobby, prevent abuse, and meet legal duties.</p>
      <p>We do not sell personal data. Payment credentials are not stored in the browser. Provider callbacks and wallet changes are verified on the server.</p>
      <p>You can ask for a copy of your data, a correction, or account closure through in-app Support. Some records are kept where the law requires it.</p>
      <p>Registered office: {OPERATOR.addressLines.join(", ")}.</p>
    </Shell>
  );
}

export function CookiesPage() {
  return (
    <Shell title="Cookies">
      <p>We use essential cookies and local storage to keep you signed in, remember device settings, and protect the session. These are required for the service to work.</p>
      <p>We do not use advertising cookies on this lobby. Analytics, if enabled, are limited to understanding whether the service is healthy.</p>
      <p>You can clear site data in your browser. That will sign you out.</p>
    </Shell>
  );
}

export function ContactPage() {
  return (
    <Shell title="Contact">
      <p>Player support is inside the app. Signed-in players can message the operator from Support.</p>
      <p>{OPERATOR.legalName}</p>
      <p>Company no. {OPERATOR.companyNumber}</p>
      {OPERATOR.addressLines.map((line) => <p key={line}>{line}</p>)}
      <p>
        Company site:{" "}
        <a className="text-primary" href={OPERATOR.companyUrl} target="_blank" rel="noreferrer">libertymarketsltd.uk</a>
      </p>
      <p>
        <Link className="text-primary" to="/support">Open Support</Link>
      </p>
    </Shell>
  );
}

export function FairPlayPage() {
  return (
    <Shell title="Fair play">
      <p>Game outcomes on {OPERATOR.productName} are generated on the server. Clients cannot award chips by themselves.</p>
      <p>We monitor unusual staking, multi-accounting and client modification. Breaking the rules can close the account and forfeit promotional chips.</p>
      <p>If you think a round settled wrongly, send the time, game and what you saw through Support. We review server logs, not screenshots alone.</p>
    </Shell>
  );
}

export function ResponsibleGamingPage() {
  return (
    <Shell title="Responsible play">
      <p>{OPERATOR.productName} is for adults. You must be 18 or over.</p>
      <p>Chips are virtual and have no cash value. Play for entertainment, not to recover money or chase a result.</p>
      <p>Signed-in players can set play-result limits, take a break, or self-exclude from the Responsible play screen in the app.</p>
      <p>If play stops being fun, take a break or close the account from Responsible play once you are signed in.</p>
    </Shell>
  );
}

export function LegalRouterPage() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/privacy")) return <PrivacyPage />;
  if (pathname.startsWith("/cookies")) return <CookiesPage />;
  if (pathname.startsWith("/contact")) return <ContactPage />;
  if (pathname.startsWith("/fair-play")) return <FairPlayPage />;
  if (pathname.startsWith("/about")) return <AboutPage />;
  if (pathname.startsWith("/responsible-gaming")) return <ResponsibleGamingPage />;
  return <TermsPage />;
}
