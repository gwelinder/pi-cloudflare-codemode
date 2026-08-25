/**
 * Cloudflare Codemode Pi Extension
 *
 * Architecture: Pi writes the orchestration code, the Worker just executes it.
 *
 * - Fetches tool schema from backend on session start (cached)
 * - Defaults to lazy prompt behavior so 100+ backend methods are not injected into every Pi session
 * - Registers cf_codemode_schema for structured search + exact method definitions
 * - Registers cf_execute — Pi writes an async arrow function, backend runs it in sandbox
 * - Preflights codemode.* names before execution when schema is available
 * - Appends local audit entries and shows recent activity in a widget
 * - Confirmation gate on mode=apply
 * - /cf-codemode-status and /cf-codemode-log commands for diagnostics
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_NAME = "cf_execute";
const TOOL_LABEL = "Cloudflare Codemode";
const SCHEMA_TOOL_NAME = "cf_codemode_schema";
const SCHEMA_TOOL_LABEL = "Cloudflare Codemode Schema";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TOKEN_ENV_VAR = "CF_CODEMODE_TOKEN";
const DEFAULT_BASE_URL_ENV_VAR = "CF_CODEMODE_URL";
const RUN_MODES = ["plan", "apply"] as const;
const PROMPT_INJECTION_MODES = ["lazy", "full", "off"] as const;
const AUDIT_WIDGET_KEY = "cf-codemode-activity";
const DEFAULT_AUDIT_WIDGET = false;
const AUDIT_LOG_FILE_NAME = "cloudflare-codemode.jsonl";
const RECENT_ACTIVITY_LIMIT = 6;
const DEFAULT_AUDIT_TAIL = 20;

// ---------------------------------------------------------------------------
// Tool parameters
// ---------------------------------------------------------------------------

const TOOL_PARAMS = Type.Object({
	mode: StringEnum(RUN_MODES),
	code: Type.String({
		description:
			"JavaScript async arrow function using codemode.* methods. Example: async () => { const w = await codemode.cf_workers_list({}); return w; }",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			minimum: 1_000,
			maximum: MAX_TIMEOUT_MS,
			description: "Override request timeout in milliseconds.",
		}),
	),
});

const SCHEMA_TOOL_PARAMS = Type.Object({
	methods: Type.Optional(
		Type.Array(Type.String({ description: "Exact codemode method names like cf_workers_list or cf_images_monthly_usage_get." })),
	),
	query: Type.Optional(Type.String({ description: "Substring search for codemode methods, product names, or keywords." })),
	maxItems: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 100,
			description: "Maximum matches to return when searching. Defaults to 20.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ExtensionConfig {
	baseUrl?: string;
	executePath?: string;
	schemaPath?: string;
	healthPath?: string;
	tokenEnvVar?: string;
	token?: string;
	timeoutMs?: number;
	requireApplyConfirmation?: boolean;
	blockApplyWithoutUI?: boolean;
	promptInjectionMode?: string;
	auditWidget?: boolean;
	extraHeaders?: Record<string, string>;
}

interface ResolvedConfig {
	baseUrl?: string;
	executePath: string;
	schemaPath: string;
	healthPath: string;
	tokenEnvVar: string;
	token?: string;
	timeoutMs: number;
	requireApplyConfirmation: boolean;
	blockApplyWithoutUI: boolean;
	promptInjectionMode: (typeof PROMPT_INJECTION_MODES)[number];
	auditWidget: boolean;
	extraHeaders: Record<string, string>;
}

function readConfigFile(path: string): ExtensionConfig {
	if (!existsSync(path)) return {};
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as ExtensionConfig) ?? {};
	} catch {
		return {};
	}
}

function normalizeUrl(url?: string): string | undefined {
	if (!url) return undefined;
	const trimmed = url.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function normalizePath(path: string | undefined, fallback: string): string {
	const raw = (path || fallback).trim();
	return raw.startsWith("/") ? raw : `/${raw}`;
}

function clampTimeout(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(Math.floor(value), 1_000), MAX_TIMEOUT_MS);
}

function normalizePromptInjectionMode(value: string | undefined): (typeof PROMPT_INJECTION_MODES)[number] {
	return value === "full" || value === "off" ? value : "lazy";
}

function loadConfig(cwd: string): ResolvedConfig {
	const globalConfig = readConfigFile(join(homedir(), ".pi", "agent", "extensions", "cloudflare-codemode.json"));
	const projectConfig = readConfigFile(join(cwd, ".pi", "extensions", "cloudflare-codemode.json"));
	const merged = { ...globalConfig, ...projectConfig };

	return {
		baseUrl: normalizeUrl(merged.baseUrl || process.env[DEFAULT_BASE_URL_ENV_VAR]),
		executePath: normalizePath(merged.executePath, "/execute"),
		schemaPath: normalizePath(merged.schemaPath, "/schema"),
		healthPath: normalizePath(merged.healthPath, "/health"),
		tokenEnvVar: merged.tokenEnvVar?.trim() || DEFAULT_TOKEN_ENV_VAR,
		token: merged.token,
		timeoutMs: clampTimeout(merged.timeoutMs),
		requireApplyConfirmation: merged.requireApplyConfirmation ?? true,
		blockApplyWithoutUI: merged.blockApplyWithoutUI ?? true,
		promptInjectionMode: normalizePromptInjectionMode(merged.promptInjectionMode),
		auditWidget:
			typeof merged.auditWidget === "boolean"
				? merged.auditWidget
				: process.env.CF_CODEMODE_AUDIT_WIDGET
					? process.env.CF_CODEMODE_AUDIT_WIDGET === "1"
					: DEFAULT_AUDIT_WIDGET,
		extraHeaders: merged.extraHeaders ?? {},
	};
}

function resolveToken(config: ResolvedConfig): string | undefined {
	return process.env[config.tokenEnvVar]?.trim() || config.token?.trim() || undefined;
}

function makeHeaders(config: ResolvedConfig): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json", ...config.extraHeaders };
	const token = resolveToken(config);
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

// ---------------------------------------------------------------------------
// Schema fetching
// ---------------------------------------------------------------------------

interface SchemaMethodDescriptor {
	name: string;
	description?: string;
	endpoint?: string;
	inputSchema?: Record<string, unknown>;
	required?: string[];
	mutating?: boolean;
	product?: string;
	aliases?: string[];
	keywords?: string[];
}

interface SchemaResponse {
	schemaVersion?: number;
	generatedAt?: string;
	types: string;
	tools: string[];
	methods?: SchemaMethodDescriptor[];
}

interface SchemaSearchMatch {
	method: SchemaMethodDescriptor;
	score: number;
}

interface SchemaFieldSummary {
	name: string;
	type: string;
	required: boolean;
	description?: string;
}

type AuditKind = "schema" | "execute";
type AuditPhase = "start" | "result" | "error";

interface AuditEntry {
	timestamp: string;
	kind: AuditKind;
	phase: AuditPhase;
	summary: string;
	cwd: string;
	sessionFile?: string;
	toolName: string;
	toolCallId?: string;
	isError?: boolean;
	data?: Record<string, unknown>;
}

async function fetchSchema(config: ResolvedConfig): Promise<SchemaResponse | null> {
	if (!config.baseUrl) return null;
	const url = `${config.baseUrl}${config.schemaPath}`;
	const headers = makeHeaders(config);

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15_000);
		const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
		clearTimeout(timer);
		if (!response.ok) return null;
		return (await response.json()) as SchemaResponse;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEARCH_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"by",
	"cloudflare",
	"current",
	"details",
	"exact",
	"for",
	"from",
	"get",
	"help",
	"in",
	"into",
	"is",
	"list",
	"lookup",
	"of",
	"on",
	"or",
	"return",
	"returns",
	"show",
	"the",
	"to",
	"tool",
	"use",
	"with",
]);

const SHORT_SEARCH_TOKENS = new Set(["ai", "cf", "d1", "kv", "r2", "waf"]);

function shortCode(code: string, limit = 200): string {
	const trimmed = code.trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

async function writeFullOutput(content: string): Promise<string> {
	const outputDir = join(tmpdir(), "pi-cloudflare-codemode");
	await mkdir(outputDir, { recursive: true });
	const outputPath = join(outputDir, `codemode-${Date.now()}-${randomUUID()}.log`);
	await writeFile(outputPath, content, "utf8");
	return outputPath;
}

async function ping(endpoint: string, timeoutMs: number, headers: Record<string, string>): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(endpoint, { method: "GET", headers, signal: controller.signal });
		const body = await response.text();
		return response.ok
			? `OK (${response.status})${body ? `: ${body}` : ""}`
			: `Failed (${response.status}): ${body || response.statusText}`;
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		clearTimeout(timer);
	}
}

function safeJson(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function normalizeSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenizeSearchText(value: string): string[] {
	const normalized = normalizeSearchText(value);
	if (!normalized) return [];
	const tokens = new Set<string>();
	for (const token of normalized.split(/\s+/)) {
		if (!token) continue;
		if (!SHORT_SEARCH_TOKENS.has(token) && (token.length < 3 || SEARCH_STOPWORDS.has(token))) continue;
		tokens.add(token);
		if (token.endsWith("ies") && token.length > 3) {
			tokens.add(`${token.slice(0, -3)}y`);
		} else if (token.endsWith("s") && token.length > 3) {
			tokens.add(token.slice(0, -1));
		}
	}
	return Array.from(tokens);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function normalizeSchemaMethod(method: SchemaMethodDescriptor): SchemaMethodDescriptor {
	return {
		name: method.name,
		description: method.description,
		endpoint: method.endpoint,
		inputSchema: method.inputSchema ?? { type: "object", properties: {} },
		required: Array.isArray(method.required) ? method.required.filter((value): value is string => typeof value === "string") : [],
		mutating: Boolean(method.mutating),
		product: method.product,
		aliases: uniqueStrings(method.aliases ?? []),
		keywords: uniqueStrings(method.keywords ?? []),
	};
}

function getSchemaMethods(schema: SchemaResponse): SchemaMethodDescriptor[] {
	if (Array.isArray(schema.methods) && schema.methods.length > 0) {
		return schema.methods.map(normalizeSchemaMethod);
	}
	return schema.tools.map((name) => normalizeSchemaMethod({ name }));
}

function getSchemaMethodMap(schema: SchemaResponse): Map<string, SchemaMethodDescriptor> {
	return new Map(getSchemaMethods(schema).map((method) => [method.name, method]));
}

function looksCloudflareRelated(prompt: string): boolean {
	return /(cloudflare|\bcf[_ -]?|workers?\b|wrangler\b|\bd1\b|\bkv\b|\br2\b|durable objects?|hyperdrive|vectorize|turnstile|zaraz|snippets?\b|dns\b|zones?\b|pages\b|workflows?\b|queues?\b|stream\b|images\b|load balanc|waiting room|api gateway|waf\b|registrar\b)/i.test(prompt);
}

function scoreSchemaMethod(method: SchemaMethodDescriptor, rawQuery: string): number {
	const query = normalizeSearchText(rawQuery);
	if (!query) return 0;

	const nameText = normalizeSearchText(method.name.replace(/_/g, " "));
	const descriptionText = normalizeSearchText(method.description ?? "");
	const productText = normalizeSearchText(method.product ?? "");
	const aliasTexts = (method.aliases ?? []).map(normalizeSearchText).filter(Boolean);
	const keywordTexts = (method.keywords ?? []).map(normalizeSearchText).filter(Boolean);
	const searchableTexts = [nameText, descriptionText, productText, ...aliasTexts, ...keywordTexts].filter(Boolean);
	const queryTokens = tokenizeSearchText(rawQuery);
	const nameTokens = new Set(tokenizeSearchText(nameText));
	const descriptionTokens = new Set(tokenizeSearchText(descriptionText));
	const productTokens = new Set(tokenizeSearchText(productText));
	const aliasTokens = new Set(aliasTexts.flatMap((value) => tokenizeSearchText(value)));
	const keywordTokens = new Set(keywordTexts.flatMap((value) => tokenizeSearchText(value)));

	let score = 0;
	if (normalizeSearchText(method.name) === query) score += 220;
	if (nameText === query) score += 200;
	if (nameText.includes(query)) score += 100;
	if (descriptionText.includes(query) || productText.includes(query) || aliasTexts.some((text) => text.includes(query))) score += 40;

	let matchedTokens = 0;
	for (const token of queryTokens) {
		let tokenScore = 0;
		if (nameTokens.has(token)) tokenScore = 24;
		else if (aliasTokens.has(token) || keywordTokens.has(token)) tokenScore = 18;
		else if (descriptionTokens.has(token) || productTokens.has(token)) tokenScore = 12;
		else if (searchableTexts.some((text) => text.includes(token))) tokenScore = 6;
		if (tokenScore > 0) {
			matchedTokens += 1;
			score += tokenScore;
		}
	}

	if (queryTokens.length > 0 && matchedTokens === queryTokens.length) score += 30;
	else score += matchedTokens * 2;
	if (method.mutating && /(apply|create|delete|edit|mutat|patch|publish|purge|put|remove|replace|restore|update)/i.test(rawQuery)) {
		score += 8;
	}
	return score;
}

function searchSchemaTools(methods: SchemaMethodDescriptor[], rawQuery: string, maxItems: number): SchemaSearchMatch[] {
	return methods
		.map((method) => ({ method, score: scoreSchemaMethod(method, rawQuery) }))
		.filter((match) => match.score > 0)
		.sort((a, b) => b.score - a.score || a.method.name.localeCompare(b.method.name))
		.slice(0, maxItems);
}

function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;

	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 0; i < a.length; i += 1) {
		let diagonal = previous[0];
		previous[0] = i + 1;
		for (let j = 0; j < b.length; j += 1) {
			const old = previous[j + 1];
			if (a[i] === b[j]) previous[j + 1] = diagonal;
			else previous[j + 1] = Math.min(diagonal + 1, previous[j] + 1, previous[j + 1] + 1);
			diagonal = old;
		}
	}
	return previous[b.length];
}

function suggestSchemaMethods(methods: SchemaMethodDescriptor[], rawName: string, maxItems: number): string[] {
	const normalizedTarget = rawName.trim().toLowerCase();
	if (!normalizedTarget) return [];
	return methods
		.map((method) => {
			const nameScore = scoreSchemaMethod(method, rawName);
			const distance = levenshteinDistance(normalizedTarget, method.name.toLowerCase());
			const maxLen = Math.max(normalizedTarget.length, method.name.length, 1);
			const similarityScore = Math.round((1 - distance / maxLen) * 40);
			return { name: method.name, score: nameScore + similarityScore };
		})
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, maxItems)
		.map((item) => item.name);
}

function toolNameToBaseType(toolName: string): string {
	return toolName
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTypeBlock(source: string, typeName: string): string | null {
	const marker = `type ${typeName} =`;
	const start = source.indexOf(marker);
	if (start === -1) return null;
	const afterEquals = source.indexOf("=", start);
	if (afterEquals === -1) return null;
	let i = afterEquals + 1;
	while (i < source.length && /\s/.test(source[i])) i += 1;
	if (i >= source.length) return null;
	if (source[i] !== "{") {
		const end = source.indexOf("\n", i);
		return source.slice(start, end === -1 ? source.length : end).trim();
	}
	let depth = 0;
	let j = i;
	for (; j < source.length; j += 1) {
		const ch = source[j];
		if (ch === "{") depth += 1;
		if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				j += 1;
				break;
			}
		}
	}
	while (j < source.length && source[j] !== "\n") j += 1;
	return source.slice(start, j).trim();
}

function extractMethodSignature(source: string, toolName: string): string | null {
	const match = source.match(new RegExp(`^\\s*${escapeRegExp(toolName)}:.*$`, "m"));
	return match?.[0]?.trim() || null;
}

function renderToolSchemaSlice(source: string, toolName: string): string | undefined {
	const base = toolNameToBaseType(toolName);
	const blocks = [
		extractTypeBlock(source, `${base}Input`),
		extractTypeBlock(source, `${base}Output`),
		extractMethodSignature(source, toolName),
	].filter((value): value is string => Boolean(value));
	return blocks.length ? blocks.join("\n\n") : undefined;
}

function summarizeJsonSchemaType(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "unknown";
	const typedSchema = schema as Record<string, unknown>;
	const enumValues = Array.isArray(typedSchema.enum) ? typedSchema.enum : undefined;
	if (enumValues?.length) return enumValues.map((value) => JSON.stringify(value)).join(" | ");
	if (Array.isArray(typedSchema.anyOf)) return typedSchema.anyOf.map((item) => summarizeJsonSchemaType(item)).join(" | ");
	if (Array.isArray(typedSchema.oneOf)) return typedSchema.oneOf.map((item) => summarizeJsonSchemaType(item)).join(" | ");
	if (Array.isArray(typedSchema.allOf)) return typedSchema.allOf.map((item) => summarizeJsonSchemaType(item)).join(" & ");
	if (Array.isArray(typedSchema.type)) return typedSchema.type.join(" | ");
	if (typedSchema.type === "array") return `${summarizeJsonSchemaType(typedSchema.items)}[]`;
	if (typedSchema.type === "object") return typedSchema.properties ? "object" : "Record<string, unknown>";
	if (typeof typedSchema.type === "string") return typedSchema.type;
	if (typedSchema.properties) return "object";
	return "unknown";
}

function summarizeInputFields(inputSchema: Record<string, unknown> | undefined): SchemaFieldSummary[] {
	const properties = inputSchema && typeof inputSchema === "object"
		? (inputSchema.properties as Record<string, unknown> | undefined)
		: undefined;
	if (!properties) return [];
	const requiredNames = inputSchema && typeof inputSchema === "object" && Array.isArray(inputSchema.required)
		? inputSchema.required.filter((value): value is string => typeof value === "string")
		: [];
	const required = new Set(requiredNames);
	return Object.entries(properties).map(([name, schema]) => {
		const property = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
		return {
			name,
			type: summarizeJsonSchemaType(schema),
			required: required.has(name),
			description: typeof property.description === "string" ? property.description : undefined,
		};
	});
}

function extractCodemodeMethodNames(code: string): string[] {
	const matches = Array.from(code.matchAll(/\bcodemode\.([A-Za-z_$][\w$]*)/g));
	return Array.from(new Set(matches.map((match) => match[1])));
}

function getAuditLogFile(): string {
	return join(getAgentDir(), "logs", AUDIT_LOG_FILE_NAME);
}

function formatAuditTime(timestamp: string): string {
	return /^\d{4}-\d{2}-\d{2}T/.test(timestamp) ? timestamp.slice(11, 19) : timestamp;
}

function truncateForAudit(value: string, limit = 160): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

async function appendAuditEntry(entry: AuditEntry): Promise<void> {
	const logFile = getAuditLogFile();
	await mkdir(join(getAgentDir(), "logs"), { recursive: true });
	await withFileMutationQueue(logFile, async () => {
		await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
	});
}

async function readAuditEntries(options: { limit: number; sessionFile?: string; cwd?: string }): Promise<AuditEntry[]> {
	try {
		const raw = await readFile(getAuditLogFile(), "utf8");
		const entries = raw
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as AuditEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is AuditEntry => Boolean(entry));
		const filtered = entries.filter((entry) => {
			if (options.sessionFile && entry.sessionFile === options.sessionFile) return true;
			if (options.sessionFile) return false;
			if (options.cwd) return entry.cwd === options.cwd;
			return true;
		});
		return filtered.slice(-options.limit);
	} catch {
		return [];
	}
}

function buildAuditWidgetLines(entries: AuditEntry[], ctx: ExtensionContext): string[] {
	const theme = ctx.ui.theme;
	if (entries.length === 0) {
		return [theme.fg("muted", "cf-codemode recent: no activity")];
	}

	return [
		theme.fg("accent", "cf-codemode recent"),
		...entries.slice(-RECENT_ACTIVITY_LIMIT).map((entry) => {
			const prefix = theme.fg("dim", formatAuditTime(entry.timestamp));
			const summary = entry.isError
				? theme.fg("error", entry.summary)
				: entry.kind === "execute" && entry.phase === "result"
					? theme.fg("success", entry.summary)
					: theme.fg("muted", entry.summary);
			return `${prefix} ${summary}`;
		}),
	];
}

function updateActivityWidget(ctx: ExtensionContext, entries: AuditEntry[]): void {
	if (!ctx.hasUI) return;
	if (!loadConfig(ctx.cwd).auditWidget) {
		ctx.ui.setWidget(AUDIT_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(AUDIT_WIDGET_KEY, buildAuditWidgetLines(entries, ctx), { placement: "belowEditor" });
}

async function recordAuditEntry(ctx: ExtensionContext, recentActivity: AuditEntry[], entry: AuditEntry): Promise<void> {
	recentActivity.push(entry);
	if (recentActivity.length > RECENT_ACTIVITY_LIMIT) {
		recentActivity.splice(0, recentActivity.length - RECENT_ACTIVITY_LIMIT);
	}
	updateActivityWidget(ctx, recentActivity);
	try {
		await appendAuditEntry(entry);
	} catch {
		// Ignore local audit logging failures.
	}
}

function formatAuditReport(entries: AuditEntry[], options: { sessionOnly: boolean }): string {
	const lines = [
		"Cloudflare Codemode audit log",
		`  path: ${getAuditLogFile()}`,
		`  entries: ${entries.length}${options.sessionOnly ? " (current session)" : ""}`,
		"",
	];
	for (const entry of entries) {
		lines.push(`[${formatAuditTime(entry.timestamp)}] ${entry.summary}`);
	}
	return lines.join("\n");
}

function parseAuditCommandArgs(rawArgs: string | undefined): { tail: number; json: boolean; session: boolean; path: boolean } {
	const tokens = (rawArgs ?? "").split(/\s+/).filter(Boolean);
	let tail = DEFAULT_AUDIT_TAIL;
	let json = false;
	let session = false;
	let path = false;

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--json") json = true;
		else if (token === "--session") session = true;
		else if (token === "--path") path = true;
		else if (token === "--tail") {
			const next = Number(tokens[i + 1]);
			if (Number.isFinite(next) && next > 0) {
				tail = Math.min(Math.floor(next), 200);
				i += 1;
			}
		} else {
			const numeric = Number(token);
			if (Number.isFinite(numeric) && numeric > 0) {
				tail = Math.min(Math.floor(numeric), 200);
			}
		}
	}

	return { tail, json, session, path };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function cloudflareCodemodeExtension(pi: ExtensionAPI) {
	let cachedSchema: SchemaResponse | null = null;
	let recentActivity: AuditEntry[] = [];

	async function ensureSchema(cwd: string): Promise<SchemaResponse | null> {
		if (cachedSchema) return cachedSchema;
		const config = loadConfig(cwd);
		if (!config.baseUrl) return null;
		cachedSchema = await fetchSchema(config);
		return cachedSchema;
	}

	async function hydrateRecentActivity(ctx: ExtensionContext): Promise<void> {
		const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		recentActivity = await readAuditEntries({ limit: RECENT_ACTIVITY_LIMIT, sessionFile, cwd: ctx.cwd });
		if (recentActivity.length === 0 && sessionFile) {
			recentActivity = await readAuditEntries({ limit: RECENT_ACTIVITY_LIMIT, cwd: ctx.cwd });
		}
		updateActivityWidget(ctx, recentActivity);
	}

	// Keep prompt overhead low by default. Full schema injection is optional.
	pi.on("before_agent_start", async (event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.promptInjectionMode === "off") return undefined;
		if (config.promptInjectionMode === "full") {
			if (!cachedSchema?.types) return undefined;
			const injection = [
				"\n\n## Cloudflare Codemode API",
				"When using the cf_execute tool, write an async arrow function using the codemode.* methods below.",
				"These methods are available in the sandbox. Call them like: await codemode.cf_workers_list({})",
				"",
				"```typescript",
				cachedSchema.types,
				"```",
				"",
				`Available tools: ${cachedSchema.tools.join(", ")}`,
			].join("\n");
			return { systemPrompt: event.systemPrompt + injection };
		}

		if (!looksCloudflareRelated(event.prompt)) return undefined;
		const toolCount = cachedSchema?.tools.length ?? 0;
		const note = [
			"\n\n## Cloudflare Codemode",
			"Cloudflare Codemode is available via the cf_execute tool.",
			"Use mode=plan first and mode=apply only for explicit mutations.",
			`There is 1 Pi tool backed by ${toolCount || "many"} Cloudflare methods; they are not all embedded by default.`,
			"If you need exact codemode.* method names or argument shapes, call cf_codemode_schema first.",
		].join("\n");
		return { systemPrompt: event.systemPrompt + note };
	});

	// Fetch schema on session start
	pi.on("session_start", async (_event, ctx) => {
		await hydrateRecentActivity(ctx);
		const config = loadConfig(ctx.cwd);
		if (!config.baseUrl) {
			ctx.ui.setStatus("cf-codemode", "cf-codemode: unconfigured");
			return;
		}

		let host = config.baseUrl;
		try {
			host = new URL(config.baseUrl).host;
		} catch {}

		ctx.ui.setStatus("cf-codemode", `cf-codemode: ${host} (loading schema…)`);

		cachedSchema = await fetchSchema(config);
		if (cachedSchema) {
			ctx.ui.setStatus("cf-codemode", `cf-codemode: ${host} (${cachedSchema.tools.length} methods)`);
		} else {
			ctx.ui.setStatus("cf-codemode", `cf-codemode: ${host} (schema fetch failed)`);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		recentActivity = [];
		cachedSchema = null;
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(AUDIT_WIDGET_KEY, undefined);
		ctx.ui.setStatus("cf-codemode", undefined);
	});

	// Status command
	pi.registerCommand("cf-codemode-status", {
		description: "Show Cloudflare Codemode config, schema, and optional health check (--ping)",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const token = resolveToken(config);
			const shouldPing = (args ?? "").split(/\s+/).includes("--ping");

			const lines = [
				"Cloudflare Codemode status",
				`  endpoint: ${config.baseUrl ?? "(not configured)"}`,
				`  execute: ${config.baseUrl ? config.baseUrl + config.executePath : "-"}`,
				`  schema:  ${config.baseUrl ? config.baseUrl + config.schemaPath : "-"}`,
				`  token:   ${token ? "set" : "missing"} (env: ${config.tokenEnvVar})`,
				`  timeout: ${config.timeoutMs}ms`,
				`  schema cached: ${cachedSchema ? `yes (${cachedSchema.tools.length} methods)` : "no"}`,
				`  apply confirmation: ${config.requireApplyConfirmation ? "yes" : "no"}`,
				`  prompt injection mode: ${config.promptInjectionMode}`,
				`  audit widget: ${config.auditWidget ? "on" : "off"}`,
				`  audit log: ${getAuditLogFile()}`,
			];

			if (cachedSchema) {
				const preview = cachedSchema.tools.slice(0, 12).join(", ");
				const more = cachedSchema.tools.length > 12 ? ` … +${cachedSchema.tools.length - 12} more` : "";
				lines.push(`  methods preview: ${preview}${more}`);
				lines.push("  lookup: use cf_codemode_schema for exact names, search, and input schemas");
			}

			if (shouldPing && config.baseUrl) {
				const healthUrl = `${config.baseUrl}${config.healthPath}`;
				const result = await ping(healthUrl, Math.min(config.timeoutMs, 15_000), makeHeaders(config));
				lines.push(`  health: ${result}`);
			}

			const refreshSchema = (args ?? "").split(/\s+/).includes("--refresh");
			if (refreshSchema && config.baseUrl) {
				cachedSchema = await fetchSchema(config);
				lines.push(`  schema refresh: ${cachedSchema ? `OK (${cachedSchema.tools.length} methods)` : "failed"}`);
			}

			pi.sendMessage({
				customType: "cf-codemode-status",
				content: lines.join("\n"),
				display: true,
			});
		},
	});

	pi.registerCommand("cf-codemode-log", {
		description: "Show recent Cloudflare Codemode audit entries (--tail N, --session, --json, --path)",
		handler: async (args, ctx) => {
			const options = parseAuditCommandArgs(args);
			if (options.path) {
				pi.sendMessage({
					customType: "cf-codemode-log",
					content: `Cloudflare Codemode audit log path\n  ${getAuditLogFile()}`,
					display: true,
				});
				return;
			}

			const sessionFile = options.session ? ctx.sessionManager.getSessionFile() ?? undefined : undefined;
			const entries = await readAuditEntries({ limit: options.tail, sessionFile, cwd: options.session ? undefined : ctx.cwd });
			const content = options.json
				? safeJson({ path: getAuditLogFile(), entries })
				: formatAuditReport(entries, { sessionOnly: Boolean(sessionFile) });

			pi.sendMessage({
				customType: "cf-codemode-log",
				content,
				display: true,
				details: { path: getAuditLogFile(), entries },
			});
		},
	});

	pi.registerTool({
		name: SCHEMA_TOOL_NAME,
		label: SCHEMA_TOOL_LABEL,
		description:
			"Inspect Cloudflare Codemode methods without embedding the full backend schema into every Pi session. Search by keyword or return exact method definitions for named codemode methods.",
		promptSnippet:
			"Use this before cf_execute when you need exact codemode.* method names, input shapes, or a quick search across available Cloudflare methods.",
		promptGuidelines: [
			"Prefer this tool over asking for the full Cloudflare Codemode schema in prompt context.",
			"Pass methods:[...] for exact definitions, or query:'images' / query:'dns' / query:'durable objects' to search.",
		],
		parameters: SCHEMA_TOOL_PARAMS,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const schema = await ensureSchema(ctx.cwd);
				if (!schema) {
					throw new Error(
						"Cloudflare Codemode schema unavailable. Configure CF_CODEMODE_URL / token, then run /cf-codemode-status --refresh.",
					);
				}

				const methods = getSchemaMethods(schema);
				const methodMap = getSchemaMethodMap(schema);
				const maxItems = Math.max(1, Math.min(100, Math.floor(Number(params.maxItems ?? 20)) || 20));
				const requestedMethods = Array.from(new Set((params.methods ?? []).map((tool) => tool.trim()).filter(Boolean)));
				const exactMethods = requestedMethods.map((tool) => methodMap.get(tool)).filter((tool): tool is SchemaMethodDescriptor => Boolean(tool));
				const unknownMethods = requestedMethods.filter((tool) => !methodMap.has(tool));
				const suggestions = Object.fromEntries(
					unknownMethods.map((tool) => [tool, suggestSchemaMethods(methods, tool, 5)]),
				);
				const rankedMatches = params.query ? searchSchemaTools(methods, params.query, maxItems) : [];
				const selectedMethods = exactMethods.length > 0
					? exactMethods
					: rankedMatches.slice(0, Math.min(rankedMatches.length, 8)).map((match) => match.method);
				const definitions = selectedMethods.map((method) => {
					const inputFields = summarizeInputFields(method.inputSchema);
					const required = method.required?.length ? method.required : inputFields.filter((field) => field.required).map((field) => field.name);
					return {
						name: method.name,
						description: method.description,
						endpoint: method.endpoint,
						product: method.product,
						mutating: Boolean(method.mutating),
						required,
						aliases: method.aliases ?? [],
						keywords: method.keywords ?? [],
						inputFields,
						inputSchema: method.inputSchema,
						typescript: renderToolSchemaSlice(schema.types, method.name),
					};
				});
				const matches = rankedMatches.map(({ method, score }) => ({
					name: method.name,
					score,
					description: method.description,
					endpoint: method.endpoint,
					product: method.product,
					mutating: Boolean(method.mutating),
				}));

				await recordAuditEntry(ctx, recentActivity, {
					timestamp: new Date().toISOString(),
					kind: "schema",
					phase: "result",
					summary: params.query
						? `schema query ${truncateForAudit(params.query, 80)} → ${matches.length} matches`
						: `schema exact lookup ${requestedMethods.join(", ") || "(none)"}`,
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
					toolName: SCHEMA_TOOL_NAME,
					toolCallId,
					data: {
						query: params.query,
						requestedMethods,
						unknownMethods,
						matchNames: matches.map((match) => match.name),
						definitionNames: definitions.map((definition) => definition.name),
					},
				});

				return {
					content: [
						{
							type: "text",
							text: safeJson({
								schemaVersion: schema.schemaVersion ?? 1,
								toolCount: schema.tools.length,
								query: params.query ?? null,
								requestedMethods: requestedMethods.length ? requestedMethods : undefined,
								unknownMethods: unknownMethods.length ? unknownMethods : undefined,
								suggestions: unknownMethods.length ? suggestions : undefined,
								matches,
								definitions,
								note: exactMethods.length > 0
									? "Returned structured definitions for the requested methods."
									: "Search results shown. Pass methods:[...] to get exact definitions for specific tools.",
							}),
						},
					],
					details: {
						schemaVersion: schema.schemaVersion ?? 1,
						toolCount: schema.tools.length,
						query: params.query,
						requestedMethods,
						unknownMethods,
						matches,
						definitions,
					},
				};
			} catch (error) {
				await recordAuditEntry(ctx, recentActivity, {
					timestamp: new Date().toISOString(),
					kind: "schema",
					phase: "error",
					summary: params.query
						? `schema query failed ${truncateForAudit(params.query, 80)}`
						: `schema exact lookup failed ${(params.methods ?? []).join(", ") || "(none)"}`,
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
					toolName: SCHEMA_TOOL_NAME,
					toolCallId,
					isError: true,
					data: {
						query: params.query,
						methods: params.methods,
						error: error instanceof Error ? error.message : String(error),
					},
				});
				throw error;
			}
		},
	});

	// Confirmation gate for apply mode
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== TOOL_NAME) return undefined;
		const input = event.input as Partial<ToolParams>;
		if (input.mode !== "apply") return undefined;

		const config = loadConfig(ctx.cwd);
		if (!config.requireApplyConfirmation) return undefined;

		if (!ctx.hasUI) {
			if (config.blockApplyWithoutUI) {
				return { block: true, reason: "cf_execute(apply) blocked: no UI for confirmation" };
			}
			return undefined;
		}

		const ok = await ctx.ui.confirm(
			"Cloudflare Codemode: apply",
			`Allow mutating execution?\n\n${shortCode(input.code ?? "(no code)")}`,
		);
		if (!ok) return { block: true, reason: "Apply denied by user" };
		return undefined;
	});

	// The tool: Pi writes code, backend executes it
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Execute JavaScript code in the Cloudflare Codemode sandbox. The code is an async arrow function that calls codemode.* methods (Workers, D1, KV, R2, etc). Use mode=plan for read-only, mode=apply for mutations.",
		promptSnippet:
			"Run multi-step Cloudflare operations by writing an async arrow function that calls codemode.* methods.",
		promptGuidelines: [
			"Write code as: async () => { const result = await codemode.cf_workers_list({}); return result; }",
			"Use mode=plan first. Only use mode=apply when the user explicitly wants mutations.",
			"If you need exact codemode.* method names or argument shapes, call cf_codemode_schema first instead of relying on huge prompt injections.",
			"For simple single-step Cloudflare operations, prefer using bash with wrangler instead of this tool.",
		],
		parameters: TOOL_PARAMS,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const config = loadConfig(ctx.cwd);
			if (!config.baseUrl) {
				throw new Error(
					"Cloudflare Codemode not configured. Set CF_CODEMODE_URL or create ~/.pi/agent/extensions/cloudflare-codemode.json",
				);
			}

			const endpoint = `${config.baseUrl}${config.executePath}`;
			const timeoutMs = clampTimeout(params.timeoutMs ?? config.timeoutMs);
			const headers = makeHeaders(config);
			const extractedMethods = extractCodemodeMethodNames(params.code);
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;

			await recordAuditEntry(ctx, recentActivity, {
				timestamp: new Date().toISOString(),
				kind: "execute",
				phase: "start",
				summary: `execute ${params.mode} ${extractedMethods.join(", ") || "(no codemode methods found)"}`,
				cwd: ctx.cwd,
				sessionFile,
				toolName: TOOL_NAME,
				toolCallId,
				data: {
					mode: params.mode,
					endpoint,
					timeoutMs,
					extractedMethods,
					code: params.code,
					codePreview: truncateForAudit(params.code, 220),
				},
			});

			try {
				const schema = extractedMethods.length > 0 ? await ensureSchema(ctx.cwd) : cachedSchema;
				if (schema && extractedMethods.length > 0) {
					const methods = getSchemaMethods(schema);
					const methodMap = getSchemaMethodMap(schema);
					const unknownMethods = extractedMethods.filter((name) => !methodMap.has(name));
					if (unknownMethods.length > 0) {
						const suggestionLines = unknownMethods
							.map((name) => {
								const suggestions = suggestSchemaMethods(methods, name, 5);
								return suggestions.length > 0 ? `  ${name}: ${suggestions.join(", ")}` : `  ${name}: no close match`;
							})
							.join("\n");
						throw new Error(
							[
								`Unknown codemode method${unknownMethods.length > 1 ? "s" : ""}: ${unknownMethods.join(", ")}`,
								"Use cf_codemode_schema to look up the exact names before retrying.",
								suggestionLines ? `Suggestions:\n${suggestionLines}` : undefined,
							].filter(Boolean).join("\n\n"),
						);
					}
				}

				onUpdate?.({
					content: [{ type: "text", text: `Executing codemode (${params.mode})…` }],
					details: { phase: "start", endpoint, extractedMethods },
				});

				const startedAt = Date.now();
				const controller = new AbortController();
				const abortFromSignal = () => controller.abort();
				signal?.addEventListener("abort", abortFromSignal, { once: true });
				const timer = setTimeout(() => controller.abort(), timeoutMs);

				let responseText = "";
				let parsed: Record<string, unknown> | undefined;

				try {
					const response = await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify({ mode: params.mode, code: params.code }),
						signal: controller.signal,
					});

					responseText = await response.text();
					const ct = response.headers.get("content-type")?.toLowerCase() ?? "";
					if (ct.includes("application/json") && responseText) {
						parsed = JSON.parse(responseText) as Record<string, unknown>;
					}

					if (!response.ok) {
						throw new Error(
							(parsed?.error as string) || `Backend returned ${response.status}: ${responseText || response.statusText}`,
						);
					}
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") {
						throw new Error(`Codemode timed out after ${timeoutMs}ms`);
					}
					throw error;
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abortFromSignal);
				}

				const durationMs = Date.now() - startedAt;
				const effective = parsed ?? { output: responseText };
				const backendStatus = typeof effective.status === "string" ? effective.status : undefined;
				const backendError = effective.error === undefined ? undefined : safeJson(effective.error);

				const lines: string[] = [];
				lines.push(`Codemode execution complete (${params.mode})`);
				lines.push(`Duration: ${durationMs}ms`);
				if (effective.runId) lines.push(`Run ID: ${effective.runId}`);
				if (backendStatus) lines.push(`Status: ${backendStatus}`);
				if (extractedMethods.length > 0) lines.push(`Methods: ${extractedMethods.join(", ")}`);
				if (backendError) lines.push(`\nError: ${backendError}`);
				if (effective.result !== undefined) lines.push(`\nResult:\n${safeJson(effective.result)}`);
				if (Array.isArray(effective.logs) && effective.logs.length > 0) {
					lines.push(`\nLogs:\n${(effective.logs as string[]).join("\n")}`);
				}

				const fullOutput = lines.join("\n");
				const truncation = truncateTail(fullOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let content = truncation.content;
				let fullOutputPath: string | undefined;

				if (truncation.truncated) {
					fullOutputPath = await writeFullOutput(fullOutput);
					content += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines`;
					content += ` (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}).`;
					content += ` Full: ${fullOutputPath}]`;
				}

				if (backendStatus === "error" || backendError) {
					throw new Error(content);
				}

				await recordAuditEntry(ctx, recentActivity, {
					timestamp: new Date().toISOString(),
					kind: "execute",
					phase: "result",
					summary: `execute ${params.mode} ok ${extractedMethods.join(", ") || "(no codemode methods found)"} ${durationMs}ms`,
					cwd: ctx.cwd,
					sessionFile,
					toolName: TOOL_NAME,
					toolCallId,
					data: {
						mode: params.mode,
						endpoint,
						durationMs,
						runId: effective.runId,
						status: backendStatus,
						extractedMethods,
						truncated: truncation.truncated,
						fullOutputPath,
						resultPreview: effective.result === undefined ? undefined : truncateForAudit(safeJson(effective.result), 500),
						logsCount: Array.isArray(effective.logs) ? effective.logs.length : 0,
					},
				});

				return {
					content: [{ type: "text", text: content }],
					details: {
						mode: params.mode,
						endpoint,
						durationMs,
						runId: effective.runId,
						status: backendStatus,
						extractedMethods,
						truncated: truncation.truncated,
						fullOutputPath,
						response: effective,
					},
				};
			} catch (error) {
				await recordAuditEntry(ctx, recentActivity, {
					timestamp: new Date().toISOString(),
					kind: "execute",
					phase: "error",
					summary: `execute ${params.mode} failed ${extractedMethods.join(", ") || "(no codemode methods found)"}`,
					cwd: ctx.cwd,
					sessionFile,
					toolName: TOOL_NAME,
					toolCallId,
					isError: true,
					data: {
						mode: params.mode,
						endpoint,
						timeoutMs,
						extractedMethods,
						codePreview: truncateForAudit(params.code, 220),
						error: error instanceof Error ? error.message : String(error),
					},
				});
				throw error;
			}
		},
	});
}
