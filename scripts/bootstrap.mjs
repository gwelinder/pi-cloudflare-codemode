#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workerDir = path.join(repoRoot, "templates", "cloudflare-codemode-worker");

function usage() {
  return `pi-cloudflare-codemode bootstrap

Provisions the Cloudflare Worker with Wrangler, installs this Pi package, and writes local Pi config.

Usage:
  npm run bootstrap -- [options]
  node scripts/bootstrap.mjs [options]

Options:
  --worker-name NAME       Worker name (default: cloudflare-codemode-worker)
  --worker-url URL         Worker URL if deploy output cannot be parsed
  --config PATH            Pi config path (default: ~/.pi/agent/extensions/cloudflare-codemode.json)
  --pi-source SOURCE       Pi install source (default: git:github.com/gwelinder/pi-cloudflare-codemode)
  --local-pi-install       Install this checkout into Pi instead of the git source
  --project-local          Use pi install -l for current project settings
  --skip-pi-install        Do not run pi install
  --skip-config            Do not write Pi config
  --token-env-only         Do not store CODEMODE_SHARED_TOKEN in Pi config; require CF_CODEMODE_TOKEN env
  --yes                   Non-interactive defaults where possible
  --help                  Show this help

Environment:
  CLOUDFLARE_API_TOKEN     If set, piped into wrangler secret put CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID    If set, piped into wrangler secret put CLOUDFLARE_ACCOUNT_ID
  CF_ACCOUNT_ID            Fallback account id env
  CF_CODEMODE_TOKEN        If set, used as CODEMODE_SHARED_TOKEN instead of generating one
`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) { out._.push(raw); continue; }
    const eq = raw.indexOf("=");
    const key = raw.slice(2, eq === -1 ? undefined : eq);
    const value = eq === -1 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true) : raw.slice(eq + 1);
    out[key] = value;
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function run(command, args, options = {}) {
  const label = [command, ...args].join(" ");
  console.error(`\n$ ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: options.encoding ?? "utf8",
    stdio: options.capture ? [options.input === undefined ? "inherit" : "pipe", "pipe", "pipe"] : [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (options.capture) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${label}`);
  }
  return result;
}

async function ask(question, { defaultValue, yes, secret = false } = {}) {
  if (yes && defaultValue !== undefined) return defaultValue;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!secret) {
      const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
      const answer = await rl.question(`${question}${suffix}: `);
      return answer.trim() || defaultValue || "";
    }

    // Minimal hidden input for TTYs. Falls back to visible prompt if raw mode is unavailable.
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      const answer = await rl.question(`${question}: `);
      return answer.trim();
    }
    rl.close();
    process.stderr.write(`${question}: `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    await new Promise((resolve) => {
      const onData = (buf) => {
        const s = String(buf);
        if (s === "\r" || s === "\n" || s === "\r\n") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stderr.write("\n");
          resolve();
          return;
        }
        if (s === "\u0003") {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (s === "\u007f") {
          value = value.slice(0, -1);
          return;
        }
        value += s;
      };
      process.stdin.on("data", onData);
    });
    return value.trim();
  } finally {
    try { rl.close(); } catch {}
  }
}

function randomToken() {
  const result = spawnSync("openssl", ["rand", "-base64", "32"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

function extractWorkerUrl(output) {
  const matches = [...String(output || "").matchAll(/https:\/\/[^\s)]+\.workers\.dev/g)].map((m) => m[0]);
  return matches.at(-1);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }

  const yes = Boolean(args.yes);
  const workerName = String(args["worker-name"] || "cloudflare-codemode-worker");
  const configPath = path.resolve(expandHome(String(args.config || "~/.pi/agent/extensions/cloudflare-codemode.json")));
  const localPiInstall = Boolean(args["local-pi-install"]);
  const piSource = localPiInstall ? repoRoot : String(args["pi-source"] || "git:github.com/gwelinder/pi-cloudflare-codemode");
  const sharedToken = String(process.env.CF_CODEMODE_TOKEN || randomToken());

  if (!fs.existsSync(workerDir)) throw new Error(`Worker template not found: ${workerDir}`);

  run("npm", ["install"], { cwd: workerDir });
  run("npm", ["run", "typecheck"], { cwd: workerDir });

  const deployArgs = ["wrangler", "deploy", "--name", workerName];
  const deploy = run("npx", deployArgs, { cwd: workerDir, capture: true });
  let workerUrl = String(args["worker-url"] || extractWorkerUrl(`${deploy.stdout || ""}\n${deploy.stderr || ""}`) || "");
  if (!workerUrl) {
    workerUrl = await ask("Worker URL was not found in deploy output. Paste the workers.dev URL", { yes, defaultValue: "" });
  }

  run("npx", ["wrangler", "secret", "put", "CODEMODE_SHARED_TOKEN", "--name", workerName], {
    cwd: workerDir,
    input: `${sharedToken}\n`,
  });

  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (apiToken) {
    run("npx", ["wrangler", "secret", "put", "CLOUDFLARE_API_TOKEN", "--name", workerName], {
      cwd: workerDir,
      input: `${apiToken}\n`,
    });
  } else {
    console.error("\nEnter your Cloudflare API token at the Wrangler prompt. It will be stored as a Worker secret and not printed by this script.");
    run("npx", ["wrangler", "secret", "put", "CLOUDFLARE_API_TOKEN", "--name", workerName], { cwd: workerDir });
  }

  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || "";
  if (!accountId) {
    accountId = await ask("Cloudflare account ID (recommended, blank to skip)", { yes, defaultValue: "" });
  }
  if (accountId) {
    run("npx", ["wrangler", "secret", "put", "CLOUDFLARE_ACCOUNT_ID", "--name", workerName], {
      cwd: workerDir,
      input: `${accountId}\n`,
    });
  }

  if (workerUrl) {
    const health = await fetch(`${workerUrl.replace(/\/+$/, "")}/health`).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
    console.error(`\nHealth: ${JSON.stringify(health)}`);
  }

  if (!args["skip-pi-install"]) {
    const installArgs = ["install"];
    if (args["project-local"]) installArgs.push("-l");
    installArgs.push(piSource);
    run("pi", installArgs, { cwd: repoRoot });
  }

  if (!args["skip-config"]) {
    let storeToken = !args["token-env-only"];
    if (!yes && !args["token-env-only"]) {
      const answer = await ask("Store CODEMODE_SHARED_TOKEN directly in local Pi config for convenience? (Use n to require CF_CODEMODE_TOKEN env)", { defaultValue: "Y" });
      storeToken = !/^n/i.test(answer);
    }
    const config = {
      baseUrl: workerUrl || `https://${workerName}.<your-subdomain>.workers.dev`,
      timeoutMs: 120000,
      requireApplyConfirmation: true,
      blockApplyWithoutUI: true,
      promptInjectionMode: "lazy",
      auditWidget: false,
      ...(storeToken ? { token: sharedToken } : { tokenEnvVar: "CF_CODEMODE_TOKEN" }),
    };
    writeJson(configPath, config);
    console.error(`\nWrote Pi config: ${configPath}`);
    if (!storeToken) {
      console.error("\nAdd this to your shell profile/private env:");
      console.error(`export CF_CODEMODE_TOKEN=${JSON.stringify(sharedToken)}`);
    }
  }

  console.error("\nDone. In Pi, run:");
  console.error("  /reload");
  console.error("  /cf-codemode-status --ping --refresh");
}

main().catch((error) => {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
