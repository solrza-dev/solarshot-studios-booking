import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.ts",
  webServer: {
    command: "npx wrangler dev --local --local-protocol https --port 8791 --var ENVIRONMENT:development --var TURNSTILE_HOSTNAMES:127.0.0.1 --var TURNSTILE_SITEKEY:1x00000000000000000000AA",
    url: "https://127.0.0.1:8791",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
  },
  use: {
    baseURL: "https://127.0.0.1:8791",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    { name: "mobile", use: { ...devices["iPhone 16"] } },
  ],
});
