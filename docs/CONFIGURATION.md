# Pi extension configuration

The Pi extension is configured locally. The Worker is configured through Wrangler secrets.

## Config resolution order

The extension merges:

1. global config: `~/.pi/agent/extensions/cloudflare-codemode.json`
2. project config: `<project>/.pi/extensions/cloudflare-codemode.json`
3. selected environment variables

Project config overrides global config. Environment variables provide defaults for `baseUrl` and token lookup.

## Minimal env-only config

```bash
export CF_CODEMODE_URL="https://cloudflare-codemode-worker.<you>.workers.dev"
export CF_CODEMODE_TOKEN="<CODEMODE_SHARED_TOKEN>"
```

## Recommended config file

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

Keep the token in `CF_CODEMODE_TOKEN`; do not write it into shared config.

## Fields

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `CF_CODEMODE_URL` | Worker origin, no trailing slash required. |
| `executePath` | `/execute` | Worker execute endpoint. |
| `schemaPath` | `/schema` | Worker schema endpoint. |
| `healthPath` | `/health` | Worker health endpoint. |
| `tokenEnvVar` | `CF_CODEMODE_TOKEN` | Environment variable containing `CODEMODE_SHARED_TOKEN`. |
| `token` | unset | Inline shared token. Avoid except for private local-only files. |
| `timeoutMs` | `120000` | Request timeout for execute/schema operations. |
| `requireApplyConfirmation` | `true` | Ask before `mode: "apply"`. |
| `blockApplyWithoutUI` | `true` | Block mutations when Pi has no interactive UI for confirmation. |
| `promptInjectionMode` | `lazy` | `lazy`, `full`, or `off`. |
| `auditWidget` | `false` | Show recent activity widget below editor. |
| `extraHeaders` | `{}` | Optional extra HTTP headers to send to Worker. |

## Prompt injection modes

- `lazy` — default. Adds a short note only for Cloudflare-looking prompts. Use `cf_codemode_schema` for exact methods.
- `full` — injects the complete backend TypeScript method schema into every relevant session after schema is cached. Higher token cost.
- `off` — no extra Cloudflare prompt injection; tools still exist.

## Commands

```text
/cf-codemode-status --ping --refresh
/cf-codemode-log --tail 20
/cf-codemode-log --session --json
/cf-codemode-log --path
```

## Tool behavior

- `cf_codemode_schema` fetches/searches `/schema` and returns method definitions.
- `cf_execute` sends `{ mode, code }` to `/execute`.
- Unknown `codemode.*` method names are preflighted locally when schema is available.
- `mode: "apply"` is confirmation-gated unless disabled.
