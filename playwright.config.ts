import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: ".data/playwright-test-results",
  timeout: 120_000,
  expect: {
    timeout: 20_000
  },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    headless: true
  },
  webServer:
    process.env.E2E_SKIP_WEBSERVER === "true"
      ? undefined
      : {
          command: "pnpm dev",
          url: baseURL,
          timeout: 240_000,
          reuseExistingServer: true
        }
});
