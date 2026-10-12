// pnpm dev: interface com recarga automática (Vite) + processo principal compilado + Electron.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { createServer } from "vite";

import { buildMain } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await buildMain();
const server = await createServer({ configFile: join(root, "vite.config.mjs") });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`interface em ${url}`);

const child = spawn(electronPath, [root], { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
