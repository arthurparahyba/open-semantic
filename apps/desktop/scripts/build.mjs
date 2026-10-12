// Compila o processo principal e o preload com esbuild e a interface com Vite.
import { build as esbuild } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildMain({ minify = false } = {}) {
  const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: true, minify, logLevel: "warning" };
  await esbuild({ ...common, entryPoints: [join(root, "src/main/index.ts")], outfile: join(root, "dist/main/index.cjs") });
  await esbuild({ ...common, entryPoints: [join(root, "src/preload/index.ts")], outfile: join(root, "dist/preload/index.cjs") });
}

export async function buildRenderer() {
  await viteBuild({ configFile: join(root, "vite.config.mjs"), logLevel: "warn" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildMain();
  await buildRenderer();
  console.log("build ok → dist/");
}
