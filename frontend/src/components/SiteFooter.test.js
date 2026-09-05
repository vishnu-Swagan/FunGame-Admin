import { act } from "react";
import { createRoot } from "react-dom/client";
import { AGE_AND_CHIPS, OPERATOR } from "@/lib/siteLegal";
import SiteFooter from "@/components/SiteFooter";

/* The footer only consumes react-router-dom's <Link>, so it gets the same
   lightweight virtual stub every other component test in this repo uses. */
jest.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

function renderFooter() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<SiteFooter />));
  return { container, root };
}

/* Signed-out footer navigation, keyed by the testid SiteFooter derives from
   each route. Queried by testid rather than by loose page text because the
   public footer intentionally links "About" twice (Play and Company groups). */
const LEGAL_AND_COMPANY_LINKS = [
  ["terms", "Terms of use", "/terms"],
  ["privacy", "Privacy", "/privacy"],
  ["cookies", "Cookies", "/cookies"],
  ["responsible-gaming", "Responsible play", "/responsible-gaming"],
  ["about", "About", "/about"],
  ["contact", "Contact", "/contact"],
  ["fair-play", "Fair play", "/fair-play"],
];

test("site footer lists industrial-standard legal links and virtual-chip disclaimer", () => {
  const { container, root } = renderFooter();

  const footer = container.querySelector('[data-testid="site-footer"]');
  expect(footer).not.toBeNull();

  for (const [testId, label, href] of LEGAL_AND_COMPANY_LINKS) {
    const link = footer.querySelector(`[data-testid="footer-link-${testId}"]`);
    expect(link).not.toBeNull();
    expect(link.textContent).toBe(label);
    expect(link.getAttribute("href")).toBe(href);
  }

  const disclaimer = footer.querySelector('[data-testid="site-footer-disclaimer"]');
  expect(disclaimer).not.toBeNull();
  expect(disclaimer.textContent).toMatch(/NO CASH VALUE/);
  expect(disclaimer.textContent).toBe(AGE_AND_CHIPS);

  expect(footer.textContent).toContain(OPERATOR.legalName);
  expect(footer.textContent).toContain(`Company no. ${OPERATOR.companyNumber}`);

  act(() => root.unmount());
});
