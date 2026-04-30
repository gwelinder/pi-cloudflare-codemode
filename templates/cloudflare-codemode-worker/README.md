# Cloudflare Codemode Worker

Thin executor backend for `pi-cloudflare-codemode`. **No LLM runs here** — Pi writes the code, this Worker runs it in a Cloudflare-hosted sandbox.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---:|---|
| GET | `/health` | no | Health check |
| GET | `/schema` | yes | Type definitions + structured metadata for `codemode.*` methods |
| POST | `/execute` | yes | Execute Pi-authored code in the sandbox |

## One-command bootstrap from repo root

Most users should run the root bootstrap script instead of manually deploying from this directory:

```bash
cd ../..
npm run bootstrap
```

That script uses Wrangler to:

1. install Worker dependencies;
2. deploy the Worker;
3. create Worker secrets;
4. install the Pi package;
5. write local Pi config.

## Manual Wrangler flow

If you want to operate the Worker directly:

```bash
npm install
npm run typecheck
npm run deploy
```

Set secrets with Wrangler:

```bash
TOKEN="$(openssl rand -base64 32)"
printf '%s' "$TOKEN" | npx wrangler secret put CODEMODE_SHARED_TOKEN
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

Then configure Pi with the Worker URL and the same shared token.

## Local dev

```bash
cp .dev.vars.example .dev.vars
$EDITOR .dev.vars
npm run dev
```

Never commit `.dev.vars`.

## POST /execute payload

```json
{
  "mode": "plan",
  "code": "async () => { const w = await codemode.cf_workers_list({}); return w; }"
}
```

`mode: "apply"` enables mutating methods. Mutating methods throw when called in `plan` mode.

## Response

```json
{
  "runId": "uuid",
  "status": "ok",
  "result": { "example": true },
  "logs": [],
  "durationMs": 1234
}
```

## GET /schema response shape

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-04-21T12:34:56.000Z",
  "types": "type CfWorkersListInput = ...",
  "tools": ["cf_workers_list", "cf_dns_records_list"],
  "methods": [
    {
      "name": "cf_workers_list",
      "description": "List Workers scripts in an account.",
      "inputSchema": { "type": "object", "properties": { "accountId": { "type": "string" } } },
      "required": [],
      "mutating": false,
      "product": "Workers",
      "aliases": ["worker", "workers", "script", "scripts"],
      "keywords": ["workers", "scripts", "account"]
    }
  ]
}
```

## Cloudflare SDK note

The worker template is currently pinned to `cloudflare@6.0.0-beta.2` because the stable v5 SDK did not expose all newer Email Sending resources when this package was built.

## No LLM required

This Worker has no AI SDK, no model config, no OpenAI key. Pi is the LLM — it writes the code, this Worker just executes it.
