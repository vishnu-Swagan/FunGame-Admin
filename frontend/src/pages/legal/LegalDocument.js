import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarDays,
  ExternalLink,
  FileCheck2,
  Landmark,
  Mail,
  Scale,
  ShieldCheck,
} from "lucide-react";
import {
  LEGAL_DOCUMENT_ORDER,
  LEGAL_OPERATOR_CONFIG,
  LEGAL_ROUTES,
  getLegalDocument,
  isLegalPublishingReady,
  missingOperatorFields,
} from "@/lib/legalContent";

const humanizeField = (value) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());

const safeHttpUrl = (value) =>
  typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;

const operatorValue = (value) => value || "To be published before real-money service is enabled";

function MetadataItem({ label, value, icon: Icon }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/45">
        <Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        {label}
      </div>
      <p className="mt-1.5 break-words text-sm font-semibold text-white/85">{value}</p>
    </div>
  );
}

function TableOfContents({ document }) {
  return (
    <nav aria-label={`${document.title} contents`}>
      <p className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-white/40">
        On this page
      </p>
      <ol className="mt-3 space-y-1">
        {document.sections.map((section, index) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="flex min-h-[44px] items-start gap-3 rounded-xl px-3 py-2.5 text-sm leading-5 text-white/65 transition-colors hover:bg-white/[0.05] hover:text-white focus-visible:text-white"
            >
              <span className="w-5 shrink-0 pt-px text-right text-xs font-bold tabular-nums text-primary/70">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>{section.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function CompanyInformation() {
  const config = LEGAL_OPERATOR_CONFIG;
  const missing = missingOperatorFields(config);
  const licenceUrl = safeHttpUrl(config.licenceUrl);
  const adrUrl = safeHttpUrl(config.adrUrl);

  const fields = [
    ["Legal operator", operatorValue(config.legalName)],
    ["Company number", operatorValue(config.companyNumber)],
    ["Registered office", operatorValue(config.registeredOffice)],
    ["Regulator", operatorValue(config.regulatorName)],
    ["Licence number", operatorValue(config.licenceNumber)],
    ["Governing law", operatorValue(config.governingLaw)],
  ];

  return (
    <aside
      className="mt-10 overflow-hidden rounded-3xl border border-primary/25 bg-card/80"
      aria-labelledby="company-information-title"
      data-testid="legal-company-information"
    >
      <div className="border-b border-white/10 px-5 py-5 sm:px-7">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <Building2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 id="company-information-title" className="text-lg font-extrabold text-white">
              Company Information
            </h2>
            <p className="mt-1 text-sm leading-6 text-white/55">
              Public identity, regulatory, and contact details for the operator that contracts with the player.
            </p>
          </div>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="border-b border-amber-300/20 bg-amber-300/[0.06] px-5 py-4 sm:px-7" role="status">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" />
            <div>
              <p className="text-sm font-bold text-amber-100">Publication details are incomplete</p>
              <p className="mt-1 text-xs leading-5 text-amber-100/70" data-testid="legal-missing-fields">
                Missing: {missing.map(humanizeField).join(", ")}. This draft must not be presented as an effective real-money contract until these fields are verified.
              </p>
            </div>
          </div>
        </div>
      )}

      <dl className="grid gap-px bg-white/10 sm:grid-cols-2">
        {fields.map(([label, value]) => (
          <div key={label} className="bg-[hsl(var(--card))] px-5 py-4 sm:px-7">
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/40">{label}</dt>
            <dd className="mt-1.5 break-words text-sm leading-6 text-white/80">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-3 px-5 py-5 sm:grid-cols-2 sm:px-7">
        {config.supportEmail ? (
          <a className="flex min-h-[44px] items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/75 hover:border-primary/30 hover:text-white" href={`mailto:${config.supportEmail}`}>
            <Mail className="h-4 w-4 text-primary" aria-hidden="true" />
            <span className="min-w-0 break-all">{config.supportEmail}</span>
          </a>
        ) : (
          <p className="flex min-h-[44px] items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/45">
            <Mail className="h-4 w-4 text-primary" aria-hidden="true" />
            Support contact pending publication
          </p>
        )}
        {licenceUrl && (
          <a className="flex min-h-[44px] items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/75 hover:border-primary/30 hover:text-white" href={licenceUrl} target="_blank" rel="noreferrer">
            <Landmark className="h-4 w-4 text-primary" aria-hidden="true" />
            Verify operator licence
            <ExternalLink className="ml-auto h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
        {adrUrl && (
          <a className="flex min-h-[44px] items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/75 hover:border-primary/30 hover:text-white" href={adrUrl} target="_blank" rel="noreferrer">
            <Scale className="h-4 w-4 text-primary" aria-hidden="true" />
            {config.adrName || "Independent dispute service"}
            <ExternalLink className="ml-auto h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
    </aside>
  );
}

function RelatedPolicies({ currentSlug }) {
  return (
    <nav className="mt-12 border-t border-white/10 pt-8" aria-label="Related policies">
      <h2 className="text-lg font-extrabold text-white">Policy library</h2>
      <p className="mt-1 text-sm leading-6 text-white/50">
        These documents work together and should be read as one policy set.
      </p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {LEGAL_DOCUMENT_ORDER.filter((slug) => slug !== currentSlug).map((slug) => {
          const document = getLegalDocument(slug);
          return (
            <a
              key={slug}
              href={LEGAL_ROUTES[slug]}
              className="flex min-h-[52px] items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.025] px-4 py-3 text-sm font-semibold text-white/70 transition-colors hover:border-primary/30 hover:bg-primary/[0.05] hover:text-white"
            >
              {document.title}
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/35" aria-hidden="true" />
            </a>
          );
        })}
      </div>
    </nav>
  );
}

export default function LegalDocument({ slug }) {
  const document = getLegalDocument(slug);
  const publishingReady = isLegalPublishingReady();

  if (!document) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-5 text-center text-white">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-primary">Policy unavailable</p>
          <h1 className="mt-3 text-3xl font-extrabold">This policy could not be found</h1>
          <a href="/" className="mt-6 inline-flex min-h-[44px] items-center rounded-xl bg-primary px-5 py-3 text-sm font-extrabold text-primary-foreground">
            Return to Chakri.Casino
          </a>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-dvh overflow-x-clip bg-background text-foreground" data-testid={`legal-page-${slug}`}>
      <a href="#legal-main" className="fixed left-3 top-3 z-[60] -translate-y-24 rounded-xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground focus:translate-y-0">
        Skip to policy
      </a>

      <header className="sticky top-0 z-40 border-b border-white/10 bg-[hsl(var(--background)/0.92)] backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 max-w-[1180px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <a href="/" className="flex min-h-[44px] items-center gap-3 rounded-xl text-white/70 hover:text-white" aria-label="Back to Chakri.Casino">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden text-sm font-bold sm:inline">{LEGAL_OPERATOR_CONFIG.brandName}</span>
          </a>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <span className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-white/55">Policy centre</span>
          </div>
        </div>
      </header>

      <main id="legal-main" className="mx-auto max-w-[1180px] px-4 pb-20 pt-10 sm:px-6 sm:pt-14 lg:px-8">
        <section aria-labelledby="legal-title" className="max-w-[850px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-primary/25 bg-primary/[0.08] px-3 py-1 text-[10px] font-extrabold uppercase tracking-[0.18em] text-primary">
              {document.id}
            </span>
            <span className="rounded-full border border-amber-300/20 bg-amber-300/[0.06] px-3 py-1 text-[10px] font-extrabold uppercase tracking-[0.18em] text-amber-200" data-testid="legal-status">
              {publishingReady ? "PUBLISHED" : "DRAFT"}
            </span>
          </div>
          <h1 id="legal-title" className="mt-6 max-w-[760px] text-3xl font-extrabold leading-tight tracking-[-0.035em] text-white sm:text-5xl">
            {document.title}
          </h1>
          <p className="mt-4 max-w-[760px] text-base leading-7 text-white/60 sm:text-lg sm:leading-8">
            {document.summary}
          </p>
          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <MetadataItem icon={FileCheck2} label="Version" value={document.version} />
            <MetadataItem icon={CalendarDays} label="Effective date" value={document.effectiveDate} />
            <MetadataItem icon={Scale} label="Last reviewed" value={document.lastReviewed} />
          </div>
        </section>

        {!publishingReady && (
          <div className="mt-8 rounded-2xl border border-amber-300/20 bg-amber-300/[0.055] px-4 py-4 sm:px-5" role="note" data-testid="legal-draft-notice">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" />
              <p className="text-sm leading-6 text-amber-100/80">
                This is a controlled draft. It has no effective date and must not replace the terms currently shown to players until operator, licence, territory, contact, and legal-review details are completed and the approved version is published.
              </p>
            </div>
          </div>
        )}

        <details className="mt-7 rounded-2xl border border-white/10 bg-card/60 p-4 lg:hidden">
          <summary className="min-h-[44px] cursor-pointer py-2 text-sm font-extrabold text-white">On this page</summary>
          <div className="mt-2 border-t border-white/10 pt-2">
            <TableOfContents document={document} />
          </div>
        </details>

        <div className="mt-10 grid gap-12 lg:grid-cols-[250px_minmax(0,1fr)] lg:items-start">
          <aside className="sticky top-24 hidden max-h-[calc(100dvh-7rem)] overflow-y-auto pr-4 lg:block">
            <TableOfContents document={document} />
          </aside>

          <article className="min-w-0" aria-label={document.title}>
            <div className="space-y-4">
              {document.sections.map((section, index) => (
                <section
                  key={section.id}
                  id={section.id}
                  aria-labelledby={`${section.id}-title`}
                  className="scroll-mt-24 rounded-3xl border border-white/10 bg-card/55 p-5 sm:p-7"
                >
                  <div className="flex items-start gap-4">
                    <span className="mt-0.5 w-7 shrink-0 text-xs font-extrabold tabular-nums text-primary/65" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 id={`${section.id}-title`} className="text-lg font-extrabold leading-7 text-white sm:text-xl">
                        {section.title}
                      </h2>
                      <div className="mt-3 space-y-3 text-sm leading-7 text-white/65 sm:text-[15px]">
                        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                      </div>
                      {section.bullets.length > 0 && (
                        <ul className="mt-4 space-y-2.5 text-sm leading-6 text-white/65">
                          {section.bullets.map((bullet) => (
                            <li key={bullet} className="flex items-start gap-3">
                              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                              <span>{bullet}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {section.notice && (
                        <div className="mt-5 rounded-2xl border border-primary/20 bg-primary/[0.055] px-4 py-3 text-sm leading-6 text-white/70" role="note">
                          {section.notice}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              ))}
            </div>

            <CompanyInformation />
            <RelatedPolicies currentSlug={slug} />
          </article>
        </div>
      </main>

      <footer className="border-t border-white/10 px-4 py-7 text-center text-xs leading-5 text-white/40">
        <p>{LEGAL_OPERATOR_CONFIG.brandName} policy centre</p>
        <p className="mt-1">Policy ID {document.id} · Version {document.version}</p>
      </footer>
    </div>
  );
}
