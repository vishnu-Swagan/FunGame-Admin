import fs from "fs";
import path from "path";

const crmCss = fs.readFileSync(path.join(__dirname, "admin-crm.css"), "utf8");
const login = fs.readFileSync(path.join(__dirname, "../auth/AdminLogin.js"), "utf8");
const layout = fs.readFileSync(path.join(__dirname, "AdminLayout.js"), "utf8");

test("CRM primary is Chakri gold with the player-app dark foreground", () => {
  expect(crmCss).toContain("--primary: var(--chakri-primary-hsl, 43 92% 56%)");
  expect(crmCss).toContain("--primary-foreground: 222 55% 8%");
  expect(crmCss).toContain("--ring: var(--chakri-primary-hsl, 43 92% 56%)");
  expect(crmCss).not.toContain("351 56% 42%");
  expect(crmCss).not.toContain("--crm-accent: #a82f42");
});

test("CRM chrome uses Manrope, not Aptos, and does not put Georgia on tables", () => {
  expect(crmCss).toMatch(/font-family:\s*Manrope/);
  expect(crmCss).not.toContain("Aptos");
  expect(crmCss).not.toMatch(/\.crm-admin table[\s\S]{0,200}Georgia/);
});

test("Admin login and shell keep BrandWordmark without recoloring the gold lockup", () => {
  expect(login).toContain("BrandWordmark");
  expect(login).toContain("crm-login-brand-logo");
  expect(layout).toContain("BrandWordmark");
  expect(layout).toContain("admin-brand-logo");
  expect(crmCss).not.toMatch(/\.admin-brand-logo \{[^}]*(?:brightness|invert|grayscale|sepia|hue-rotate)/);
  expect(crmCss).not.toMatch(/\.crm-login-brand-logo \{[^}]*(?:brightness|invert|grayscale|sepia|hue-rotate)/);
  expect(crmCss).toMatch(/\.admin-brand-logo \{[^}]*drop-shadow/);
  expect(crmCss).toMatch(/\.crm-login-brand-logo \{[^}]*drop-shadow/);
});
