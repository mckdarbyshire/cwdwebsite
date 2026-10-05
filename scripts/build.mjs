// Copies the static site into dist/ for Netlify, leaving out server code,
// tooling and node_modules so none of it is published as a web page.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const EXCLUDE = new Set([
  "dist", "node_modules", "netlify", "scripts", ".git", ".github", ".netlify",
  "package.json", "package-lock.json", "netlify.toml", ".gitignore", "README.md", "tsconfig.json",
]);

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const entry of readdirSync(".")) {
  if (EXCLUDE.has(entry) || entry.startsWith(".")) continue;
  cpSync(entry, `dist/${entry}`, { recursive: true });
}
console.log("Static site copied to dist/:", readdirSync("dist").join(", "));
