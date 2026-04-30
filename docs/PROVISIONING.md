# Cloudflare provisioning and secrets

A user does **not** need to manually create a Worker in the Cloudflare dashboard. Wrangler CLI provisions and deploys the Worker.

The only manual Cloudflare-dashboard step is usually creating a Cloudflare API token with the permissions you want the Worker to have.

## Trust boundaries

1. **Pi → Worker:** authenticated by `CODEMODE_SHARED_TOKEN`.
2. **Worker → Cloudflare API:** authenticated by `CLOUDFLARE_API_TOKEN`.

Pi should never receive the Cloudflare API token.

## Recommended provisioning command

From repo root:

```bash
npm run bootstrap
```

The bootstrap script runs Wrangler commands for you:

- `wrangler deploy`
- `wrangler secret put CODEMODE_SHARED_TOKEN`
- `wrangler secret put CLOUDFLARE_API_TOKEN`
- `wrangler secret put CLOUDFLARE_ACCOUNT_ID` when provided

## Required Worker secrets

You can also set them manually from `templates/cloudflare-codemode-worker/`:

```bash
npx wrangler secret put CODEMODE_SHARED_TOKEN
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

### `CODEMODE_SHARED_TOKEN`

Purpose: bearer token for Pi calling your Worker.

Generate:

```bash
openssl rand -base64 32
```

Store the same value locally for Pi as `CF_CODEMODE_TOKEN` or in an uncommitted Pi config file.

Anyone with this token can use your Worker within the permissions of `CLOUDFLARE_API_TOKEN`.

### `CLOUDFLARE_API_TOKEN`

Purpose: Cloudflare API token used by the Worker.

Create it in Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom token.

There is no single narrow permission set for the entire `codemode.*` surface because this Worker can touch many products. Use one of these profiles:

#### Read-only discovery profile

Good for initial setup/testing:

- Account resources: Read for the products you want to inspect.
- Zone resources: Read for zones you want to inspect.
- Include only the account(s)/zone(s) you want Pi to see.

This supports inventory/listing tasks but not mutations.

#### Product-scoped operations profile

Good for real work:

Grant Edit only for the products you intend Pi to manage, for example:

| Task family | Typical token permissions |
|---|---|
| Workers scripts/routes/secrets | Account Workers Scripts/Edit, Account Workers Routes/Edit, Zone Workers Routes/Edit as needed |
| D1 | Account D1/Edit |
| KV | Account Workers KV Storage/Edit |
| R2 | Account R2/Edit |
| DNS | Zone DNS/Edit for selected zones |
| Pages | Account Pages/Edit |
| Queues | Account Queues/Edit |
| Access / Zero Trust | Account Access: Apps and Policies/Edit, related Zero Trust permissions as needed |
| Images / Stream / Turnstile / Vectorize / AI Gateway | Product-specific Account Edit permissions |

Cloudflare permission labels change over time. If a method returns a permissions error, keep the token narrow and add only the missing product permission.

#### Full-lab profile

For a personal lab account where convenience matters more than blast-radius minimization, create a broad token restricted to your account/zones. Do not reuse that token for production accounts.

## `CLOUDFLARE_ACCOUNT_ID`

Recommended. Many Cloudflare APIs are account-scoped. If omitted, the Worker tries to resolve the first accessible account for methods that need an account ID.

Find account ID:

```bash
npx wrangler whoami
```

or Cloudflare Dashboard → account home → right sidebar.

## Optional secrets/env

### `CLOUDFLARE_API_TIMEOUT_MS`

Optional Worker secret or env var. Defaults to 60000.

```bash
printf '120000' | npx wrangler secret put CLOUDFLARE_API_TIMEOUT_MS
```

## Local development

For `wrangler dev`, copy:

```bash
cp .dev.vars.example .dev.vars
```

Never commit `.dev.vars`.

## Rotation

Rotate `CODEMODE_SHARED_TOKEN` if:

- it was pasted into chat/logs;
- a laptop was lost;
- you suspect local Pi config exposure.

Rotate `CLOUDFLARE_API_TOKEN` if:

- it was pasted anywhere;
- Cloudflare reports suspicious activity;
- you widened permissions temporarily.

After rotating `CODEMODE_SHARED_TOKEN`, update local `CF_CODEMODE_TOKEN` or Pi config.
