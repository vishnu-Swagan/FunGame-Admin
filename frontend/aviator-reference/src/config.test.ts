import { apiOriginsForRuntime } from "./config";

describe("Aviator API runtime isolation", () => {
  it("keeps a preview build pinned to its configured API", () => {
    expect(apiOriginsForRuntime("https://api-staging.example", "preview.example")).toEqual([
      "https://api-staging.example",
    ]);
  });

  it("keeps localhost pinned to its configured API", () => {
    expect(apiOriginsForRuntime("http://127.0.0.1:8089", "127.0.0.1")).toEqual([
      "http://127.0.0.1:8089",
    ]);
  });

  it("pins canonical production hosts to the single ledger API", () => {
    expect(apiOriginsForRuntime("https://api.chakri.casino", "Crm.Chakri.Casino")).toEqual([
      "https://api.chakri.casino",
    ]);
    expect(apiOriginsForRuntime("https://old-api.example", "mydgp.casino")).toEqual([
      "https://api.chakri.casino",
    ]);
  });
});
