# Agent-friendly installation runbook

This runbook is designed for an agent helping a human install `pi-cloudflare-codemode` safely.

The human should **not** manually provision a Worker in the Cloudflare dashboard. Wrangler CLI does that. The only thing the human must provide is Cloudflare auth/permissions for Wrangler and a Cloudflare API token for the Worker to use.

## Inputs to gather

Ask for non-secret preferences only:

1. Desired Worker name. Default: `cloudflare-codemode-worker`.
2. Whether to install Pi package globally or project-locally.
3. Whether they already have a Cloudflare API token.
4. Optional Cloudflare account ID.

Do **not** ask them to paste API tokens into chat. Have them enter secrets into Wrangler prompts or set env vars locally.

## Fast path: root bootstrap script

```bash
git clone https://github.com/gwelinder/pi-cloudflare-codemode.git
cd pi-cloudflare-codemode
npm run bootstrap
```

The script uses Wrangler to:

1. install Worker dependencies;
2. run TypeScript checks;
3. deploy the Worker;
4. generate `CODEMODE_SHARED_TOKEN`;
5. set Worker secrets with `wrangler secret put`;
6. install the Pi package;
7. write local Pi config.

Useful variants:

```bash
npm run bootstrap -- --worker-name my-codemode
npm run bootstrap -- --local-pi-install
npm run bootstrap -- --project-local
npm run bootstrap -- --token-env-only
npm run bootstrap -- --skip-pi-install
```

If the user has secrets in env already:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
npm run bootstrap -- --yes
```

`--yes` avoids optional prompts where possible.

## Manual-but-still-Wrangler path

Use this if the bootstrap script fails and you need to step through the same operations.

### Step 0 — prerequisites

```bash
pi --version
node --version
npm --version
npx wrangler --version
npx wrangler whoami || npx wrangler login
```

### Step 1 — clone/update

```bash
git clone https://github.com/gwelinder/pi-cloudflare-codemode.git
cd pi-cloudflare-codemode
```

If already cloned:

```bash
git pull --ff-only
```

### Step 2 — deploy Worker with Wrangler

```bash
cd templates/cloudflare-codemode-worker
npm install
npm run typecheck
npx wrangler deploy --name cloudflare-codemode-worker
```

Record the deployed URL from Wrangler output.

### Step 3 — set Worker secrets with Wrangler

Generate shared token:

```bash
CODEMODE_SHARED_TOKEN="$(openssl rand -base64 32)"
printf '%s' "$CODEMODE_SHARED_TOKEN" | npx wrangler secret put CODEMODE_SHARED_TOKEN --name cloudflare-codemode-worker
```

Set Cloudflare API token interactively:

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN --name cloudflare-codemode-worker
```

Set account ID if available:

```bash
printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID --name cloudflare-codemode-worker
```

### Step 4 — install Pi package

```bash
cd ../..
pi install git:github.com/gwelinder/pi-cloudflare-codemode
```

For project-local install:

```bash
pi install -l git:github.com/gwelinder/pi-cloudflare-codemode
```

### Step 5 — configure Pi locally

```bash
mkdir -p ~/.pi/agent/extensions
cp docs/examples/cloudflare-codemode.example.json ~/.pi/agent/extensions/cloudflare-codemode.json
$EDITOR ~/.pi/agent/extensions/cloudflare-codemode.json
```

Set `baseUrl` to the deployed Worker URL.

Either store the shared token in env:

```bash
export CF_CODEMODE_TOKEN="$CODEMODE_SHARED_TOKEN"
```

or put it in the local uncommitted config as:

```json
{ "token": "..." }
```

### Step 6 — verify inside Pi

```text
/reload
/cf-codemode-status --ping --refresh
```

Expected:

- endpoint is the Worker URL;
- token is set;
- health is OK;
- schema refresh returns a method count.

Then test schema lookup:

```text
Use cf_codemode_schema to search for workers list and dns records.
```

Read-only execute sanity test:

```text
Use cf_execute in plan mode to list Cloudflare accounts.
```

Expected code shape:

```js
async () => {
  return await codemode.cf_accounts_list({});
}
```

## Mutation policy

Only use `mode: "apply"` when the user explicitly asks for a mutation.

For ambiguous requests, ask first.

## Update

```bash
pi update git:github.com/gwelinder/pi-cloudflare-codemode
cd pi-cloudflare-codemode
git pull --ff-only
npm run bootstrap -- --skip-pi-install
```

## Agent handoff summary template

```text
Installed pi-cloudflare-codemode.
Worker URL: <url>
Pi config: <global|project|env>
Verification: /cf-codemode-status --ping --refresh <passed|failed>
First read-only tool test: <passed|not run>
Secrets: stored in Wrangler secrets + local Pi env/config, not printed or committed.
```
