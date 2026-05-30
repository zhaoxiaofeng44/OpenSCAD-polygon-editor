// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// The python http.server started outside this config (port 8000) is reused.
// We deliberately do NOT start a webServer here to avoid double-binding.

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,           // tests share localStorage / file handles
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    // Use localhost (not 127.0.0.1): the Claude Code sandbox firewall blocks
    // Firefox→127.0.0.1 but allows Firefox→localhost. Chromium accepts both.
    baseURL: 'http://localhost:8000',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Capture artifacts only on failure to keep output tidy.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // SwiftShader gives the headless shell software WebGL — required by
        // three.js. Without these flags, detectWebGL() flips to "failed".
        launchOptions: {
          args: [
            '--use-gl=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
          ],
        },
      },
    },
    // Firefox / WebKit projects are opt-in via env var since they need
    // separate browser downloads. The compat checks (F2) live in their own
    // file and are skipped unless this var is set.
    ...(process.env.OSCAD_E2E_COMPAT === '1' ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit',  use: { ...devices['Desktop Safari'] } },
    ] : []),
  ],
});
