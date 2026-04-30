# pi-cloudflare-codemode

Run multi-step Cloudflare operations from Pi without giving Pi your Cloudflare API token.

Pi writes JavaScript orchestration code. Your own Cloudflare Worker executes that code in a sandbox with `codemode.*` methods backed by the Cloudflare API.

```text
You → Pi writes async JS → your Worker sandbox runs codemode.* → Cloudflare API → result back to Pi
```

**No LLM runs in the Worker. No OpenAI/Anthropic key is used by the backend.**

## What you get

- Pi package with:
  - `cf_codemode_schema` — search/inspect available `codemode.*` methods.
  - `cf_execute` — run Pi-authored Cloudflare orchestration code.
  - `/cf-codemode-status` — config, schema, and health diagnostics.
  - `/cf-codemode-log` — local audit log for recent schema/execute calls.
  - `cloudflare-codemode` skill — tells Pi when/how to use the tools safely.
- Cloudflare Worker template with:
  - `GET /health`
  - `GET /schema`
  - `POST /execute`
  - bearer-token auth between Pi and Worker
  - Cloudflare API token kept server-side as a Worker secret
  - `mode: "plan"` vs `mode: "apply"` mutation guardrails

## Quick start

For a new user or an installing agent, follow:

```text
docs/AGENT_INSTALL.md
```

Short version — Wrangler provisions the Worker and secrets:

```bash
git clone https://github.com/gwelinder/pi-cloudflare-codemode.git
cd pi-cloudflare-codemode
npm run bootstrap
```

Useful flags:

```bash
npm run bootstrap -- --worker-name my-codemode
npm run bootstrap -- --project-local
npm run bootstrap -- --token-env-only
npm run bootstrap -- --yes
```

Then in Pi:

```text
/reload
/cf-codemode-status --ping --refresh
```

## Install as a Pi package

From GitHub:

```bash
pi install git:github.com/gwelinder/pi-cloudflare-codemode
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-cloudflare-codemode
```

Project-local install:

```bash
pi install -l git:github.com/gwelinder/pi-cloudflare-codemode
```

The package manifest exposes:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

## Configure Pi

The extension reads config from either:

- global: `~/.pi/agent/extensions/cloudflare-codemode.json`
- project: `<project>/.pi/extensions/cloudflare-codemode.json`
- environment variables: `CF_CODEMODE_URL`, `CF_CODEMODE_TOKEN`

Recommended config:

```json
{
  "baseUrl": "https://cloudflare-codemode-worker.<you>.workers.dev",
  "tokenEnvVar": "CF_CODEMODE_TOKEN",
  "timeoutMs": 120000,
  "requireApplyConfirmation": true,
  "blockApplyWithoutUI": true,
  "promptInjectionMode": "lazy",
  "auditWidget": false
}
```

Config reference: `docs/CONFIGURATION.md`.

## Provision Cloudflare safely

Required Worker secrets:

| Secret | Required | Purpose |
|---|---:|---|
| `CODEMODE_SHARED_TOKEN` | yes | Bearer token Pi uses to call your Worker. Generate a random value. |
| `CLOUDFLARE_API_TOKEN` | yes | Cloudflare API token used by the Worker. Keep server-side only. |
| `CLOUDFLARE_ACCOUNT_ID` | recommended | Default account for account-scoped operations. |
| `CLOUDFLARE_API_TIMEOUT_MS` | optional | Override Cloudflare SDK timeout. |

Detailed token/provisioning notes: `docs/PROVISIONING.md`.

## Usage examples

Ask Pi naturally:

> List all my Workers and D1 databases.

Pi can call `cf_codemode_schema` if it needs exact method names, then run:

```javascript
async () => {
  const workers = await codemode.cf_workers_list({});
  const databases = await codemode.cf_d1_list_databases({});
  return {
    workers: workers.scripts.map((s) => s.id),
    databases: databases.databases.map((d) => ({ name: d.name, uuid: d.uuid }))
  };
}
```

For mutations, Pi must use `mode: "apply"`; the extension asks for interactive confirmation by default.

## Supported Cloudflare surfaces

The Worker exposes a broad `codemode.*` API surface including Workers, routes, custom domains, secrets, D1, KV, R2, Pages, Queues, Vectorize, Workers AI, AI Gateway, Workflows, Durable Objects, Hyperdrive, Turnstile, Secrets Store, Images, DNS, Cache, SSL, WAF, Rulesets, API Gateway, Alerting, Registrar, Waiting Rooms, Browser Rendering, Request Tracing, Logs, Snippets, Zaraz, Accounts, and a `cf_api_request` escape hatch.

Use `cf_codemode_schema` for the exact current method list.

## Security model

- Pi never receives your Cloudflare API token.
- Pi only knows the Worker URL and shared bearer token.
- The Worker has no LLM/model credentials.
- Mutations require `mode: "apply"` and are confirmation-gated in interactive Pi.
- Use Cloudflare API tokens scoped to only the accounts/zones/products you want this Worker to manage.
- Treat anyone with `CODEMODE_SHARED_TOKEN` as able to use whatever Cloudflare permissions your Worker token has.

## Docs

- `docs/AGENT_INSTALL.md` — agent-friendly install/provision/verify runbook.
- `docs/PROVISIONING.md` — Cloudflare Worker secrets and API token guidance.
- `docs/CONFIGURATION.md` — Pi extension config reference.
- `docs/TROUBLESHOOTING.md` — common setup and runtime failures.
- `templates/cloudflare-codemode-worker/README.md` — Worker-specific dev/deploy notes.

## Repository hygiene

```bash
npm run check
```

This validates package JSON, required docs/template files, and obvious secret/node_modules mistakes.

## License

MIT
