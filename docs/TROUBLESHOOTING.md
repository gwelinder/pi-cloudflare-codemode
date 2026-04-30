# Troubleshooting

Start here:

```text
/cf-codemode-status --ping --refresh
/cf-codemode-log --tail 20
```

## `Cloudflare Codemode not configured`

Pi does not know the Worker URL.

Fix:

```bash
export CF_CODEMODE_URL="https://cloudflare-codemode-worker.<you>.workers.dev"
```

or set `baseUrl` in `~/.pi/agent/extensions/cloudflare-codemode.json`.

## `token: missing`

Pi does not know `CODEMODE_SHARED_TOKEN`.

Fix:

```bash
export CF_CODEMODE_TOKEN="<same value as Worker CODEMODE_SHARED_TOKEN>"
```

or set a different `tokenEnvVar` in config.

## `/health` works but `/schema` fails with `Unauthorized`

The Worker is reachable, but Pi's bearer token does not match the Worker secret.

Fix:

```bash
cd templates/cloudflare-codemode-worker
printf '%s' "$CF_CODEMODE_TOKEN" | npx wrangler secret put CODEMODE_SHARED_TOKEN
npm run deploy
```

## `/schema` returns `missing CLOUDFLARE_API_TOKEN`

The Worker does not have a Cloudflare API token secret.

Fix:

```bash
cd templates/cloudflare-codemode-worker
npx wrangler secret put CLOUDFLARE_API_TOKEN
npm run deploy
```

## Cloudflare API says permission denied

Your Worker and Pi are configured, but the Cloudflare API token lacks a product permission or account/zone scope.

Fix:

1. Identify the product from the method name or error.
2. Add the narrow missing permission to the Cloudflare API token.
3. Re-run in `mode: "plan"` if possible.

Do not jump directly to a broad production token unless this is a disposable lab account.

## `Unknown codemode method`

Pi guessed a method name that is not exposed by the current Worker schema.

Fix: ask Pi to call `cf_codemode_schema` first:

```text
Use cf_codemode_schema to search for DNS record creation methods.
```

Then retry with the exact method name.

## `cf_execute(apply) blocked: no UI for confirmation`

The extension refuses mutations when there is no interactive Pi UI.

Fix options:

- run in normal interactive Pi; or
- keep using `mode: "plan"`; or
- set `blockApplyWithoutUI: false` only if you understand the risk.

## Wrangler deploy errors

Run:

```bash
cd templates/cloudflare-codemode-worker
npm install
npm run typecheck
npx wrangler whoami
npx wrangler deploy
```

If `worker_loaders` is not supported, update the Wrangler CLI used by `npx`:

```bash
npx wrangler@latest deploy
```

or install a recent Wrangler globally/in your preferred Node toolchain.

## Local dev secrets

For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and fill values locally. Never commit `.dev.vars`.

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

## Audit log location

```text
/cf-codemode-log --path
```

The audit log is local Pi state and should not be committed.
