import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  outputDir: ".tools/browser-results",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test/fixtures/start-browser-preview.ts",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 10_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
  },
});
