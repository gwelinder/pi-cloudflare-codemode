import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const workerRoot = new URL("../", import.meta.url);
const sourcePath = new URL("src/index.ts", workerRoot);

async function loadWorkerModule() {
	const outDir = await mkdtemp(join(tmpdir(), "cf-codemode-zone-routes-"));
	let source = await readFile(sourcePath, "utf8");
	source = source
		.replace(
			/import \{ DynamicWorkerExecutor, generateTypesFromJsonSchema, sanitizeToolName \} from "@cloudflare\/codemode";/,
			`class DynamicWorkerExecutor {}\nfunction generateTypesFromJsonSchema() { return ""; }\nfunction sanitizeToolName(name) { return name; }`,
		)
		.replace(/import Cloudflare from "cloudflare";/, "class Cloudflare {}")
		.replace(
			/import \{ z \} from "zod";/,
			`const z = { object: () => ({ safeParse: () => ({ success: false }) }), enum: () => ({}), string: () => ({ min() { return this; } }) };`,
		);
	const transpiled = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
		},
		fileName: sourcePath.pathname,
	});
	const outPath = join(outDir, "index.mjs");
	await writeFile(outPath, transpiled.outputText, "utf8");
	const loaded = await import(pathToFileURL(outPath).href);
	await rm(outDir, { recursive: true, force: true });
	return loaded;
}

const worker = await loadWorkerModule();

function cloudflareError({ status, code, message, extra = {} }) {
	return Object.assign(new Error(message), {
		status,
		error: { code, message, ...extra },
	});
}

function routeRuntime(listError) {
	return {
		client: {
			workers: {
				routes: {
					list: async function* () { throw listError; },
				},
			},
		},
	};
}

test("zone Workers Routes methods expose their exact endpoints", () => {
	const tools = worker.buildTools(routeRuntime(new Error("unused")), "plan");
	const methods = new Map(worker.buildSchemaMethods(tools).map((method) => [method.name, method]));

	assert.equal(methods.get("cf_worker_routes_list").endpoint, "GET /zones/{zone_id}/workers/routes");
	assert.equal(methods.get("cf_worker_route_get").endpoint, "GET /zones/{zone_id}/workers/routes/{route_id}");
	assert.equal(methods.get("cf_worker_route_create").endpoint, "POST /zones/{zone_id}/workers/routes");
	assert.equal(methods.get("cf_worker_route_update").endpoint, "PUT /zones/{zone_id}/workers/routes/{route_id}");
	assert.equal(methods.get("cf_worker_route_delete").endpoint, "DELETE /zones/{zone_id}/workers/routes/{route_id}");
});

test("route-list 403/code 10000 names the zone permission without exposing secrets", async () => {
	const error = cloudflareError({
		status: 403,
		code: 10000,
		message: "Authentication error",
		extra: { authorization: "Bearer must-not-leak", detail: "token=must-not-leak" },
	});
	const tools = worker.buildTools(routeRuntime(error), "plan");
	const diagnostics = {};
	const fns = worker.buildToolFunctions({ cf_worker_routes_list: tools.cf_worker_routes_list }, diagnostics);

	await assert.rejects(
		() => fns.cf_worker_routes_list({ zoneId: "zone_123" }),
		/Zone Workers Routes\/Edit/,
	);

	assert.equal(diagnostics.error.method, "cf_worker_routes_list");
	assert.equal(diagnostics.error.endpoint, "GET /zones/{zone_id}/workers/routes");
	assert.equal(diagnostics.error.httpStatus, 403);
	assert.equal(diagnostics.error.cloudflareCode, 10000);
	assert.equal(diagnostics.error.permissionDiagnostic.scope, "zone");
	assert.equal(diagnostics.error.permissionDiagnostic.requiredPermission, "Zone Workers Routes/Edit");
	assert.match(diagnostics.error.permissionDiagnostic.detail, /Account-scoped Worker permissions/);
	assert.doesNotMatch(JSON.stringify(diagnostics.error), /must-not-leak/);
	assert.match(JSON.stringify(diagnostics.error.cloudflareErrors), /\[REDACTED\]/);
});

test("route permission normalization accepts HTTP status or code 10000 independently", () => {
	const endpoint = "GET /zones/{zone_id}/workers/routes";
	const statusDiagnostic = worker.normalizeToolError(
		cloudflareError({ status: 401, code: 9109, message: "Unauthorized" }),
		"cf_worker_routes_list",
		endpoint,
	);
	const codeDiagnostic = worker.normalizeToolError(
		cloudflareError({ status: 500, code: 10000, message: "Authentication error" }),
		"cf_worker_routes_list",
		endpoint,
	);

	assert.equal(statusDiagnostic.permissionDiagnostic.requiredPermission, "Zone Workers Routes/Edit");
	assert.equal(codeDiagnostic.permissionDiagnostic.requiredPermission, "Zone Workers Routes/Edit");
});

test("non-permission route errors keep attribution without a permission diagnosis", async () => {
	const error = cloudflareError({ status: 500, code: 10001, message: "Internal API failure" });
	const tools = worker.buildTools(routeRuntime(error), "plan");
	const diagnostics = {};
	const fns = worker.buildToolFunctions({ cf_worker_routes_list: tools.cf_worker_routes_list }, diagnostics);

	await assert.rejects(() => fns.cf_worker_routes_list({ zoneId: "zone_123" }), /Internal API failure/);

	assert.equal(diagnostics.error.method, "cf_worker_routes_list");
	assert.equal(diagnostics.error.httpStatus, 500);
	assert.equal(diagnostics.error.cloudflareCode, 10001);
	assert.equal(diagnostics.error.permissionDiagnostic, undefined);
	assert.match(JSON.stringify(diagnostics.error.cloudflareErrors), /Internal API failure/);
});

test("route mutations remain blocked in plan mode before calling Cloudflare", async () => {
	let called = false;
	const runtime = routeRuntime(new Error("unused"));
	runtime.client.workers.routes.create = async () => {
		called = true;
		return {};
	};
	const tool = worker.buildTools(runtime, "plan").cf_worker_route_create;

	await assert.rejects(() => tool.execute({ zoneId: "zone_123", pattern: "example.com/*" }), /requires mode=apply/);
	assert.equal(called, false);
});
