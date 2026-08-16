import { renderToStaticMarkup } from "react-dom/server";
import { MydgpAdminWordmark } from "./Brand";

describe("MydgpAdminWordmark", () => {
  it("uses MyDGP branding for the accessible logo label", () => {
    const markup = renderToStaticMarkup(<MydgpAdminWordmark />);

    expect(markup).toContain('aria-label="MyDGP.Casino logo"');
    expect(markup).not.toContain('aria-label="Chakri.Casino logo"');
  });
});
