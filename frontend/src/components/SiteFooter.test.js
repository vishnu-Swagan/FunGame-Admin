import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SiteFooter from "@/components/SiteFooter";

test("site footer lists industrial-standard legal links and virtual-chip disclaimer", () => {
  render(
    <MemoryRouter>
      <SiteFooter />
    </MemoryRouter>,
  );
  expect(screen.getByTestId("site-footer")).toBeInTheDocument();
  expect(screen.getByText(/Terms of use/i)).toBeInTheDocument();
  expect(screen.getByText(/Privacy/i)).toBeInTheDocument();
  expect(screen.getByText(/Cookies/i)).toBeInTheDocument();
  expect(screen.getByText(/Responsible play/i)).toBeInTheDocument();
  expect(screen.getByText(/About/i)).toBeInTheDocument();
  expect(screen.getByText(/Contact/i)).toBeInTheDocument();
  expect(screen.getByText(/Fair play/i)).toBeInTheDocument();
  expect(screen.getByTestId("site-footer-disclaimer").textContent).toMatch(/NO CASH VALUE/);
  expect(screen.getByText(/Liberty Markets Ltd/)).toBeInTheDocument();
  expect(screen.getByText(/16905599/)).toBeInTheDocument();
});
