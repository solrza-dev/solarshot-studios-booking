import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.ts",
  webServer: {
    command: "npx wrangler dev --local --port 8787",
    url: "http://127.0.0.1:8787",
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://127.0.0.1:8787",
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
