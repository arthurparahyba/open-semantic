// Teste de uso ponta a ponta com o Claude de verdade (uso/README.md). Fora do CI: precisa de ANTHROPIC_API_KEY.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "uso",
  testMatch: "*.uso.ts",
  timeout: 60 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/uso",
});
