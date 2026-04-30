#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "AGENTS.md",
  "extensions/cloudflare-codemode.ts",
  "skills/cloudflare-codemode/SKILL.md",
  "templates/cloudflare-codemode-worker/package.json",
  "templates/cloudflare-codemode-worker/wrangler.jsonc",
  "templates/cloudflare-codemode-worker/src/index.ts",
  "templates/cloudflare-codemode-worker/.dev.vars.example",
  "docs/AGENT_INSTALL.md",
  "docs/CONFIGURATION.md",
  "docs/PROVISIONING.md",
  "docs/TROUBLESHOOTING.md",
  "docs/examples/cloudflare-codemode.example.json",
];

const skipDirs = new Set([".git", "node_modules", ".wrangler", "dist", "coverage"]);
const forbiddenNames = new Set([".dev.vars", "cloudflare-codemode.json", "auth.json"]);
const secretPatterns = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "Cloudflare token assignment", re: /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CODEMODE_SHARED_TOKEN|CF_CODEMODE_TOKEN)\s*[:=]\s*["']?(?!replace|optional|<|\$)[A-Za-z0-9_\-.]{24,}["']?/gi },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9_]{30,}/g },
  { name: "OpenAI-style key", re: /sk-[A-Za-z0-9_-]{32,}/g },
];

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); }
  catch (e) { fail(`${rel}: invalid JSON (${e.message})`); return null; }
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    const rel = path.relative(root, p);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) fail(`missing required file: ${rel}`);
}

const pkg = readJson("package.json");
if (pkg) {
  if (!pkg.keywords?.includes("pi-package")) fail("package.json: missing pi-package keyword");
  if (!pkg.pi?.extensions?.length) fail("package.json: missing pi.extensions");
  if (!pkg.pi?.skills?.length) fail("package.json: missing pi.skills");
}
readJson("templates/cloudflare-codemode-worker/package.json");
readJson("docs/examples/cloudflare-codemode.example.json");
readJson("docs/examples/pi-settings.package.example.json");

if (fs.existsSync(path.join(root, "templates", "cloudflare-codemode-worker", "node_modules"))) {
  fail("template node_modules must not be committed");
}

for (const rel of walk(root)) {
  if (forbiddenNames.has(path.basename(rel)) && !rel.endsWith(".example")) {
    fail(`${rel}: forbidden secret/config filename`);
  }
  const abs = path.join(root, rel);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) continue;
  const text = buf.toString("utf8");
  for (const { name, re } of secretPatterns) {
    re.lastIndex = 0;
    if (re.test(text)) fail(`${rel}: possible ${name}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Repository checks passed.");
