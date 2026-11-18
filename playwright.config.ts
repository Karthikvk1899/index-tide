import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:8080",
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
  },
});
