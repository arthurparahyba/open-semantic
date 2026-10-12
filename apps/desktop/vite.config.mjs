import react from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(root, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: { outDir: join(root, "dist/renderer"), emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5199, strictPort: false },
});
