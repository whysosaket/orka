import { defineConfig } from "@playwright/test";
const port = Number(process.env.ORKA_UI_PORT || 5174);
export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1160, height: 800 },
    channel: process.platform === "darwin" ? "chrome" : undefined,
    trace: "retain-on-failure",
  },
  outputDir: "artifacts/ui-results",
  webServer: {
    command: `npm run dev -w @portable/mac -- --port ${port} --strictPort`,
    env: { VITE_ORKA_CLOUD_URL: "https://api.tryorca.ai" },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
