---
name: cloudflare-codemode
description: Execute multi-step Cloudflare operations by writing JavaScript code that calls codemode.* methods (Workers, D1, KV, R2, zones, accounts). Pi writes the code, a Cloudflare Worker sandbox executes it.
---

# Cloudflare Codemode

Use the `cf_execute` tool when Cloudflare tasks need orchestration (conditionals, loops, chaining results across products).

## How it works

1. You write an async arrow function using `codemode.*` methods
2. The code runs in an isolated Cloudflare Worker sandbox
3. `codemode.*` calls dispatch to real Cloudflare APIs on the host
4. Results come back to Pi

## When to use

Use `cf_execute` when the task needs:

- Multi-step orchestration with conditionals or loops
- Combining results from multiple Cloudflare products
- Batch operations (list + filter + act on each)

Use normal Pi tools (`bash` + `wrangler`) for simple one-shot operations.

## Mode policy

- **Always start with `mode: "plan"`** for read-only operations
- **Only use `mode: "apply"`** when user explicitly wants mutations
- If ambiguous, ask before using apply

## Code format

Write an async arrow function:

```javascript
async () => {
  const workers = await codemode.cf_workers_list({});
  const databases = await codemode.cf_d1_list_databases({});
  return { workerCount: workers.count, dbCount: databases.count };
}
```

## Available method types

Prefer `cf_codemode_schema` when you need exact codemode method names, argument shapes, or a quick search across available Cloudflare operations.

If the system prompt already contains a "Cloudflare Codemode API" section, you can use those injected types directly. Otherwise, ask `cf_codemode_schema` for the specific methods you need instead of loading a huge schema into prompt context.

## Fallback

If Codemode is not configured or fails:

1. Run `/cf-codemode-status --ping`
2. Explain what's missing
3. Fall back to `bash` + `wrangler` for simple operational tasks
4. Use Cloudflare docs / Cloudflare platform skill for architecture, product choice, and unsupported surfaces
