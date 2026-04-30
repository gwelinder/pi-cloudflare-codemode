# Agent install guide

This repo includes a bootstrap script that provisions the user's Cloudflare Worker with Wrangler CLI, installs the Pi package, and writes local Pi config. Do not ask users to manually create a Worker in the Cloudflare dashboard.

## Goal

Install a Pi package that registers:

- `cf_codemode_schema`
- `cf_execute`
- `/cf-codemode-status`
- `/cf-codemode-log`
- `cloudflare-codemode` skill

The backend is a user-owned Cloudflare Worker in `templates/cloudflare-codemode-worker`.

## Non-negotiable safety rules

- Never commit `.dev.vars`, raw `cloudflare-codemode.json`, API tokens, or generated audit logs.
- Never paste `CLOUDFLARE_API_TOKEN` or `CODEMODE_SHARED_TOKEN` into chat or docs.
- Use `wrangler secret put` for Worker secrets.
- Store Pi's shared token in `~/.pi/agent/extensions/cloudflare-codemode.json` or `CF_CODEMODE_TOKEN` only on the user's machine.
- Use `mode: "plan"` before `mode: "apply"`.

## Preferred install path

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

If secrets are already in env:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
npm run bootstrap -- --yes
```

## Manual fallback

Only if bootstrap fails, step through `docs/AGENT_INSTALL.md`.

## Verify inside Pi

```text
/reload
/cf-codemode-status --ping --refresh
```

First read-only tool sanity check:

```js
async () => {
  return await codemode.cf_accounts_list({});
}
```

## If something fails

Read `docs/TROUBLESHOOTING.md` and run:

```text
/cf-codemode-status --ping --refresh
/cf-codemode-log --tail 20
```
