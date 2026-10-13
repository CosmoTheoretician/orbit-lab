import { defineConfig } from "vite";
import { execSync } from "node:child_process";

/** Runs a git command at build time; falls back if git isn't available. */
function git(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return fallback;
  }
}

export default defineConfig({
  base: "/orbit-lab/",
  build: { target: "es2022" },
  worker: { format: "es" },
  define: {
    // Time and ID of the last commit, so the "last update" shown in the app is the last code change,
    // not the six-hourly data rebuild.
    __LAST_UPDATE__: JSON.stringify(git("git log -1 --format=%cI", new Date().toISOString())),
    __COMMIT__: JSON.stringify(git("git rev-parse --short HEAD", "local")),
  },
});
