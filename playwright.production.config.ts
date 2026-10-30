import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({
  ...base,
  testMatch: ["settings.spec.ts", "command-palette.spec.ts"],
  workers: 2,
  outputDir: "artifacts/production-ui-results",
  use: {
    baseURL: "http://127.0.0.1:5179",
    viewport: base.use?.viewport,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", channel: base.use?.channel },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command:
      "npm run build && npm exec -w @portable/mac -- vite preview --host 127.0.0.1 --port 5179 --strictPort",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
  },
});
