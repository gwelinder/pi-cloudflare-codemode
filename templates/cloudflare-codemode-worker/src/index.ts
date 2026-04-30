/**
 * Cloudflare Codemode Worker — thin executor (no LLM).
 *
 * Pi writes the orchestration code. This Worker just:
 *   GET  /health        → health check
 *   GET  /schema        → returns TypeScript type definitions plus structured search metadata for all codemode.* methods
 *   POST /execute       → runs Pi-authored code in an isolated sandbox with real CF API tools
 */

import { DynamicWorkerExecutor, generateTypesFromJsonSchema, sanitizeToolName } from "@cloudflare/codemode";
import Cloudflare from "cloudflare";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

interface Env {
	LOADER: unknown;
	CODEMODE_SHARED_TOKEN: string;
	CLOUDFLARE_API_TOKEN?: string;
	CF_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CF_ACCOUNT_ID?: string;
	CLOUDFLARE_API_TIMEOUT_MS?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function readBearer(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (!header) return undefined;
	const [scheme, token] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer") return undefined;
	return token?.trim();
}

function assertAuthorized(request: Request, env: Env): Response | undefined {
	if (!env.CODEMODE_SHARED_TOKEN) {
		return json({ error: "Server misconfigured: missing CODEMODE_SHARED_TOKEN" }, 500);
	}
	const token = readBearer(request);
	if (!token || token !== env.CODEMODE_SHARED_TOKEN) {
		return json({ error: "Unauthorized" }, 401);
	}
	return undefined;
}

function toErrorMessage(error: unknown): string {
	if (!error) return "Unknown error";
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	const maybe = error as { error?: { message?: string }; message?: string };
	if (maybe.error?.message) return maybe.error.message;
	if (maybe.message) return maybe.message;
	return JSON.stringify(error);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

async function collectAsync<T>(iterable: AsyncIterable<T>, maxItems: number): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) {
		items.push(item);
		if (items.length >= maxItems) break;
	}
	return items;
}

function isMutatingSql(sql: string): boolean {
	return /\b(insert|update|delete|replace|create|drop|alter|truncate|vacuum|reindex|grant|revoke|attach|detach)\b/i.test(
		sql.trim(),
	);
}

const emailAddressObjectSchema = {
	type: "object",
	properties: {
		address: { type: "string", description: "Email address." },
		name: { type: "string", description: "Optional display name." },
	},
	required: ["address"],
} as const;

const emailAddressUnionSchema = {
	anyOf: [
		{ type: "string", description: "Email address as a plain string." },
		emailAddressObjectSchema,
	],
} as const;

const emailAddressListUnionSchema = {
	anyOf: [
		{ type: "string", description: "Single email address." },
		{ type: "array", items: { type: "string" }, description: "Multiple email addresses." },
	],
} as const;

const emailAttachmentSchema = {
	anyOf: [
		{
			type: "object",
			properties: {
				content: { type: "string", description: "Base64-encoded attachment content." },
				content_id: { type: "string", description: "CID used by inline attachments." },
				disposition: { type: "string", enum: ["inline"] },
				filename: { type: "string" },
				type: { type: "string", description: "MIME type." },
			},
			required: ["content", "content_id", "disposition", "filename", "type"],
		},
		{
			type: "object",
			properties: {
				content: { type: "string", description: "Base64-encoded attachment content." },
				disposition: { type: "string", enum: ["attachment"] },
				filename: { type: "string" },
				type: { type: "string", description: "MIME type." },
			},
			required: ["content", "disposition", "filename", "type"],
		},
	],
} as const;

function unwrapCfResult(body: unknown): any {
	if (body && typeof body === "object" && "result" in (body as Record<string, unknown>)) {
		return (body as Record<string, any>).result;
	}
	return body as any;
}

function pickDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAccessCoverageUrl(raw: string): { original: string; host: string; path: string; href: string } {
	let candidate = raw.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
	const url = new URL(candidate);
	return {
		original: raw,
		host: url.hostname.toLowerCase(),
		path: url.pathname || "/",
		href: url.toString(),
	};
}

function splitAccessPattern(raw: string): { pattern: string; hostPattern: string; pathPattern?: string } {
	const withoutScheme = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const withoutQuery = withoutScheme.split(/[?#]/, 1)[0];
	const slashIndex = withoutQuery.indexOf("/");
	const hostPattern = (slashIndex === -1 ? withoutQuery : withoutQuery.slice(0, slashIndex)).replace(/:\d+$/, "").toLowerCase();
	const pathPattern = slashIndex === -1 ? undefined : withoutQuery.slice(slashIndex) || "/";
	return { pattern: raw, hostPattern, pathPattern };
}

function hostPatternMatches(patternHost: string, host: string): boolean {
	const patternSegments = patternHost.toLowerCase().split(".");
	const hostSegments = host.toLowerCase().split(".");
	if (patternSegments.length !== hostSegments.length) return false;
	for (let i = 0; i < patternSegments.length; i++) {
		const regex = new RegExp(`^${escapeRegex(patternSegments[i]).replace(/\\\*/g, "[^.]*")}$`, "i");
		if (!regex.test(hostSegments[i])) return false;
	}
	return true;
}

function pathPatternMatches(patternPath: string | undefined, path: string): boolean {
	if (!patternPath) return true;
	const candidatePath = path || "/";
	const normalizedPattern = patternPath.split(/[?#]/, 1)[0];
	if (!normalizedPattern.includes("*")) {
		if (normalizedPattern === "/" || normalizedPattern === "") return true;
		const base = normalizedPattern.length > 1 && normalizedPattern.endsWith("/") ? normalizedPattern.slice(0, -1) : normalizedPattern;
		return candidatePath === base || candidatePath.startsWith(`${base}/`);
	}
	const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*/g, ".*")}$`);
	return regex.test(candidatePath);
}

function accessPatternMatches(pattern: string, url: { host: string; path: string }): boolean {
	const { hostPattern, pathPattern } = splitAccessPattern(pattern);
	if (!hostPattern) return false;
	return hostPatternMatches(hostPattern, url.host) && pathPatternMatches(pathPattern, url.path);
}

function computeAccessPatternSpecificity(pattern: string): {
	hostLabels: number;
	hostLiteralChars: number;
	pathDepth: number;
	pathLiteralChars: number;
	wildcardCount: number;
	totalLength: number;
} {
	const { hostPattern, pathPattern } = splitAccessPattern(pattern);
	return {
		hostLabels: hostPattern ? hostPattern.split(".").length : 0,
		hostLiteralChars: hostPattern.replace(/\*/g, "").length,
		pathDepth: pathPattern ? pathPattern.split("/").filter(Boolean).length : 0,
		pathLiteralChars: (pathPattern ?? "").replace(/\*/g, "").length,
		wildcardCount: (pattern.match(/\*/g) ?? []).length,
		totalLength: pattern.length,
	};
}

function compareAccessPatternsBySpecificity(leftPattern: string, rightPattern: string): number {
	const left = computeAccessPatternSpecificity(leftPattern);
	const right = computeAccessPatternSpecificity(rightPattern);
	if (left.wildcardCount !== right.wildcardCount) return left.wildcardCount - right.wildcardCount;
	if (left.hostLabels !== right.hostLabels) return right.hostLabels - left.hostLabels;
	if (left.hostLiteralChars !== right.hostLiteralChars) return right.hostLiteralChars - left.hostLiteralChars;
	if (left.pathDepth !== right.pathDepth) return right.pathDepth - left.pathDepth;
	if (left.pathLiteralChars !== right.pathLiteralChars) return right.pathLiteralChars - left.pathLiteralChars;
	return right.totalLength - left.totalLength;
}

function extractAccessApplicationPatterns(application: any): string[] {
	const patterns = new Set<string>();
	if (typeof application?.domain === "string" && application.domain.trim()) patterns.add(application.domain.trim());
	if (Array.isArray(application?.self_hosted_domains)) {
		for (const domain of application.self_hosted_domains) {
			if (typeof domain === "string" && domain.trim()) patterns.add(domain.trim());
		}
	}
	if (Array.isArray(application?.destinations)) {
		for (const destination of application.destinations) {
			if (destination?.type === "public" && typeof destination?.uri === "string" && destination.uri.trim()) {
				patterns.add(destination.uri.trim());
			}
		}
	}
	return Array.from(patterns);
}

function summarizeAccessPolicy(policy: any): Record<string, unknown> {
	return pickDefined({
		id: policy?.id ?? policy?.uid,
		name: policy?.name,
		decision: policy?.decision,
		precedence: policy?.precedence,
		includeCount: Array.isArray(policy?.include) ? policy.include.length : undefined,
		excludeCount: Array.isArray(policy?.exclude) ? policy.exclude.length : undefined,
		requireCount: Array.isArray(policy?.require) ? policy.require.length : undefined,
	});
}

function summarizeAccessApplication(application: any): Record<string, unknown> {
	return pickDefined({
		id: application?.id ?? application?.uid,
		name: application?.name,
		type: application?.type,
		aud: application?.aud,
		domain: application?.domain,
		patterns: extractAccessApplicationPatterns(application),
		sessionDuration: application?.session_duration,
		allowedIdps: application?.allowed_idps,
		autoRedirectToIdentity: application?.auto_redirect_to_identity,
		appLauncherVisible: application?.app_launcher_visible,
		tags: application?.tags,
		policyCount: Array.isArray(application?.policies) ? application.policies.length : undefined,
	});
}

function summarizeAccessGroup(group: any): Record<string, unknown> {
	return pickDefined({
		id: group?.id ?? group?.uid,
		name: group?.name,
		includeCount: Array.isArray(group?.include) ? group.include.length : undefined,
		excludeCount: Array.isArray(group?.exclude) ? group.exclude.length : undefined,
		requireCount: Array.isArray(group?.require) ? group.require.length : undefined,
	});
}

function summarizeIdentityProvider(identityProvider: any): Record<string, unknown> {
	return pickDefined({
		id: identityProvider?.id ?? identityProvider?.uid,
		name: identityProvider?.name,
		type: identityProvider?.type,
		scimEnabled: identityProvider?.scim_config?.enabled,
	});
}

function getZeroTrustAccessSettingsView(organization: any): Record<string, unknown> {
	return pickDefined({
		allowAuthenticateViaWarp: organization?.allow_authenticate_via_warp,
		autoRedirectToIdentity: organization?.auto_redirect_to_identity,
		denyUnmatchedRequests: organization?.deny_unmatched_requests,
		denyUnmatchedRequestsExemptedZoneNames: organization?.deny_unmatched_requests_exempted_zone_names,
		isUiReadOnly: organization?.is_ui_read_only,
		loginDesign: organization?.login_design,
		mfaConfig: organization?.mfa_config,
		mfaRequiredForAllApps: organization?.mfa_required_for_all_apps,
		mfaSshPivKeyRequirements: organization?.mfa_ssh_piv_key_requirements,
		sessionDuration: organization?.session_duration,
		warpAuthSessionDuration: organization?.warp_auth_session_duration,
	});
}

// ---------------------------------------------------------------------------
// Cloudflare API runtime
// ---------------------------------------------------------------------------

class CloudflareRuntime {
	readonly client: Cloudflare;
	private readonly apiToken: string;
	private cachedAccountId?: string;

	constructor(env: Env) {
		const apiToken = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
		if (!apiToken) {
			throw new Error("Missing CLOUDFLARE_API_TOKEN (or CF_API_TOKEN)");
		}
		const timeoutRaw = Number(env.CLOUDFLARE_API_TIMEOUT_MS ?? "60000");
		const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 60_000;

		this.apiToken = apiToken;
		this.cachedAccountId = env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID;
		this.client = new Cloudflare({ apiToken, timeout, maxRetries: 2 });
	}

	async resolveAccountId(explicitAccountId?: string): Promise<string> {
		if (explicitAccountId?.trim()) return explicitAccountId.trim();
		if (this.cachedAccountId?.trim()) return this.cachedAccountId.trim();
		const accounts = await collectAsync(
			this.client.accounts.list() as unknown as AsyncIterable<any>,
			1,
		);
		if (!accounts[0]?.id) {
			throw new Error("Unable to resolve Cloudflare account ID. Set CLOUDFLARE_ACCOUNT_ID.");
		}
		this.cachedAccountId = accounts[0].id;
		return accounts[0].id;
	}

	async rawApiRequest(args: {
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		path: string;
		query?: Record<string, unknown>;
		body?: unknown;
	}): Promise<{ status: number; ok: boolean; body: unknown }> {
		let path = args.path.trim();
		if (!path.startsWith("/")) throw new Error("Path must start with '/'.");
		if (path.startsWith("/client/v4/")) path = path.slice("/client/v4".length);

		const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
		for (const [key, value] of Object.entries(args.query ?? {})) {
			if (value == null) continue;
			if (Array.isArray(value)) {
				for (const v of value) url.searchParams.append(key, String(v));
			} else {
				url.searchParams.set(key, String(value));
			}
		}

		const response = await fetch(url.toString(), {
			method: args.method,
			headers: { Authorization: `Bearer ${this.apiToken}`, "content-type": "application/json" },
			body: args.body === undefined ? undefined : JSON.stringify(args.body),
		});

		const text = await response.text();
		let parsed: unknown = text;
		try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }

		if (!response.ok) {
			const preview = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
			throw new Error(`CF API ${args.method} ${path} failed (${response.status}): ${preview}`);
		}
		return { status: response.status, ok: response.ok, body: parsed };
	}
}

async function resolveZeroTrustScope(
	runtime: CloudflareRuntime,
	args: { accountId?: string; zoneId?: string } | undefined,
): Promise<{ params: { account_id?: string; zone_id?: string }; output: { accountId?: string; zoneId?: string } }> {
	const accountId = args?.accountId?.trim();
	const zoneId = args?.zoneId?.trim();
	if (accountId && zoneId) throw new Error("Pass either accountId or zoneId, not both.");
	if (zoneId) return { params: { zone_id: zoneId }, output: { zoneId } };
	const resolvedAccountId = await runtime.resolveAccountId(accountId);
	return { params: { account_id: resolvedAccountId }, output: { accountId: resolvedAccountId } };
}

function buildZeroTrustOrganizationPayload(args: any): Record<string, unknown> {
	return {
		...(args?.organization ?? {}),
		...pickDefined({
			name: args?.name,
			auth_domain: args?.authDomain,
			allow_authenticate_via_warp: args?.allowAuthenticateViaWarp,
			auto_redirect_to_identity: args?.autoRedirectToIdentity,
			deny_unmatched_requests: args?.denyUnmatchedRequests,
			deny_unmatched_requests_exempted_zone_names: args?.denyUnmatchedRequestsExemptedZoneNames,
			is_ui_read_only: args?.isUiReadOnly,
			login_design: args?.loginDesign,
			mfa_config: args?.mfaConfig,
			mfa_required_for_all_apps: args?.mfaRequiredForAllApps,
			mfa_ssh_piv_key_requirements: args?.mfaSshPivKeyRequirements,
			session_duration: args?.sessionDuration,
			warp_auth_session_duration: args?.warpAuthSessionDuration,
		}),
	};
}

function buildZeroTrustAccessSettingsPayload(args: any): Record<string, unknown> {
	return {
		...(args?.settings ?? {}),
		...pickDefined({
			allow_authenticate_via_warp: args?.allowAuthenticateViaWarp,
			auto_redirect_to_identity: args?.autoRedirectToIdentity,
			deny_unmatched_requests: args?.denyUnmatchedRequests,
			deny_unmatched_requests_exempted_zone_names: args?.denyUnmatchedRequestsExemptedZoneNames,
			is_ui_read_only: args?.isUiReadOnly,
			login_design: args?.loginDesign,
			mfa_config: args?.mfaConfig,
			mfa_required_for_all_apps: args?.mfaRequiredForAllApps,
			mfa_ssh_piv_key_requirements: args?.mfaSshPivKeyRequirements,
			session_duration: args?.sessionDuration,
			warp_auth_session_duration: args?.warpAuthSessionDuration,
		}),
	};
}

function buildAccessApplicationPayload(args: any): Record<string, unknown> {
	return {
		...(args?.application ?? {}),
		...pickDefined({
			name: args?.name,
			type: args?.type,
			domain: args?.domain,
			self_hosted_domains: args?.selfHostedDomains,
			destinations: args?.destinations,
			session_duration: args?.sessionDuration,
			allowed_idps: args?.allowedIdps,
			auto_redirect_to_identity: args?.autoRedirectToIdentity,
			policies: args?.policies,
			tags: args?.tags,
			app_launcher_visible: args?.appLauncherVisible,
			skip_interstitial: args?.skipInterstitial,
			read_service_tokens_from_header: args?.readServiceTokensFromHeader,
			service_auth_401_redirect: args?.serviceAuth401Redirect,
			path_cookie_attribute: args?.pathCookieAttribute,
			enable_binding_cookie: args?.enableBindingCookie,
			http_only_cookie_attribute: args?.httpOnlyCookieAttribute,
			same_site_cookie_attribute: args?.sameSiteCookieAttribute,
			logo_url: args?.logoUrl,
			custom_pages: args?.customPages,
			custom_deny_message: args?.customDenyMessage,
			custom_deny_url: args?.customDenyUrl,
			custom_non_identity_deny_url: args?.customNonIdentityDenyUrl,
			allow_authenticate_via_warp: args?.allowAuthenticateViaWarp,
			options_preflight_bypass: args?.optionsPreflightBypass,
			cors_headers: args?.corsHeaders,
			scim_config: args?.scimConfig,
		}),
	};
}

function buildAccessPolicyPayload(args: any): Record<string, unknown> {
	return {
		...(args?.policy ?? {}),
		...pickDefined({
			name: args?.name,
			decision: args?.decision,
			include: args?.include,
			exclude: args?.exclude,
			require: args?.require,
			precedence: args?.precedence,
			session_duration: args?.sessionDuration,
			approval_groups: args?.approvalGroups,
			approval_required: args?.approvalRequired,
			connection_rules: args?.connectionRules,
			isolation_required: args?.isolationRequired,
			mfa_config: args?.mfaConfig,
			purpose_justification_prompt: args?.purposeJustificationPrompt,
			purpose_justification_required: args?.purposeJustificationRequired,
		}),
	};
}

function buildAccessGroupPayload(args: any): Record<string, unknown> {
	return {
		...(args?.group ?? {}),
		...pickDefined({
			name: args?.name,
			include: args?.include,
			exclude: args?.exclude,
			require: args?.require,
		}),
	};
}

function buildAccessIdentityProviderPayload(args: any): Record<string, unknown> {
	return {
		...(args?.identityProvider ?? {}),
		...pickDefined({
			name: args?.name,
			type: args?.type,
			config: args?.config,
			scim_config: args?.scimConfig,
		}),
	};
}

// ---------------------------------------------------------------------------
// Tool descriptors (JSON Schema form for generateTypesFromJsonSchema)
// ---------------------------------------------------------------------------

interface ToolDescriptor {
	description: string;
	inputSchema: Record<string, unknown>;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface SchemaMethodDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	required: string[];
	mutating: boolean;
	product: string;
	aliases: string[];
	keywords: string[];
}

function buildTools(runtime: CloudflareRuntime, mode: string): Record<string, ToolDescriptor> {
	const requireApply = (op: string) => {
		if (mode !== "apply") throw new Error(`${op} requires mode=apply.`);
	};

	return {
		cf_accounts_list: {
			description: "List Cloudflare accounts accessible by the API token.",
			inputSchema: {
				type: "object",
				properties: { maxItems: { type: "number", description: "Max accounts to return (default 25)." } },
			},
			execute: async (args: any) => {
				const items = await collectAsync(
					runtime.client.accounts.list() as unknown as AsyncIterable<any>,
					args?.maxItems ?? 25,
				);
				return { accounts: items.map((a: any) => ({ id: a.id, name: a.name, type: a.type })), count: items.length };
			},
		},

		// ----- Zero Trust / Access -----

		cf_zero_trust_organization_create: {
			description: "Create a Zero Trust organization/team. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					name: { type: "string", description: "Zero Trust team name." },
					authDomain: { type: "string", description: "Team auth domain, for example team.cloudflareaccess.com." },
					allowAuthenticateViaWarp: { type: "boolean" },
					autoRedirectToIdentity: { type: "boolean" },
					denyUnmatchedRequests: { type: "boolean" },
					denyUnmatchedRequestsExemptedZoneNames: { type: "array", items: { type: "string" } },
					isUiReadOnly: { type: "boolean" },
					loginDesign: { type: "object", description: "Login page branding fields such as logo_path, header_text, footer_text, background_color, text_color." },
					mfaConfig: { type: "object", description: "MFA/session config object." },
					mfaRequiredForAllApps: { type: "boolean" },
					mfaSshPivKeyRequirements: { type: "object" },
					sessionDuration: { type: "string", description: "Global Access session duration, for example 24h." },
					warpAuthSessionDuration: { type: "string", description: "WARP auth session duration, for example 24h." },
					organization: { type: "object", description: "Raw Cloudflare organization payload. Top-level convenience fields override matching keys." },
				},
				required: ["name", "authDomain"],
			},
			execute: async (args: any) => {
				requireApply("cf_zero_trust_organization_create");
				const scope = await resolveZeroTrustScope(runtime, args);
				const organization = await runtime.client.zeroTrust.organizations.create({
					...scope.params,
					...buildZeroTrustOrganizationPayload(args),
				} as any);
				return { ...scope.output, organization, accessSettings: getZeroTrustAccessSettingsView(organization) };
			},
		},

		cf_zero_trust_organization_get: {
			description: "Get the current Zero Trust organization/team configuration.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
				},
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const organization = await runtime.client.zeroTrust.organizations.list(scope.params);
				return { ...scope.output, organization, accessSettings: getZeroTrustAccessSettingsView(organization) };
			},
		},

		cf_zero_trust_organization_update: {
			description: "Update the Zero Trust organization/team configuration. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					name: { type: "string", description: "Zero Trust team name." },
					authDomain: { type: "string", description: "Team auth domain, for example team.cloudflareaccess.com." },
					allowAuthenticateViaWarp: { type: "boolean" },
					autoRedirectToIdentity: { type: "boolean" },
					denyUnmatchedRequests: { type: "boolean" },
					denyUnmatchedRequestsExemptedZoneNames: { type: "array", items: { type: "string" } },
					isUiReadOnly: { type: "boolean" },
					loginDesign: { type: "object", description: "Login page branding fields such as logo_path, header_text, footer_text, background_color, text_color." },
					mfaConfig: { type: "object", description: "MFA/session config object." },
					mfaRequiredForAllApps: { type: "boolean" },
					mfaSshPivKeyRequirements: { type: "object" },
					sessionDuration: { type: "string", description: "Global Access session duration, for example 24h." },
					warpAuthSessionDuration: { type: "string", description: "WARP auth session duration, for example 24h." },
					organization: { type: "object", description: "Raw Cloudflare organization payload. Top-level convenience fields override matching keys." },
				},
			},
			execute: async (args: any) => {
				requireApply("cf_zero_trust_organization_update");
				const scope = await resolveZeroTrustScope(runtime, args);
				const organization = await runtime.client.zeroTrust.organizations.update({
					...scope.params,
					...buildZeroTrustOrganizationPayload(args),
				} as any);
				return { ...scope.output, organization, accessSettings: getZeroTrustAccessSettingsView(organization) };
			},
		},

		cf_access_settings_get: {
			description: "Get global Access settings derived from the Zero Trust organization config.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
				},
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const organization = await runtime.client.zeroTrust.organizations.list(scope.params);
				return { ...scope.output, settings: getZeroTrustAccessSettingsView(organization), organization };
			},
		},

		cf_access_settings_update: {
			description: "Update global Access settings derived from the Zero Trust organization config. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					allowAuthenticateViaWarp: { type: "boolean" },
					autoRedirectToIdentity: { type: "boolean" },
					denyUnmatchedRequests: { type: "boolean" },
					denyUnmatchedRequestsExemptedZoneNames: { type: "array", items: { type: "string" } },
					isUiReadOnly: { type: "boolean" },
					loginDesign: { type: "object", description: "Login page branding fields such as logo_path, header_text, footer_text, background_color, text_color." },
					mfaConfig: { type: "object", description: "MFA/session config object." },
					mfaRequiredForAllApps: { type: "boolean" },
					mfaSshPivKeyRequirements: { type: "object" },
					sessionDuration: { type: "string", description: "Global Access session duration, for example 24h." },
					warpAuthSessionDuration: { type: "string", description: "WARP auth session duration, for example 24h." },
					settings: { type: "object", description: "Raw Access settings patch mapped onto the organization endpoint. Top-level convenience fields override matching keys." },
				},
			},
			execute: async (args: any) => {
				requireApply("cf_access_settings_update");
				const scope = await resolveZeroTrustScope(runtime, args);
				const organization = await runtime.client.zeroTrust.organizations.update({
					...scope.params,
					...buildZeroTrustAccessSettingsPayload(args),
				} as any);
				return { ...scope.output, settings: getZeroTrustAccessSettingsView(organization), organization };
			},
		},

		cf_access_applications_list: {
			description: "List Access applications for an account or zone.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					aud: { type: "string" },
					domain: { type: "string" },
					exact: { type: "boolean", description: "Exact-match name/domain filters." },
					name: { type: "string" },
					search: { type: "string" },
					targetAttributes: { type: "string", description: "Target criteria in key=value format." },
					maxItems: { type: "number" },
				},
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const applications = await collectAsync(
					runtime.client.zeroTrust.access.applications.list({
						...scope.params,
						...pickDefined({
							aud: args?.aud,
							domain: args?.domain,
							exact: args?.exact,
							name: args?.name,
							search: args?.search,
							target_attributes: args?.targetAttributes,
						}),
					}) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { ...scope.output, count: applications.length, applications, summaries: applications.map(summarizeAccessApplication) };
			},
		},

		cf_access_application_get: {
			description: "Get an Access application by ID.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
				},
				required: ["appId"],
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const application = await runtime.client.zeroTrust.access.applications.get(args.appId, scope.params);
				return { ...scope.output, appId: args.appId, application, summary: summarizeAccessApplication(application) };
			},
		},

		cf_access_application_create: {
			description: "Create an Access application. Supports self-hosted apps via convenience fields or a raw application object. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					name: { type: "string" },
					type: { type: "string", enum: ["self_hosted", "saas", "ssh", "vnc", "app_launcher", "warp", "biso", "bookmark", "dash_sso", "infrastructure", "rdp", "mcp", "mcp_portal", "proxy_endpoint"] },
					domain: { type: "string", description: "Primary Access application hostname/path, for example example.com/admin or example.com/admin/*." },
					selfHostedDomains: { type: "array", items: { type: "string" }, description: "Additional public domains/paths to secure." },
					destinations: { type: "array", items: { type: "object" }, description: "Raw Access destinations array. Public destinations can use uri with host/path wildcards." },
					sessionDuration: { type: "string" },
					allowedIdps: { type: "array", items: { type: "string" } },
					autoRedirectToIdentity: { type: "boolean" },
					policies: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] }, description: "Reusable policy IDs or inline policy objects." },
					tags: { type: "array", items: { type: "string" } },
					appLauncherVisible: { type: "boolean" },
					skipInterstitial: { type: "boolean" },
					readServiceTokensFromHeader: { type: "string" },
					serviceAuth401Redirect: { type: "boolean" },
					pathCookieAttribute: { type: "boolean" },
					enableBindingCookie: { type: "boolean" },
					httpOnlyCookieAttribute: { type: "boolean" },
					sameSiteCookieAttribute: { type: "string" },
					logoUrl: { type: "string" },
					customPages: { type: "array", items: { type: "string" } },
					customDenyMessage: { type: "string" },
					customDenyUrl: { type: "string" },
					customNonIdentityDenyUrl: { type: "string" },
					allowAuthenticateViaWarp: { type: "boolean" },
					optionsPreflightBypass: { type: "boolean" },
					corsHeaders: { type: "object" },
					scimConfig: { type: "object" },
					application: { type: "object", description: "Raw Cloudflare Access application payload. Top-level convenience fields override matching keys." },
				},
			},
			execute: async (args: any) => {
				requireApply("cf_access_application_create");
				const scope = await resolveZeroTrustScope(runtime, args);
				const application = await runtime.client.zeroTrust.access.applications.create({
					...scope.params,
					...buildAccessApplicationPayload(args),
				} as any);
				return { ...scope.output, application, summary: summarizeAccessApplication(application) };
			},
		},

		cf_access_application_update: {
			description: "Update an Access application. Supports self-hosted apps via convenience fields or a raw application object. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
					name: { type: "string" },
					type: { type: "string", enum: ["self_hosted", "saas", "ssh", "vnc", "app_launcher", "warp", "biso", "bookmark", "dash_sso", "infrastructure", "rdp", "mcp", "mcp_portal", "proxy_endpoint"] },
					domain: { type: "string", description: "Primary Access application hostname/path, for example example.com/admin or example.com/admin/*." },
					selfHostedDomains: { type: "array", items: { type: "string" }, description: "Additional public domains/paths to secure." },
					destinations: { type: "array", items: { type: "object" }, description: "Raw Access destinations array. Public destinations can use uri with host/path wildcards." },
					sessionDuration: { type: "string" },
					allowedIdps: { type: "array", items: { type: "string" } },
					autoRedirectToIdentity: { type: "boolean" },
					policies: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] }, description: "Reusable policy IDs or inline policy objects." },
					tags: { type: "array", items: { type: "string" } },
					appLauncherVisible: { type: "boolean" },
					skipInterstitial: { type: "boolean" },
					readServiceTokensFromHeader: { type: "string" },
					serviceAuth401Redirect: { type: "boolean" },
					pathCookieAttribute: { type: "boolean" },
					enableBindingCookie: { type: "boolean" },
					httpOnlyCookieAttribute: { type: "boolean" },
					sameSiteCookieAttribute: { type: "string" },
					logoUrl: { type: "string" },
					customPages: { type: "array", items: { type: "string" } },
					customDenyMessage: { type: "string" },
					customDenyUrl: { type: "string" },
					customNonIdentityDenyUrl: { type: "string" },
					allowAuthenticateViaWarp: { type: "boolean" },
					optionsPreflightBypass: { type: "boolean" },
					corsHeaders: { type: "object" },
					scimConfig: { type: "object" },
					application: { type: "object", description: "Raw Cloudflare Access application payload. Top-level convenience fields override matching keys." },
				},
				required: ["appId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_application_update");
				const scope = await resolveZeroTrustScope(runtime, args);
				const application = await runtime.client.zeroTrust.access.applications.update(args.appId, {
					...scope.params,
					...buildAccessApplicationPayload(args),
				} as any);
				return { ...scope.output, appId: args.appId, application, summary: summarizeAccessApplication(application) };
			},
		},

		cf_access_application_delete: {
			description: "Delete an Access application. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
				},
				required: ["appId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_application_delete");
				const scope = await resolveZeroTrustScope(runtime, args);
				const result = await runtime.client.zeroTrust.access.applications.delete(args.appId, scope.params);
				return { ...scope.output, appId: args.appId, deleted: true, result };
			},
		},

		cf_access_policies_list: {
			description: "List Access policies attached to a specific application.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
					maxItems: { type: "number" },
				},
				required: ["appId"],
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const policies = await collectAsync(
					runtime.client.zeroTrust.access.applications.policies.list(args.appId, scope.params) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { ...scope.output, appId: args.appId, count: policies.length, policies, summaries: policies.map(summarizeAccessPolicy) };
			},
		},

		cf_access_policy_get: {
			description: "Get an Access policy attached to a specific application.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
					policyId: { type: "string" },
				},
				required: ["appId", "policyId"],
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const policy = await runtime.client.zeroTrust.access.applications.policies.get(args.appId, args.policyId, scope.params);
				return { ...scope.output, appId: args.appId, policyId: args.policyId, policy, summary: summarizeAccessPolicy(policy) };
			},
		},

		cf_access_policy_create: {
			description: "Create an Access policy on a specific application. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
					name: { type: "string" },
					decision: { type: "string", enum: ["allow", "deny", "non_identity", "bypass"] },
					include: { type: "array", items: { type: "object" }, description: "Include rule objects, for example email, email_domain, group, or service_token selectors." },
					exclude: { type: "array", items: { type: "object" }, description: "Exclude rule objects." },
					require: { type: "array", items: { type: "object" }, description: "Require rule objects." },
					precedence: { type: "number" },
					sessionDuration: { type: "string" },
					approvalGroups: { type: "array", items: { type: "object" } },
					approvalRequired: { type: "boolean" },
					connectionRules: { type: "object" },
					isolationRequired: { type: "boolean" },
					mfaConfig: { type: "object" },
					purposeJustificationPrompt: { type: "string" },
					purposeJustificationRequired: { type: "boolean" },
					policy: { type: "object", description: "Raw Access policy payload. Top-level convenience fields override matching keys." },
				},
				required: ["appId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_policy_create");
				const scope = await resolveZeroTrustScope(runtime, args);
				const policy = await runtime.client.zeroTrust.access.applications.policies.create(args.appId, {
					...scope.params,
					...buildAccessPolicyPayload(args),
				} as any);
				return { ...scope.output, appId: args.appId, policy, summary: summarizeAccessPolicy(policy) };
			},
		},

		cf_access_policy_update: {
			description: "Update an Access policy on a specific application. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
					policyId: { type: "string" },
					name: { type: "string" },
					decision: { type: "string", enum: ["allow", "deny", "non_identity", "bypass"] },
					include: { type: "array", items: { type: "object" }, description: "Include rule objects, for example email, email_domain, group, or service_token selectors." },
					exclude: { type: "array", items: { type: "object" }, description: "Exclude rule objects." },
					require: { type: "array", items: { type: "object" }, description: "Require rule objects." },
					precedence: { type: "number" },
					sessionDuration: { type: "string" },
					approvalGroups: { type: "array", items: { type: "object" } },
					approvalRequired: { type: "boolean" },
					connectionRules: { type: "object" },
					isolationRequired: { type: "boolean" },
					mfaConfig: { type: "object" },
					purposeJustificationPrompt: { type: "string" },
					purposeJustificationRequired: { type: "boolean" },
					policy: { type: "object", description: "Raw Access policy payload. Top-level convenience fields override matching keys." },
				},
				required: ["appId", "policyId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_policy_update");
				const scope = await resolveZeroTrustScope(runtime, args);
				const policy = await runtime.client.zeroTrust.access.applications.policies.update(args.appId, args.policyId, {
					...scope.params,
					...buildAccessPolicyPayload(args),
				} as any);
				return { ...scope.output, appId: args.appId, policyId: args.policyId, policy, summary: summarizeAccessPolicy(policy) };
			},
		},

		cf_access_policy_delete: {
			description: "Delete an Access policy from a specific application. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					appId: { type: "string" },
					policyId: { type: "string" },
				},
				required: ["appId", "policyId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_policy_delete");
				const scope = await resolveZeroTrustScope(runtime, args);
				const result = await runtime.client.zeroTrust.access.applications.policies.delete(args.appId, args.policyId, scope.params);
				return { ...scope.output, appId: args.appId, policyId: args.policyId, deleted: true, result };
			},
		},

		cf_access_identity_providers_list: {
			description: "List Access identity providers for an account or zone.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					maxItems: { type: "number" },
				},
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const identityProviders = await collectAsync(
					runtime.client.zeroTrust.identityProviders.list(scope.params) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { ...scope.output, count: identityProviders.length, identityProviders, summaries: identityProviders.map(summarizeIdentityProvider) };
			},
		},

		cf_access_identity_provider_get: {
			description: "Get an Access identity provider by ID.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					identityProviderId: { type: "string" },
				},
				required: ["identityProviderId"],
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const identityProvider = await runtime.client.zeroTrust.identityProviders.get(args.identityProviderId, scope.params);
				return { ...scope.output, identityProviderId: args.identityProviderId, identityProvider, summary: summarizeIdentityProvider(identityProvider) };
			},
		},

		cf_access_identity_provider_create: {
			description: "Create an Access identity provider. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					name: { type: "string" },
					type: { type: "string", description: "Identity provider type, for example onetimepin, google, github, saml, oidc, or azureAD." },
					config: { type: "object", description: "Raw identity-provider config payload." },
					scimConfig: { type: "object" },
					identityProvider: { type: "object", description: "Raw Cloudflare identity-provider payload. Top-level convenience fields override matching keys." },
				},
			},
			execute: async (args: any) => {
				requireApply("cf_access_identity_provider_create");
				const scope = await resolveZeroTrustScope(runtime, args);
				const identityProvider = await runtime.client.zeroTrust.identityProviders.create({
					...scope.params,
					...buildAccessIdentityProviderPayload(args),
				} as any);
				return { ...scope.output, identityProvider, summary: summarizeIdentityProvider(identityProvider) };
			},
		},

		cf_access_identity_provider_update: {
			description: "Update an Access identity provider. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					identityProviderId: { type: "string" },
					name: { type: "string" },
					type: { type: "string", description: "Identity provider type, for example onetimepin, google, github, saml, oidc, or azureAD." },
					config: { type: "object", description: "Raw identity-provider config payload." },
					scimConfig: { type: "object" },
					identityProvider: { type: "object", description: "Raw Cloudflare identity-provider payload. Top-level convenience fields override matching keys." },
				},
				required: ["identityProviderId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_identity_provider_update");
				const scope = await resolveZeroTrustScope(runtime, args);
				const identityProvider = await runtime.client.zeroTrust.identityProviders.update(args.identityProviderId, {
					...scope.params,
					...buildAccessIdentityProviderPayload(args),
				} as any);
				return { ...scope.output, identityProviderId: args.identityProviderId, identityProvider, summary: summarizeIdentityProvider(identityProvider) };
			},
		},

		cf_access_groups_list: {
			description: "List Access groups for an account or zone.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					maxItems: { type: "number" },
				},
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const groups = await collectAsync(
					runtime.client.zeroTrust.access.groups.list(scope.params) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { ...scope.output, count: groups.length, groups, summaries: groups.map(summarizeAccessGroup) };
			},
		},

		cf_access_group_get: {
			description: "Get an Access group by ID.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					groupId: { type: "string" },
				},
				required: ["groupId"],
			},
			execute: async (args: any) => {
				const scope = await resolveZeroTrustScope(runtime, args);
				const group = await runtime.client.zeroTrust.access.groups.get(args.groupId, scope.params);
				return { ...scope.output, groupId: args.groupId, group, summary: summarizeAccessGroup(group) };
			},
		},

		cf_access_group_create: {
			description: "Create an Access group. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					name: { type: "string" },
					include: { type: "array", items: { type: "object" }, description: "Include rule objects." },
					exclude: { type: "array", items: { type: "object" }, description: "Exclude rule objects." },
					require: { type: "array", items: { type: "object" }, description: "Require rule objects." },
					group: { type: "object", description: "Raw Access group payload. Top-level convenience fields override matching keys." },
				},
			},
			execute: async (args: any) => {
				requireApply("cf_access_group_create");
				const scope = await resolveZeroTrustScope(runtime, args);
				const group = await runtime.client.zeroTrust.access.groups.create({
					...scope.params,
					...buildAccessGroupPayload(args),
				} as any);
				return { ...scope.output, group, summary: summarizeAccessGroup(group) };
			},
		},

		cf_access_group_update: {
			description: "Update an Access group. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					groupId: { type: "string" },
					name: { type: "string" },
					include: { type: "array", items: { type: "object" }, description: "Include rule objects." },
					exclude: { type: "array", items: { type: "object" }, description: "Exclude rule objects." },
					require: { type: "array", items: { type: "object" }, description: "Require rule objects." },
					group: { type: "object", description: "Raw Access group payload. Top-level convenience fields override matching keys." },
				},
				required: ["groupId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_group_update");
				const scope = await resolveZeroTrustScope(runtime, args);
				const group = await runtime.client.zeroTrust.access.groups.update(args.groupId, {
					...scope.params,
					...buildAccessGroupPayload(args),
				} as any);
				return { ...scope.output, groupId: args.groupId, group, summary: summarizeAccessGroup(group) };
			},
		},

		cf_access_group_delete: {
			description: "Delete an Access group. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					groupId: { type: "string" },
				},
				required: ["groupId"],
			},
			execute: async (args: any) => {
				requireApply("cf_access_group_delete");
				const scope = await resolveZeroTrustScope(runtime, args);
				const result = await runtime.client.zeroTrust.access.groups.delete(args.groupId, scope.params);
				return { ...scope.output, groupId: args.groupId, deleted: true, result };
			},
		},

		cf_access_coverage_check: {
			description: "Check which Access application definitions cover specific URLs. This validates path/wildcard coverage only — it does not emulate browser login or evaluate user identity.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					urls: { type: "array", items: { type: "string" }, description: "URLs or host/path strings to evaluate." },
					applications: { type: "array", items: { type: "object" }, description: "Optional raw Access application objects. If omitted, live applications are fetched from Cloudflare." },
					maxItems: { type: "number", description: "When fetching live applications, max applications to inspect." },
				},
				required: ["urls"],
			},
			execute: async (args: any) => {
				const providedApplications = Array.isArray(args?.applications) ? args.applications : undefined;
				let applications = providedApplications ?? [];
				let source: "provided" | "live" = providedApplications ? "provided" : "live";
				let scopeOutput: Record<string, unknown> = {};
				if (!providedApplications) {
					const scope = await resolveZeroTrustScope(runtime, args);
					scopeOutput = scope.output;
					applications = await collectAsync(
						runtime.client.zeroTrust.access.applications.list(scope.params) as unknown as AsyncIterable<any>,
						args?.maxItems ?? 200,
					);
				}

				const results = (args?.urls ?? []).map((urlInput: string) => {
					const normalizedUrl = normalizeAccessCoverageUrl(urlInput);
					const matchedApps = applications
						.map((application: any) => {
							const matchedPatterns = extractAccessApplicationPatterns(application)
								.filter((pattern) => accessPatternMatches(pattern, normalizedUrl))
								.sort(compareAccessPatternsBySpecificity);
							if (!matchedPatterns.length) return null;
							return {
								...summarizeAccessApplication(application),
								bestPattern: matchedPatterns[0],
								matchedPatterns,
								policySummary: Array.isArray(application?.policies) ? application.policies.map(summarizeAccessPolicy) : [],
							};
						})
						.filter(Boolean) as Array<Record<string, unknown> & { bestPattern: string }>;

					matchedApps.sort((left, right) => compareAccessPatternsBySpecificity(left.bestPattern, right.bestPattern));
					const topMatch = matchedApps[0] ?? null;

					const barePathHolePatterns = applications.flatMap((application: any) =>
						extractAccessApplicationPatterns(application).filter((pattern) => {
							const { hostPattern, pathPattern } = splitAccessPattern(pattern);
							if (!hostPatternMatches(hostPattern, normalizedUrl.host)) return false;
							if (!pathPattern || !pathPattern.endsWith("/*")) return false;
							const parentPath = pathPattern.slice(0, -2) || "/";
							const candidateParent = normalizedUrl.path.length > 1 && normalizedUrl.path.endsWith("/")
								? normalizedUrl.path.slice(0, -1)
								: normalizedUrl.path;
							return parentPath === candidateParent;
						}),
					);

					return {
						url: urlInput,
						normalized: `${normalizedUrl.host}${normalizedUrl.path}`,
						protected: Boolean(topMatch),
						topMatch,
						matchedApps,
						potentialBarePathHolePatterns: !topMatch ? Array.from(new Set(barePathHolePatterns)) : [],
					};
				});

				const unprotectedUrls = results.filter((result: any) => !result.protected).map((result: any) => result.url);
				const warnings = Array.from(new Set(results.flatMap((result: any) =>
					result.potentialBarePathHolePatterns.map((pattern: string) =>
						`Potential bare-path hole: ${pattern} does not cover ${result.normalized}`,
					),
				)));
				if (unprotectedUrls.length > 0) warnings.unshift("Some URLs are not covered by any Access application definition.");

				return {
					...scopeOutput,
					source,
					applicationCount: applications.length,
					checkedUrlCount: results.length,
					results,
					unprotectedUrls,
					warnings,
				};
			},
		},

		cf_workers_list: {
			description: "List Workers scripts in an account.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					maxItems: { type: "number" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const scripts = await collectAsync(
					runtime.client.workers.scripts.list({ account_id: aid }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 100,
				);
				return { accountId: aid, count: scripts.length, scripts };
			},
		},

		cf_worker_get_content: {
			description: "Fetch Worker script source code.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, scriptName: { type: "string" } },
				required: ["scriptName"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const res = await runtime.client.workers.scripts.content.get(args.scriptName, { account_id: aid });
				return { accountId: aid, scriptName: args.scriptName, content: await res.text() };
			},
		},

		cf_worker_put_content: {
			description: "Upload Worker script content. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					scriptName: { type: "string" },
					script: { type: "string", description: "The JS/TS source code." },
					moduleType: { type: "string", enum: ["module", "service-worker"] },
				},
				required: ["scriptName", "script"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_put_content");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const moduleType = args.moduleType ?? "module";
				const fileName = moduleType === "module" ? "index.mjs" : "worker.js";
				const contentType = moduleType === "module" ? "application/javascript+module" : "application/javascript";
				const file = new File([args.script], fileName, { type: contentType });
				const metadata = moduleType === "module" ? { main_module: fileName } : { body_part: fileName };
				const uploaded = await runtime.client.workers.scripts.content.update(args.scriptName, {
					account_id: aid, metadata, files: [file],
				});
				return { accountId: aid, script: uploaded };
			},
		},

		cf_worker_delete: {
			description: "Delete a Worker script. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, scriptName: { type: "string" }, force: { type: "boolean" } },
				required: ["scriptName"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				await runtime.client.workers.scripts.delete(args.scriptName, { account_id: aid, force: args.force ?? false });
				return { accountId: aid, deleted: true, scriptName: args.scriptName };
			},
		},

		cf_worker_routes_list: {
			description: "List Worker routes for a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, maxItems: { type: "number" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const routes = await collectAsync(
					runtime.client.workers.routes.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { zoneId: args.zoneId, count: routes.length, routes };
			},
		},

		cf_worker_route_get: {
			description: "Get a specific Worker route by ID.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, routeId: { type: "string" } },
				required: ["zoneId", "routeId"],
			},
			execute: async (args: any) => {
				const route = await runtime.client.workers.routes.get(args.routeId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, routeId: args.routeId, route };
			},
		},

		cf_worker_route_create: {
			description: "Create a Worker route for a zone. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					pattern: { type: "string", description: "Route pattern like example.com/*" },
					script: { type: "string", description: "Worker script name to attach to the route." },
				},
				required: ["zoneId", "pattern"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_route_create");
				const route = await runtime.client.workers.routes.create({
					zone_id: args.zoneId,
					pattern: args.pattern,
					script: args.script,
				});
				return { zoneId: args.zoneId, route };
			},
		},

		cf_worker_route_update: {
			description: "Update a Worker route. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					routeId: { type: "string" },
					pattern: { type: "string", description: "Route pattern like example.com/*" },
					script: { type: "string", description: "Worker script name to attach to the route." },
				},
				required: ["zoneId", "routeId", "pattern"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_route_update");
				const route = await runtime.client.workers.routes.update(args.routeId, {
					zone_id: args.zoneId,
					pattern: args.pattern,
					script: args.script,
				});
				return { zoneId: args.zoneId, routeId: args.routeId, route };
			},
		},

		cf_worker_route_delete: {
			description: "Delete a Worker route. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, routeId: { type: "string" } },
				required: ["zoneId", "routeId"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_route_delete");
				const result = await runtime.client.workers.routes.delete(args.routeId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, routeId: args.routeId, deleted: true, result };
			},
		},

		cf_worker_domains_list: {
			description: "List Worker custom domains for an account.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					environment: { type: "string" },
					hostname: { type: "string" },
					service: { type: "string" },
					maxItems: { type: "number" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const domains = await collectAsync(
					runtime.client.workers.domains.list({
						account_id: aid,
						environment: args.environment,
						hostname: args.hostname,
						service: args.service,
					}) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { accountId: aid, count: domains.length, domains };
			},
		},

		cf_worker_domain_get: {
			description: "Get a Worker custom domain by ID.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, domainId: { type: "string" } },
				required: ["domainId"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const domain = await runtime.client.workers.domains.get(args.domainId, { account_id: aid });
				return { accountId: aid, domainId: args.domainId, domain };
			},
		},

		cf_worker_domain_update: {
			description: "Attach or update a Worker custom domain. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					zoneId: { type: "string" },
					hostname: { type: "string" },
					service: { type: "string" },
					environment: { type: "string", description: "Worker environment, for example production." },
				},
				required: ["zoneId", "hostname", "service", "environment"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_domain_update");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const domain = await runtime.client.workers.domains.update({
					account_id: aid,
					zone_id: args.zoneId,
					hostname: args.hostname,
					service: args.service,
					environment: args.environment,
				});
				return { accountId: aid, domain };
			},
		},

		cf_worker_domain_delete: {
			description: "Delete a Worker custom domain. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, domainId: { type: "string" } },
				required: ["domainId"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_domain_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				await runtime.client.workers.domains.delete(args.domainId, { account_id: aid });
				return { accountId: aid, domainId: args.domainId, deleted: true };
			},
		},

		cf_worker_account_subdomain_get: {
			description: "Get the account-level workers.dev subdomain.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const subdomain = await runtime.client.workers.subdomains.get({ account_id: aid });
				return { accountId: aid, subdomain };
			},
		},

		cf_worker_account_subdomain_update: {
			description: "Create or update the account-level workers.dev subdomain. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, subdomain: { type: "string" } },
				required: ["subdomain"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_account_subdomain_update");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const subdomain = await runtime.client.workers.subdomains.update({ account_id: aid, subdomain: args.subdomain });
				return { accountId: aid, subdomain };
			},
		},

		cf_worker_script_subdomain_get: {
			description: "Get workers.dev subdomain settings for a Worker script.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, scriptName: { type: "string" } },
				required: ["scriptName"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const subdomain = await runtime.client.workers.scripts.subdomain.get(args.scriptName, { account_id: aid });
				return { accountId: aid, scriptName: args.scriptName, subdomain };
			},
		},

		cf_worker_script_subdomain_update: {
			description: "Enable or configure a Worker script on workers.dev. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					scriptName: { type: "string" },
					enabled: { type: "boolean", description: "Enable or disable the workers.dev subdomain for the script." },
					previewsEnabled: { type: "boolean", description: "Enable preview URLs for the script." },
				},
				required: ["scriptName"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_script_subdomain_update");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const subdomain = await runtime.client.workers.scripts.subdomain.create(args.scriptName, {
					account_id: aid,
					enabled: args.enabled ?? true,
					previews_enabled: args.previewsEnabled,
				});
				return { accountId: aid, scriptName: args.scriptName, subdomain };
			},
		},

		cf_worker_script_subdomain_delete: {
			description: "Disable workers.dev subdomains for a Worker script. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, scriptName: { type: "string" } },
				required: ["scriptName"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_script_subdomain_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const subdomain = await runtime.client.workers.scripts.subdomain.delete(args.scriptName, { account_id: aid });
				return { accountId: aid, scriptName: args.scriptName, subdomain };
			},
		},

		cf_d1_list_databases: {
			description: "List D1 databases.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, name: { type: "string" }, maxItems: { type: "number" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const dbs = await collectAsync(
					runtime.client.d1.database.list({ account_id: aid, name: args?.name }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { accountId: aid, count: dbs.length, databases: dbs };
			},
		},

		cf_d1_create_database: {
			description: "Create a D1 database. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					name: { type: "string" },
					primaryLocationHint: { type: "string", enum: ["wnam", "enam", "weur", "eeur", "apac", "oc"] },
				},
				required: ["name"],
			},
			execute: async (args: any) => {
				requireApply("cf_d1_create_database");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const db = await runtime.client.d1.database.create({
					account_id: aid, name: args.name, primary_location_hint: args.primaryLocationHint,
				});
				return { accountId: aid, database: db };
			},
		},

		cf_d1_delete_database: {
			description: "Delete a D1 database by UUID. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, databaseId: { type: "string" } },
				required: ["databaseId"],
			},
			execute: async (args: any) => {
				requireApply("cf_d1_delete_database");
				const aid = await runtime.resolveAccountId(args?.accountId);
				await runtime.client.d1.database.delete(args.databaseId, { account_id: aid });
				return { accountId: aid, deleted: true, databaseId: args.databaseId };
			},
		},

		cf_d1_execute_sql: {
			description: "Execute SQL against a D1 database via Cloudflare API. Mutating SQL requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					databaseId: { type: "string" },
					sql: { type: "string" },
					params: { type: "array", items: {} },
				},
				required: ["databaseId", "sql"],
			},
			execute: async (args: any) => {
				if (isMutatingSql(args.sql)) requireApply("cf_d1_execute_sql (mutating SQL)");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const queryArgs: any = { account_id: aid, sql: args.sql };
				if (args.params) queryArgs.params = args.params;
				const results = await collectAsync(
					runtime.client.d1.database.query(args.databaseId, queryArgs) as unknown as AsyncIterable<any>,
					50,
				);
				return { accountId: aid, databaseId: args.databaseId, resultCount: results.length, results };
			},
		},

		cf_kv_namespace_list: {
			description: "List KV namespaces.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, maxItems: { type: "number" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const ns = await collectAsync(
					runtime.client.kv.namespaces.list({ account_id: aid }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { accountId: aid, count: ns.length, namespaces: ns };
			},
		},

		cf_kv_namespace_create: {
			description: "Create a KV namespace. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, title: { type: "string" } },
				required: ["title"],
			},
			execute: async (args: any) => {
				requireApply("cf_kv_namespace_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const ns = await runtime.client.kv.namespaces.create({ account_id: aid, title: args.title });
				return { accountId: aid, namespace: ns };
			},
		},

		cf_kv_namespace_delete: {
			description: "Delete a KV namespace. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, namespaceId: { type: "string" } },
				required: ["namespaceId"],
			},
			execute: async (args: any) => {
				requireApply("cf_kv_namespace_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				await runtime.client.kv.namespaces.delete(args.namespaceId, { account_id: aid });
				return { accountId: aid, deleted: true, namespaceId: args.namespaceId };
			},
		},

		cf_kv_keys_list: {
			description: "List keys in a KV namespace.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, namespaceId: { type: "string" },
					prefix: { type: "string" }, maxItems: { type: "number" },
				},
				required: ["namespaceId"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const keys = await collectAsync(
					runtime.client.kv.namespaces.keys.list(args.namespaceId, {
						account_id: aid, prefix: args.prefix,
					}) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { accountId: aid, namespaceId: args.namespaceId, count: keys.length, keys };
			},
		},

		cf_kv_value_get: {
			description: "Get a KV value by key.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, namespaceId: { type: "string" }, keyName: { type: "string" } },
				required: ["namespaceId", "keyName"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const res = await runtime.client.kv.namespaces.values.get(args.namespaceId, args.keyName, { account_id: aid });
				return { accountId: aid, namespaceId: args.namespaceId, keyName: args.keyName, value: await res.text() };
			},
		},

		cf_kv_value_put: {
			description: "Put a KV value by key. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, namespaceId: { type: "string" },
					keyName: { type: "string" }, value: { type: "string" },
					expirationTtl: { type: "number", description: "TTL in seconds (min 60)." },
				},
				required: ["namespaceId", "keyName", "value"],
			},
			execute: async (args: any) => {
				requireApply("cf_kv_value_put");
				const aid = await runtime.resolveAccountId(args?.accountId);
				await runtime.client.kv.namespaces.values.update(args.namespaceId, args.keyName, {
					account_id: aid, value: args.value, expiration_ttl: args.expirationTtl,
				});
				return { accountId: aid, namespaceId: args.namespaceId, keyName: args.keyName, updated: true };
			},
		},

		cf_kv_value_delete: {
			description: "Delete a KV value by key. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, namespaceId: { type: "string" }, keyName: { type: "string" } },
				required: ["namespaceId", "keyName"],
			},
			execute: async (args: any) => {
				requireApply("cf_kv_value_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				await runtime.client.kv.namespaces.values.delete(args.namespaceId, args.keyName, { account_id: aid });
				return { accountId: aid, namespaceId: args.namespaceId, keyName: args.keyName, deleted: true };
			},
		},

		cf_r2_bucket_list: {
			description: "List R2 buckets.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, nameContains: { type: "string" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const buckets = await runtime.client.r2.buckets.list({
					account_id: aid, name_contains: args?.nameContains,
				});
				return { accountId: aid, ...buckets };
			},
		},

		cf_r2_bucket_create: {
			description: "Create an R2 bucket. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, name: { type: "string" },
					storageClass: { type: "string", enum: ["Standard", "InfrequentAccess"] },
				},
				required: ["name"],
			},
			execute: async (args: any) => {
				requireApply("cf_r2_bucket_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const bucket = await runtime.client.r2.buckets.create({
					account_id: aid, name: args.name, storageClass: args.storageClass,
				});
				return { accountId: aid, bucket };
			},
		},

		cf_r2_bucket_delete: {
			description: "Delete an R2 bucket. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, bucketName: { type: "string" } },
				required: ["bucketName"],
			},
			execute: async (args: any) => {
				requireApply("cf_r2_bucket_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				await runtime.client.r2.buckets.delete(args.bucketName, { account_id: aid });
				return { accountId: aid, deleted: true, bucketName: args.bucketName };
			},
		},

		// ----- Zones & DNS -----

		cf_zones_list: {
			description: "List zones (domains) on the account.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", description: "Filter by domain name." }, status: { type: "string", enum: ["active", "pending", "initializing", "moved", "deleted", "deactivated"] }, maxItems: { type: "number" } },
			},
			execute: async (args: any) => {
				const zones = await collectAsync(
					runtime.client.zones.list({ name: args?.name, status: args?.status }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { count: zones.length, zones };
			},
		},

		cf_zone_get: {
			description: "Get details for a specific zone by ID.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const zone = await runtime.client.zones.get({ zone_id: args.zoneId });
				return { zone };
			},
		},

		cf_dns_records_list: {
			description: "List DNS records for a zone.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					type: { type: "string", description: "Filter by record type (A, AAAA, CNAME, MX, TXT, etc)." },
					name: { type: "string", description: "Filter by record name." },
					maxItems: { type: "number" },
				},
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const records = await collectAsync(
					runtime.client.dns.records.list({ zone_id: args.zoneId, type: args.type, name: args.name }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 500,
				);
				return { zoneId: args.zoneId, count: records.length, records };
			},
		},

		cf_dns_record_create: {
			description: "Create a DNS record. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" }, type: { type: "string" }, name: { type: "string" },
					content: { type: "string" }, ttl: { type: "number", description: "TTL in seconds (1=auto)." },
					proxied: { type: "boolean" }, priority: { type: "number", description: "For MX/SRV records." },
					comment: { type: "string" },
				},
				required: ["zoneId", "type", "name", "content"],
			},
			execute: async (args: any) => {
				requireApply("cf_dns_record_create");
				const record = await runtime.client.dns.records.create({
					zone_id: args.zoneId, type: args.type, name: args.name, content: args.content,
					ttl: args.ttl ?? 1, proxied: args.proxied, priority: args.priority, comment: args.comment,
				});
				return { zoneId: args.zoneId, record };
			},
		},

		cf_dns_record_update: {
			description: "Update a DNS record. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" }, recordId: { type: "string" },
					type: { type: "string" }, name: { type: "string" }, content: { type: "string" },
					ttl: { type: "number" }, proxied: { type: "boolean" }, comment: { type: "string" },
				},
				required: ["zoneId", "recordId", "type", "name", "content"],
			},
			execute: async (args: any) => {
				requireApply("cf_dns_record_update");
				const record = await runtime.client.dns.records.update(args.recordId, {
					zone_id: args.zoneId, type: args.type, name: args.name, content: args.content,
					ttl: args.ttl ?? 1, proxied: args.proxied, comment: args.comment,
				});
				return { zoneId: args.zoneId, record };
			},
		},

		cf_dns_record_delete: {
			description: "Delete a DNS record. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, recordId: { type: "string" } },
				required: ["zoneId", "recordId"],
			},
			execute: async (args: any) => {
				requireApply("cf_dns_record_delete");
				await runtime.client.dns.records.delete(args.recordId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, deleted: true, recordId: args.recordId };
			},
		},

		// ----- Pages -----

		cf_pages_projects_list: {
			description: "List Cloudflare Pages projects.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, maxItems: { type: "number" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const projects = await collectAsync(
					runtime.client.pages.projects.list({ account_id: aid }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 100,
				);
				return { accountId: aid, count: projects.length, projects };
			},
		},

		cf_pages_project_get: {
			description: "Get a Pages project's details.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, projectName: { type: "string" } },
				required: ["projectName"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const project = await runtime.client.pages.projects.get(args.projectName, { account_id: aid });
				return { accountId: aid, project };
			},
		},

		// ----- Email Routing / Email Service (inbound) -----

		cf_email_routing_get: {
			description: "Get Email Routing settings for a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const settings = await runtime.client.emailRouting.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, settings };
			},
		},

		cf_email_routing_dns_get: {
			description: "List DNS records needed for Email Routing on a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const response = await runtime.client.emailRouting.dns.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, response };
			},
		},

		cf_email_routing_dns_enable: {
			description: "Enable Email Routing DNS for a zone. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_dns_enable");
				const settings = await runtime.client.emailRouting.dns.create({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, settings };
			},
		},

		cf_email_routing_dns_disable: {
			description: "Disable Email Routing DNS for a zone. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, maxItems: { type: "number" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_dns_disable");
				const records = await collectAsync(
					runtime.client.emailRouting.dns.delete({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { zoneId: args.zoneId, count: records.length, records };
			},
		},

		cf_email_routing_dns_unlock: {
			description: "Unlock Email Routing MX records for a zone. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_dns_unlock");
				const settings = await runtime.client.emailRouting.dns.edit({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, settings };
			},
		},

		cf_email_routing_addresses_list: {
			description: "List Email Routing destination addresses for an account.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, maxItems: { type: "number" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const addresses = await collectAsync(
					runtime.client.emailRouting.addresses.list({ account_id: aid }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { accountId: aid, count: addresses.length, addresses };
			},
		},

		cf_email_routing_address_get: {
			description: "Get a specific Email Routing destination address.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, addressId: { type: "string" } },
				required: ["addressId"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const address = await runtime.client.emailRouting.addresses.get(args.addressId, { account_id: aid });
				return { accountId: aid, addressId: args.addressId, address };
			},
		},

		cf_email_routing_address_create: {
			description: "Create an Email Routing destination address. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, email: { type: "string" } },
				required: ["email"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_address_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const address = await runtime.client.emailRouting.addresses.create({ account_id: aid, email: args.email });
				return { accountId: aid, address };
			},
		},

		cf_email_routing_address_delete: {
			description: "Delete an Email Routing destination address. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, addressId: { type: "string" } },
				required: ["addressId"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_address_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const address = await runtime.client.emailRouting.addresses.delete(args.addressId, { account_id: aid });
				return { accountId: aid, addressId: args.addressId, address };
			},
		},

		cf_email_routing_rules_list: {
			description: "List email routing rules for a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, maxItems: { type: "number" }, enabled: { type: "boolean" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const rules = await collectAsync(
					runtime.client.emailRouting.rules.list({ zone_id: args.zoneId, enabled: args.enabled }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { zoneId: args.zoneId, count: rules.length, rules };
			},
		},

		cf_email_routing_rule_get: {
			description: "Get a specific email routing rule by ID.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, ruleId: { type: "string" } },
				required: ["zoneId", "ruleId"],
			},
			execute: async (args: any) => {
				const rule = await runtime.client.emailRouting.rules.get(args.ruleId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, ruleId: args.ruleId, rule };
			},
		},

		cf_email_routing_rule_create: {
			description: "Create an email routing rule. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" }, name: { type: "string" },
					enabled: { type: "boolean" }, priority: { type: "number" },
					matchers: { type: "array", items: { type: "object" }, description: "Array of matcher objects, for example {type, field, value}." },
					actions: { type: "array", items: { type: "object" }, description: "Array of action objects, for example {type, value}." },
				},
				required: ["zoneId", "matchers", "actions"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_rule_create");
				const rule = await runtime.client.emailRouting.rules.create({
					zone_id: args.zoneId,
					name: args.name,
					enabled: args.enabled ?? true,
					priority: args.priority,
					matchers: args.matchers,
					actions: args.actions,
				});
				return { zoneId: args.zoneId, rule };
			},
		},

		cf_email_routing_rule_update: {
			description: "Update an email routing rule. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					ruleId: { type: "string" },
					name: { type: "string" },
					enabled: { type: "boolean" },
					priority: { type: "number" },
					matchers: { type: "array", items: { type: "object" }, description: "Array of matcher objects." },
					actions: { type: "array", items: { type: "object" }, description: "Array of action objects." },
				},
				required: ["zoneId", "ruleId", "matchers", "actions"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_rule_update");
				const rule = await runtime.client.emailRouting.rules.update(args.ruleId, {
					zone_id: args.zoneId,
					name: args.name,
					enabled: args.enabled,
					priority: args.priority,
					matchers: args.matchers,
					actions: args.actions,
				});
				return { zoneId: args.zoneId, ruleId: args.ruleId, rule };
			},
		},

		cf_email_routing_rule_delete: {
			description: "Delete an email routing rule. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, ruleId: { type: "string" } },
				required: ["zoneId", "ruleId"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_rule_delete");
				const result = await runtime.client.emailRouting.rules.delete(args.ruleId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, ruleId: args.ruleId, deleted: true, result };
			},
		},

		cf_email_routing_catch_all_get: {
			description: "Get the Email Routing catch-all rule for a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const catchAll = await runtime.client.emailRouting.rules.catchAlls.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, catchAll };
			},
		},

		cf_email_routing_catch_all_update: {
			description: "Update the Email Routing catch-all rule for a zone. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					name: { type: "string" },
					enabled: { type: "boolean" },
					matchers: { type: "array", items: { type: "object" }, description: "Usually [{type: 'all'}]." },
					actions: { type: "array", items: { type: "object" }, description: "Action objects, including type drop|forward|worker." },
				},
				required: ["zoneId", "matchers", "actions"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_routing_catch_all_update");
				const catchAll = await runtime.client.emailRouting.rules.catchAlls.update({
					zone_id: args.zoneId,
					name: args.name,
					enabled: args.enabled,
					matchers: args.matchers,
					actions: args.actions,
				});
				return { zoneId: args.zoneId, catchAll };
			},
		},

		// ----- Email Sending / Email Service (outbound, public beta) -----

		cf_email_sending_send: {
			description: "Send an email via Cloudflare Email Sending. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					from: emailAddressUnionSchema,
					subject: { type: "string" },
					to: emailAddressListUnionSchema,
					text: { type: "string", description: "Plain-text body. At least one of text or html must be provided." },
					html: { type: "string", description: "HTML body. At least one of text or html must be provided." },
					cc: emailAddressListUnionSchema,
					bcc: emailAddressListUnionSchema,
					replyTo: emailAddressUnionSchema,
					headers: { type: "object", additionalProperties: { type: "string" } },
					attachments: { type: "array", items: emailAttachmentSchema },
				},
				required: ["from", "subject", "to"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_sending_send");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const response = await runtime.client.emailSending.send({
					account_id: aid,
					from: args.from,
					subject: args.subject,
					to: args.to,
					text: args.text,
					html: args.html,
					cc: args.cc,
					bcc: args.bcc,
					reply_to: args.replyTo,
					headers: args.headers,
					attachments: args.attachments,
				});
				return { accountId: aid, response };
			},
		},

		cf_email_sending_send_raw: {
			description: "Send a raw MIME email via Cloudflare Email Sending. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					from: { type: "string" },
					mimeMessage: { type: "string", description: "Full RFC 5322 MIME message." },
					recipients: { type: "array", items: { type: "string" }, description: "SMTP envelope recipients." },
				},
				required: ["from", "mimeMessage", "recipients"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_sending_send_raw");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const response = await runtime.client.emailSending.sendRaw({
					account_id: aid,
					from: args.from,
					mime_message: args.mimeMessage,
					recipients: args.recipients,
				});
				return { accountId: aid, response };
			},
		},

		cf_email_sending_subdomains_list: {
			description: "List Email Sending subdomains for a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, maxItems: { type: "number" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const subdomains = await collectAsync(
					runtime.client.emailSending.subdomains.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { zoneId: args.zoneId, count: subdomains.length, subdomains };
			},
		},

		cf_email_sending_subdomain_get: {
			description: "Get a specific Email Sending subdomain.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, subdomainId: { type: "string" } },
				required: ["zoneId", "subdomainId"],
			},
			execute: async (args: any) => {
				const subdomain = await runtime.client.emailSending.subdomains.get(args.subdomainId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, subdomainId: args.subdomainId, subdomain };
			},
		},

		cf_email_sending_subdomain_create: {
			description: "Create or re-enable an Email Sending subdomain. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, name: { type: "string", description: "Subdomain name within the zone." } },
				required: ["zoneId", "name"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_sending_subdomain_create");
				const subdomain = await runtime.client.emailSending.subdomains.create({ zone_id: args.zoneId, name: args.name });
				return { zoneId: args.zoneId, subdomain };
			},
		},

		cf_email_sending_subdomain_delete: {
			description: "Disable an Email Sending subdomain. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, subdomainId: { type: "string" } },
				required: ["zoneId", "subdomainId"],
			},
			execute: async (args: any) => {
				requireApply("cf_email_sending_subdomain_delete");
				const response = await runtime.client.emailSending.subdomains.delete(args.subdomainId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, subdomainId: args.subdomainId, response };
			},
		},

		cf_email_sending_subdomain_dns_get: {
			description: "List DNS records required for an Email Sending subdomain.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, subdomainId: { type: "string" }, maxItems: { type: "number" } },
				required: ["zoneId", "subdomainId"],
			},
			execute: async (args: any) => {
				const records = await collectAsync(
					runtime.client.emailSending.subdomains.dns.get(args.subdomainId, { zone_id: args.zoneId }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 200,
				);
				return { zoneId: args.zoneId, subdomainId: args.subdomainId, count: records.length, records };
			},
		},

		// ----- Queues -----

		cf_queues_list: {
			description: "List Cloudflare Queues.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const queues = await collectAsync(
					runtime.client.queues.list({ account_id: aid }) as unknown as AsyncIterable<any>,
					200,
				);
				return { accountId: aid, count: queues.length, queues };
			},
		},

		cf_queue_create: {
			description: "Create a Queue. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, name: { type: "string" } },
				required: ["name"],
			},
			execute: async (args: any) => {
				requireApply("cf_queue_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const queue = await runtime.client.queues.create({ account_id: aid, queue_name: args.name });
				return { accountId: aid, queue };
			},
		},

		// ----- Tunnels -----

		cf_tunnels_list: {
			description: "List Cloudflare Tunnels.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, maxItems: { type: "number" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const tunnels = await collectAsync(
					runtime.client.zeroTrust.tunnels.list({ account_id: aid }) as unknown as AsyncIterable<any>,
					args?.maxItems ?? 100,
				);
				return { accountId: aid, count: tunnels.length, tunnels };
			},
		},

		// ----- Vectorize -----

		cf_vectorize_indexes_list: {
			description: "List Vectorize indexes.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" } },
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const indexes = await collectAsync(
					runtime.client.vectorize.indexes.list({ account_id: aid }) as unknown as AsyncIterable<any>,
					200,
				);
				return { accountId: aid, count: indexes.length, indexes };
			},
		},

		// ----- Cache -----

		cf_cache_purge: {
			description: "Purge cache for a zone. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					purgeEverything: { type: "boolean", description: "Purge all cached content." },
					files: { type: "array", items: { type: "string" }, description: "Array of URLs to purge." },
					tags: { type: "array", items: { type: "string" }, description: "Cache-Tag header values to purge." },
					hosts: { type: "array", items: { type: "string" }, description: "Hostnames to purge." },
				},
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				requireApply("cf_cache_purge");
				const result = await runtime.client.cache.purge({ zone_id: args.zoneId, purge_everything: args.purgeEverything, files: args.files, tags: args.tags, hosts: args.hosts });
				return { zoneId: args.zoneId, result };
			},
		},

		// ----- SSL/Certificates -----

		cf_ssl_certificate_packs_list: {
			description: "List SSL certificate packs for a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const packs = await collectAsync(
					runtime.client.ssl.certificatePacks.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>,
					100,
				);
				return { zoneId: args.zoneId, count: packs.length, packs };
			},
		},

		// ----- Analytics -----

		cf_graphql_query: {
			description: "Run a read-only Cloudflare GraphQL query. Preferred for analytics/observability because several REST analytics endpoints are sunset.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "GraphQL query string." },
					variables: { type: "object", description: "Optional GraphQL variables object." },
					operationName: { type: "string", description: "Optional GraphQL operation name." },
				},
				required: ["query"],
			},
			execute: async (args: any) => {
				const result = await runtime.rawApiRequest({
					method: "POST",
					path: "/graphql",
					body: { query: args.query, variables: args.variables, operationName: args.operationName },
				});
				return result;
			},
		},

		cf_zone_analytics: {
			description: "Legacy zone analytics helper. Cloudflare sunset the old REST dashboard endpoint; use cf_graphql_query for reliable analytics queries.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					since: { type: "string", description: "ISO 8601 start time." },
					until: { type: "string", description: "ISO 8601 end time." },
				},
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				const since = args.since ?? new Date(Date.now() - 86400000).toISOString();
				const until = args.until ?? new Date().toISOString();
				return {
					ok: false,
					deprecated: true,
					message: "Cloudflare sunset /zones/:id/analytics/dashboard. Use cf_graphql_query instead.",
					zoneId: args.zoneId,
					since,
					until,
					suggestedQuery: "query($zoneTag: string!){ viewer { zones(filter: { zoneTag: $zoneTag }) { zoneTag } } }",
					suggestedVariables: { zoneTag: args.zoneId },
				};
			},
		},

		// ----- Workflows -----

		cf_workflows_list: {
			description: "List Workflows.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const workflows = await collectAsync(runtime.client.workflows.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: workflows.length, workflows };
			},
		},

		cf_workflow_get: {
			description: "Get a Workflow's details.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, workflowName: { type: "string" } }, required: ["workflowName"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.workflows.get(args.workflowName, { account_id: aid });
			},
		},

		cf_workflow_instances_list: {
			description: "List instances of a Workflow.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, workflowName: { type: "string" }, maxItems: { type: "number" } }, required: ["workflowName"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const instances = await collectAsync(runtime.client.workflows.instances.list(args.workflowName, { account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, workflowName: args.workflowName, count: instances.length, instances };
			},
		},

		cf_workflow_instance_get: {
			description: "Get a specific Workflow instance's details.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, workflowName: { type: "string" }, instanceId: { type: "string" } }, required: ["workflowName", "instanceId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.workflows.instances.get(args.workflowName, args.instanceId, { account_id: aid });
			},
		},

		// ----- Durable Objects -----

		cf_durable_objects_namespaces_list: {
			description: "List Durable Object namespaces.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const namespaces = await collectAsync(runtime.client.durableObjects.namespaces.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 200);
				return { accountId: aid, count: namespaces.length, namespaces };
			},
		},

		cf_durable_objects_list: {
			description: "List Durable Object instances in a namespace.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, namespaceId: { type: "string" }, maxItems: { type: "number" } }, required: ["namespaceId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const objects = await collectAsync(runtime.client.durableObjects.namespaces.objects.list(args.namespaceId, { account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 200);
				return { accountId: aid, namespaceId: args.namespaceId, count: objects.length, objects };
			},
		},

		// ----- Hyperdrive -----

		cf_hyperdrive_configs_list: {
			description: "List Hyperdrive configs.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const configs = await collectAsync(runtime.client.hyperdrive.configs.list({ account_id: aid }) as unknown as AsyncIterable<any>, 200);
				return { accountId: aid, count: configs.length, configs };
			},
		},

		cf_hyperdrive_config_get: {
			description: "Get a Hyperdrive config by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, hyperdriveId: { type: "string" } }, required: ["hyperdriveId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.hyperdrive.configs.get(args.hyperdriveId, { account_id: aid });
			},
		},

		// ----- Workers AI -----

		cf_ai_models_list: {
			description: "List available Workers AI models.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const models = await collectAsync(runtime.client.ai.models.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 200);
				return { accountId: aid, count: models.length, models };
			},
		},

		// ----- AI Gateway -----

		cf_ai_gateway_list: {
			description: "List AI Gateways.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const gateways = await collectAsync(runtime.client.aiGateway.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: gateways.length, gateways };
			},
		},

		cf_ai_gateway_get: {
			description: "Get an AI Gateway by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, gatewayId: { type: "string" } }, required: ["gatewayId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.aiGateway.get(args.gatewayId, { account_id: aid });
			},
		},

		cf_ai_gateway_logs_list: {
			description: "List logs for an AI Gateway.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, gatewayId: { type: "string" }, maxItems: { type: "number" } }, required: ["gatewayId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const logs = await collectAsync(runtime.client.aiGateway.logs.list(args.gatewayId, { account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, gatewayId: args.gatewayId, count: logs.length, logs };
			},
		},

		// ----- Stream (video) -----

		cf_stream_videos_list: {
			description: "List Stream videos.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				try {
					const videos = await collectAsync(runtime.client.stream.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
					return { accountId: aid, available: true, count: videos.length, videos };
				} catch (error) {
					const msg = toErrorMessage(error);
					if (msg.includes("Cloudflare Stream not enabled") || msg.includes("Authorization Failure")) {
						return { accountId: aid, available: false, count: 0, videos: [], message: "Cloudflare Stream is not enabled for this account." };
					}
					throw error;
				}
			},
		},

		cf_stream_video_get: {
			description: "Get a Stream video by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, videoId: { type: "string" } }, required: ["videoId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.stream.get(args.videoId, { account_id: aid });
			},
		},

		cf_stream_live_inputs_list: {
			description: "List Stream live inputs.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				try {
					const liveInputs = await runtime.client.stream.liveInputs.list({ account_id: aid });
					return { accountId: aid, available: true, ...liveInputs };
				} catch (error) {
					const msg = toErrorMessage(error);
					if (msg.includes("Cloudflare Stream not enabled") || msg.includes("Authorization Failure")) {
						return { accountId: aid, available: false, liveInputs: [], message: "Cloudflare Stream is not enabled for this account." };
					}
					throw error;
				}
			},
		},

		// ----- Images -----

		cf_images_list: {
			description: "List Cloudflare Images.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const images = await collectAsync(runtime.client.images.v1.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: images.length, images };
			},
		},

		cf_images_stats: {
			description: "Get Cloudflare Images usage stats.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.images.v1.stats.get({ account_id: aid });
			},
		},

		cf_images_monthly_usage_get: {
			description: "Get monthly Cloudflare Images usage for a month: stored images, image deliveries, and unique transformations, plus a quick Starter bundle fit summary.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					month: { type: "string", description: "Month in YYYY-MM format. Defaults to the current UTC month." },
					maxDays: { type: "number", description: "Max number of daily rows to request from GraphQL. Defaults to 62." },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const monthRaw = typeof args?.month === "string" && /^\d{4}-\d{2}$/.test(args.month)
					? args.month
					: new Date().toISOString().slice(0, 7);
				const [yearStr, monthStr] = monthRaw.split("-");
				const year = Number(yearStr);
				const monthIndex = Number(monthStr) - 1;
				const start = `${monthRaw}-01`;
				const endDate = new Date(Date.UTC(year, monthIndex + 1, 0));
				const end = endDate.toISOString().slice(0, 10);
				const maxDays = Number.isFinite(Number(args?.maxDays)) ? Math.max(1, Math.min(366, Number(args.maxDays))) : 62;

				const stats = await runtime.client.images.v1.stats.get({ account_id: aid });

				const query = `query($accountTag: string!, $start: Date!, $end: Date!, $limit: uint64!) {
					viewer {
						accounts(filter: { accountTag: $accountTag }) {
							accountTag
							imagesRequestsAdaptiveGroups(limit: $limit, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
								dimensions { date }
								sum { requests }
							}
							imagesUniqueTransformations(limit: $limit, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
								date
								transformations
							}
							imagesUniqueTransformationsAccumulatedSinceStartOfMonth(limit: $limit, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
								date
								transformations
							}
						}
					}
				}`;

				const graphql = await runtime.rawApiRequest({
					method: "POST",
					path: "/graphql",
					body: {
						query,
						variables: { accountTag: aid, start, end, limit: maxDays },
					},
				});

				const body = graphql.body as any;
				if (body?.errors?.length) {
					throw new Error(`GraphQL query failed: ${body.errors[0]?.message ?? "unknown error"}`);
				}

				const account = body?.data?.viewer?.accounts?.[0] ?? {};
				const requestGroups = account.imagesRequestsAdaptiveGroups ?? [];
				const dailyTransformations = account.imagesUniqueTransformations ?? [];
				const accumulatedTransformations = account.imagesUniqueTransformationsAccumulatedSinceStartOfMonth ?? [];

				const imageDeliveries = requestGroups.reduce((sum: number, row: any) => sum + Number(row?.sum?.requests ?? 0), 0);
				const latestAccumulated = accumulatedTransformations.length ? accumulatedTransformations[accumulatedTransformations.length - 1] : null;
				const uniqueTransformations = latestAccumulated
					? Number(latestAccumulated.transformations ?? 0)
					: dailyTransformations.reduce((sum: number, row: any) => sum + Number(row?.transformations ?? 0), 0);
				const storedImages = Number(stats?.count?.current ?? 0);
				const bundle = {
					starter: {
						storedImagesIncluded: 100000,
						imageDeliveriesIncludedPerMonth: 500000,
						uniqueTransformationsIncludedPerMonth: 5000,
						storedImagesPercentUsed: Number(((storedImages / 100000) * 100).toFixed(2)),
						imageDeliveriesPercentUsed: Number(((imageDeliveries / 500000) * 100).toFixed(4)),
						uniqueTransformationsPercentUsed: Number(((uniqueTransformations / 5000) * 100).toFixed(4)),
						fitsCurrentUsage: storedImages <= 100000 && imageDeliveries <= 500000 && uniqueTransformations <= 5000,
					},
				};

				return {
					accountId: aid,
					month: monthRaw,
					period: { start, end },
					storedImages,
					allowedStoredImages: Number(stats?.count?.allowed ?? 0),
					imageDeliveries,
					uniqueTransformations,
					transformationCountingMethod: latestAccumulated ? "imagesUniqueTransformationsAccumulatedSinceStartOfMonth.latest" : "imagesUniqueTransformations.sum",
					daily: {
						imageDeliveries: requestGroups.map((row: any) => ({ date: row?.dimensions?.date, requests: Number(row?.sum?.requests ?? 0) })),
						uniqueTransformations: dailyTransformations.map((row: any) => ({ date: row?.date, transformations: Number(row?.transformations ?? 0) })),
						uniqueTransformationsAccumulatedSinceStartOfMonth: accumulatedTransformations.map((row: any) => ({ date: row?.date, transformations: Number(row?.transformations ?? 0) })),
					},
					bundle,
				};
			},
		},

		// ----- Turnstile -----

		cf_turnstile_widgets_list: {
			description: "List Turnstile widgets (CAPTCHA sites).",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const widgets = await collectAsync(runtime.client.turnstile.widgets.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: widgets.length, widgets };
			},
		},

		// ----- Secrets Store -----

		cf_secrets_store_list: {
			description: "List Secrets Store stores.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const stores = await collectAsync(runtime.client.secretsStore.stores.list({ account_id: aid }) as unknown as AsyncIterable<any>, 200);
				return { accountId: aid, count: stores.length, stores };
			},
		},

		cf_secrets_store_secrets_list: {
			description: "List secrets in a Secrets Store store.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, storeId: { type: "string" }, maxItems: { type: "number" } }, required: ["storeId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const secrets = await collectAsync(runtime.client.secretsStore.stores.secrets.list(args.storeId, { account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 200);
				return { accountId: aid, storeId: args.storeId, count: secrets.length, secrets };
			},
		},

		// ----- Logpush (observability) -----

		cf_logpush_jobs_list: {
			description: "List Logpush jobs (account-level log delivery).",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const jobs = await collectAsync(runtime.client.logpush.jobs.list({ account_id: aid }) as unknown as AsyncIterable<any>, 200);
				return { accountId: aid, count: jobs.length, jobs };
			},
		},

		// ----- WAF / Rulesets -----

		cf_waf_rulesets_list: {
			description: "List WAF rulesets for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const rulesets = await collectAsync(runtime.client.rulesets.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>, 200);
				return { zoneId: args.zoneId, count: rulesets.length, rulesets };
			},
		},

		// ----- Workers Deployments & Secrets -----

		cf_worker_deployments_list: {
			description: "List deployments for a Worker script.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, scriptName: { type: "string" } }, required: ["scriptName"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.workers.scripts.deployments.list(args.scriptName, { account_id: aid });
			},
		},

		cf_worker_secrets_list: {
			description: "List secrets bound to a Worker script (names only, not values).",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, scriptName: { type: "string" } }, required: ["scriptName"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const secrets = await collectAsync(runtime.client.workers.scripts.secrets.list(args.scriptName, { account_id: aid }) as unknown as AsyncIterable<any>, 200);
				return { accountId: aid, scriptName: args.scriptName, count: secrets.length, secrets };
			},
		},

		cf_worker_secret_get: {
			description: "Get metadata for a specific Worker secret binding.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, scriptName: { type: "string" }, secretName: { type: "string" } },
				required: ["scriptName", "secretName"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const secret = await runtime.client.workers.scripts.secrets.get(args.scriptName, args.secretName, { account_id: aid });
				return { accountId: aid, scriptName: args.scriptName, secretName: args.secretName, secret };
			},
		},

		cf_worker_secret_update: {
			description: "Create or update a Worker secret binding. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					scriptName: { type: "string" },
					secretName: { type: "string" },
					value: { type: "string", description: "Secret text value." },
					type: { type: "string", enum: ["secret_text"] },
				},
				required: ["scriptName", "secretName", "value"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_secret_update");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const secret = await runtime.client.workers.scripts.secrets.update(args.scriptName, {
					account_id: aid,
					name: args.secretName,
					text: args.value,
					type: args.type ?? "secret_text",
				});
				return { accountId: aid, scriptName: args.scriptName, secretName: args.secretName, secret };
			},
		},

		cf_worker_secret_delete: {
			description: "Delete a Worker secret binding. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					scriptName: { type: "string" },
					secretName: { type: "string" },
					urlEncoded: { type: "boolean", description: "Whether the secret name is URL-encoded already." },
				},
				required: ["scriptName", "secretName"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_secret_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.workers.scripts.secrets.delete(args.scriptName, args.secretName, {
					account_id: aid,
					url_encoded: args.urlEncoded,
				});
				return { accountId: aid, scriptName: args.scriptName, secretName: args.secretName, deleted: true, result };
			},
		},

		cf_worker_script_settings_get: {
			description: "Get script-level settings for a Worker script.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, scriptName: { type: "string" } },
				required: ["scriptName"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const settings = await runtime.client.workers.scripts.settings.get(args.scriptName, { account_id: aid });
				return { accountId: aid, scriptName: args.scriptName, settings };
			},
		},

		cf_worker_script_settings_edit: {
			description: "Edit script-level settings for a Worker script. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					scriptName: { type: "string" },
					settings: { type: "object", description: "Patch body for the script settings endpoint." },
				},
				required: ["scriptName", "settings"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_script_settings_edit");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const settings = await runtime.client.workers.scripts.settings.edit(args.scriptName, {
					account_id: aid,
					...(args.settings ?? {}),
				});
				return { accountId: aid, scriptName: args.scriptName, settings };
			},
		},

		cf_worker_script_metadata_get: {
			description: "Get Worker script metadata and config, including bindings and usage model.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, scriptName: { type: "string" } },
				required: ["scriptName"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const metadata = await runtime.client.workers.scripts.scriptAndVersionSettings.get(args.scriptName, { account_id: aid });
				return { accountId: aid, scriptName: args.scriptName, metadata };
			},
		},

		cf_worker_script_metadata_edit: {
			description: "Edit Worker script metadata and bindings. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					scriptName: { type: "string" },
					settings: { type: "object", description: "Patch body for script metadata/settings, such as bindings or usage model." },
				},
				required: ["scriptName", "settings"],
			},
			execute: async (args: any) => {
				requireApply("cf_worker_script_metadata_edit");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const metadata = await runtime.client.workers.scripts.scriptAndVersionSettings.edit(args.scriptName, {
					account_id: aid,
					...(args.settings ?? {}),
				});
				return { accountId: aid, scriptName: args.scriptName, metadata };
			},
		},

		cf_worker_schedules_get: {
			description: "Get cron schedules for a Worker script.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, scriptName: { type: "string" } }, required: ["scriptName"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				return runtime.client.workers.scripts.schedules.get(args.scriptName, { account_id: aid });
			},
		},

		// ----- Observability / Logs -----

		cf_logs_received_fields_get: {
			description: "Get available Logpull fields for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const fields = await runtime.client.logs.received.fields.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, fields };
			},
		},

		cf_logs_received_get: {
			description: "Fetch edge HTTP logs for a zone over a time range using Logpull.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					end: { type: ["string", "number"] as any, description: "Exclusive end time (RFC3339 or unix timestamp)." },
					start: { type: ["string", "number"] as any, description: "Inclusive start time (RFC3339 or unix timestamp)." },
					count: { type: "number" },
					fields: { type: "string" },
					sample: { type: "number" },
					timestamps: { type: "string", enum: ["unix", "unixnano", "rfc3339"] },
				},
				required: ["zoneId", "end"],
			},
			execute: async (args: any) => {
				const logs = await runtime.client.logs.received.get({
					zone_id: args.zoneId,
					end: args.end,
					start: args.start,
					count: args.count,
					fields: args.fields,
					sample: args.sample,
					timestamps: args.timestamps,
				});
				return { zoneId: args.zoneId, logs };
			},
		},

		cf_logs_rayid_get: {
			description: "Lookup zone logs by Ray ID.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					rayId: { type: "string" },
					fields: { type: "string" },
					timestamps: { type: "string", enum: ["unix", "unixnano", "rfc3339"] },
				},
				required: ["zoneId", "rayId"],
			},
			execute: async (args: any) => {
				const logs = await runtime.client.logs.RayID.get(args.rayId, {
					zone_id: args.zoneId,
					fields: args.fields,
					timestamps: args.timestamps,
				});
				return { zoneId: args.zoneId, rayId: args.rayId, logs };
			},
		},

		cf_logs_retention_get: {
			description: "Get the Logpull retention flag for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const retention = await runtime.client.logs.control.retention.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, retention };
			},
		},

		cf_logs_retention_set: {
			description: "Set the Logpull retention flag for a zone. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, flag: { type: "boolean" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				requireApply("cf_logs_retention_set");
				const retention = await runtime.client.logs.control.retention.create({ zone_id: args.zoneId, flag: args.flag });
				return { zoneId: args.zoneId, retention };
			},
		},

		cf_logs_cmb_config_get: {
			description: "Get account-level Logs CMB config.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const config = await runtime.client.logs.control.cmb.config.get({ account_id: aid });
				return { accountId: aid, config };
			},
		},

		cf_logs_cmb_config_set: {
			description: "Set account-level Logs CMB config. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, regions: { type: "string" }, allowOutOfRegionAccess: { type: "boolean" } },
			},
			execute: async (args: any) => {
				requireApply("cf_logs_cmb_config_set");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const config = await runtime.client.logs.control.cmb.config.create({
					account_id: aid,
					regions: args.regions,
					allow_out_of_region_access: args.allowOutOfRegionAccess,
				});
				return { accountId: aid, config };
			},
		},

		cf_logs_cmb_config_delete: {
			description: "Delete account-level Logs CMB config. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				requireApply("cf_logs_cmb_config_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.logs.control.cmb.config.delete({ account_id: aid });
				return { accountId: aid, result };
			},
		},

		cf_request_trace_create: {
			description: "Trace how Cloudflare rules will process a synthetic request. This is diagnostic and does not change config.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" },
					url: { type: "string" },
					method: { type: "string" },
					body: { type: "object" },
					context: { type: "object" },
					cookies: { type: "object" },
					headers: { type: "object" },
					protocol: { type: "string" },
					skipResponse: { type: "boolean" },
				},
				required: ["url", "method"],
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const trace = await runtime.client.requestTracers.traces.create({
					account_id: aid,
					url: args.url,
					method: args.method,
					body: args.body,
					context: args.context,
					cookies: args.cookies,
					headers: args.headers,
					protocol: args.protocol,
					skip_response: args.skipResponse,
				});
				return { accountId: aid, trace };
			},
		},

		// ----- Browser Rendering -----

		cf_browser_content_get: {
			description: "Render a page and return HTML content.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, url: { type: "string" }, html: { type: "string" }, cacheTTL: { type: "number" },
					actionTimeout: { type: "number" }, gotoOptions: { type: "object" }, waitForSelector: { type: "object" },
					waitForTimeout: { type: "number" }, viewport: { type: "object" }, userAgent: { type: "string" },
					bestAttempt: { type: "boolean" }, setJavaScriptEnabled: { type: "boolean" }, setExtraHTTPHeaders: { type: "object" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const content = await runtime.client.browserRendering.content.create({
					account_id: aid,
					url: args.url,
					html: args.html,
					cacheTTL: args.cacheTTL,
					actionTimeout: args.actionTimeout,
					gotoOptions: args.gotoOptions,
					waitForSelector: args.waitForSelector,
					waitForTimeout: args.waitForTimeout,
					viewport: args.viewport,
					userAgent: args.userAgent,
					bestAttempt: args.bestAttempt,
					setJavaScriptEnabled: args.setJavaScriptEnabled,
					setExtraHTTPHeaders: args.setExtraHTTPHeaders,
				});
				return { accountId: aid, content };
			},
		},

		cf_browser_markdown_get: {
			description: "Render a page and return Markdown.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, url: { type: "string" }, html: { type: "string" }, cacheTTL: { type: "number" },
					actionTimeout: { type: "number" }, gotoOptions: { type: "object" }, waitForSelector: { type: "object" },
					waitForTimeout: { type: "number" }, viewport: { type: "object" }, userAgent: { type: "string" },
					bestAttempt: { type: "boolean" }, setJavaScriptEnabled: { type: "boolean" }, setExtraHTTPHeaders: { type: "object" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const markdown = await runtime.client.browserRendering.markdown.create({
					account_id: aid,
					url: args.url,
					html: args.html,
					cacheTTL: args.cacheTTL,
					actionTimeout: args.actionTimeout,
					gotoOptions: args.gotoOptions,
					waitForSelector: args.waitForSelector,
					waitForTimeout: args.waitForTimeout,
					viewport: args.viewport,
					userAgent: args.userAgent,
					bestAttempt: args.bestAttempt,
					setJavaScriptEnabled: args.setJavaScriptEnabled,
					setExtraHTTPHeaders: args.setExtraHTTPHeaders,
				});
				return { accountId: aid, markdown };
			},
		},

		cf_browser_links_get: {
			description: "Render a page and extract links.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, url: { type: "string" }, html: { type: "string" }, cacheTTL: { type: "number" },
					actionTimeout: { type: "number" }, gotoOptions: { type: "object" }, waitForSelector: { type: "object" },
					waitForTimeout: { type: "number" }, viewport: { type: "object" }, userAgent: { type: "string" },
					excludeExternalLinks: { type: "boolean" }, visibleLinksOnly: { type: "boolean" }, bestAttempt: { type: "boolean" },
					setJavaScriptEnabled: { type: "boolean" }, setExtraHTTPHeaders: { type: "object" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const links = await runtime.client.browserRendering.links.create({
					account_id: aid,
					url: args.url,
					html: args.html,
					cacheTTL: args.cacheTTL,
					actionTimeout: args.actionTimeout,
					gotoOptions: args.gotoOptions,
					waitForSelector: args.waitForSelector,
					waitForTimeout: args.waitForTimeout,
					viewport: args.viewport,
					userAgent: args.userAgent,
					excludeExternalLinks: args.excludeExternalLinks,
					visibleLinksOnly: args.visibleLinksOnly,
					bestAttempt: args.bestAttempt,
					setJavaScriptEnabled: args.setJavaScriptEnabled,
					setExtraHTTPHeaders: args.setExtraHTTPHeaders,
				});
				return { accountId: aid, count: links.length, links };
			},
		},

		cf_browser_json_get: {
			description: "Render a page and extract structured JSON.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, url: { type: "string" }, html: { type: "string" }, prompt: { type: "string" },
					responseFormat: { type: "object", description: "Optional response format / schema hint." }, cacheTTL: { type: "number" },
					actionTimeout: { type: "number" }, gotoOptions: { type: "object" }, waitForSelector: { type: "object" },
					waitForTimeout: { type: "number" }, viewport: { type: "object" }, userAgent: { type: "string" },
					bestAttempt: { type: "boolean" }, setJavaScriptEnabled: { type: "boolean" }, setExtraHTTPHeaders: { type: "object" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const data = await runtime.client.browserRendering.json.create({
					account_id: aid,
					url: args.url,
					html: args.html,
					prompt: args.prompt,
					response_format: args.responseFormat,
					cacheTTL: args.cacheTTL,
					actionTimeout: args.actionTimeout,
					gotoOptions: args.gotoOptions,
					waitForSelector: args.waitForSelector,
					waitForTimeout: args.waitForTimeout,
					viewport: args.viewport,
					userAgent: args.userAgent,
					bestAttempt: args.bestAttempt,
					setJavaScriptEnabled: args.setJavaScriptEnabled,
					setExtraHTTPHeaders: args.setExtraHTTPHeaders,
				});
				return { accountId: aid, data };
			},
		},

		cf_browser_screenshot_get: {
			description: "Render a page and return screenshot output from Browser Rendering.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, url: { type: "string" }, html: { type: "string" }, cacheTTL: { type: "number" },
					actionTimeout: { type: "number" }, gotoOptions: { type: "object" }, waitForSelector: { type: "object" },
					waitForTimeout: { type: "number" }, viewport: { type: "object" }, userAgent: { type: "string" },
					selector: { type: "string" }, fullPage: { type: "boolean" }, type: { type: "string", enum: ["png", "jpeg", "webp"] },
					quality: { type: "number" }, omitBackground: { type: "boolean" }, bestAttempt: { type: "boolean" },
					setJavaScriptEnabled: { type: "boolean" }, setExtraHTTPHeaders: { type: "object" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const screenshot: any = await runtime.client.browserRendering.screenshot.create({
					account_id: aid,
					url: args.url,
					html: args.html,
					cacheTTL: args.cacheTTL,
					actionTimeout: args.actionTimeout,
					gotoOptions: args.gotoOptions,
					waitForSelector: args.waitForSelector,
					waitForTimeout: args.waitForTimeout,
					viewport: args.viewport,
					userAgent: args.userAgent,
					selector: args.selector,
					bestAttempt: args.bestAttempt,
					setJavaScriptEnabled: args.setJavaScriptEnabled,
					setExtraHTTPHeaders: args.setExtraHTTPHeaders,
					screenshotOptions: {
						encoding: "base64",
						fullPage: args.fullPage,
						type: args.type,
						quality: args.quality,
						omitBackground: args.omitBackground,
					},
				});
				if (typeof screenshot === "string" && screenshot.startsWith("data:")) {
					const comma = screenshot.indexOf(",");
					const meta = comma >= 0 ? screenshot.slice(5, comma) : "";
					const mimeType = meta.split(";")[0] || "image/png";
					const base64 = comma >= 0 ? screenshot.slice(comma + 1) : screenshot;
					return { accountId: aid, mimeType, base64, dataUrl: screenshot };
				}
				return { accountId: aid, screenshot };
			},
		},

		cf_browser_pdf_get: {
			description: "Render a page as PDF and return base64 bytes.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, url: { type: "string" }, html: { type: "string" }, cacheTTL: { type: "number" },
					actionTimeout: { type: "number" }, gotoOptions: { type: "object" }, waitForSelector: { type: "object" },
					waitForTimeout: { type: "number" }, viewport: { type: "object" }, userAgent: { type: "string" }, pdfOptions: { type: "object" },
					bestAttempt: { type: "boolean" }, setJavaScriptEnabled: { type: "boolean" }, setExtraHTTPHeaders: { type: "object" },
				},
			},
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const res = await runtime.client.browserRendering.pdf.create({
					account_id: aid,
					url: args.url,
					html: args.html,
					cacheTTL: args.cacheTTL,
					actionTimeout: args.actionTimeout,
					gotoOptions: args.gotoOptions,
					waitForSelector: args.waitForSelector,
					waitForTimeout: args.waitForTimeout,
					viewport: args.viewport,
					userAgent: args.userAgent,
					pdfOptions: args.pdfOptions,
					bestAttempt: args.bestAttempt,
					setJavaScriptEnabled: args.setJavaScriptEnabled,
					setExtraHTTPHeaders: args.setExtraHTTPHeaders,
				});
				const buffer = await res.arrayBuffer();
				return {
					accountId: aid,
					mimeType: res.headers.get("content-type") ?? "application/pdf",
					byteLength: buffer.byteLength,
					base64: arrayBufferToBase64(buffer),
				};
			},
		},

		// ----- Load Balancing -----

		cf_load_balancers_list: {
			description: "List load balancers for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, maxItems: { type: "number" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const balancers = await collectAsync(runtime.client.loadBalancers.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { zoneId: args.zoneId, count: balancers.length, loadBalancers: balancers };
			},
		},

		cf_load_balancer_get: {
			description: "Get a load balancer by ID.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, loadBalancerId: { type: "string" } }, required: ["zoneId", "loadBalancerId"] },
			execute: async (args: any) => {
				const loadBalancer = await runtime.client.loadBalancers.get(args.loadBalancerId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, loadBalancer };
			},
		},

		cf_load_balancer_create: {
			description: "Create a load balancer. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" }, name: { type: "string" }, defaultPools: { type: "array", items: { type: "string" } },
					fallbackPool: { type: "string" }, description: { type: "string" }, proxied: { type: "boolean" }, ttl: { type: "number" },
					steeringPolicy: { type: "string" }, sessionAffinity: { type: "string" }, regionPools: { type: "object" }, countryPools: { type: "object" },
					popPools: { type: "object" }, adaptiveRouting: { type: "object" }, randomSteering: { type: "object" },
				},
				required: ["zoneId", "name", "defaultPools", "fallbackPool"],
			},
			execute: async (args: any) => {
				requireApply("cf_load_balancer_create");
				const loadBalancer = await runtime.client.loadBalancers.create({
					zone_id: args.zoneId,
					name: args.name,
					default_pools: args.defaultPools,
					fallback_pool: args.fallbackPool,
					description: args.description,
					proxied: args.proxied,
					ttl: args.ttl,
					steering_policy: args.steeringPolicy,
					session_affinity: args.sessionAffinity,
					region_pools: args.regionPools,
					country_pools: args.countryPools,
					pop_pools: args.popPools,
					adaptive_routing: args.adaptiveRouting,
					random_steering: args.randomSteering,
				});
				return { zoneId: args.zoneId, loadBalancer };
			},
		},

		cf_load_balancer_delete: {
			description: "Delete a load balancer. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, loadBalancerId: { type: "string" } }, required: ["zoneId", "loadBalancerId"] },
			execute: async (args: any) => {
				requireApply("cf_load_balancer_delete");
				const result = await runtime.client.loadBalancers.delete(args.loadBalancerId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, result };
			},
		},

		cf_load_balancer_monitors_list: {
			description: "List load balancer monitors for an account.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const monitors = await collectAsync(runtime.client.loadBalancers.monitors.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: monitors.length, monitors };
			},
		},

		cf_load_balancer_monitor_get: {
			description: "Get a load balancer monitor by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, monitorId: { type: "string" } }, required: ["monitorId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const monitor = await runtime.client.loadBalancers.monitors.get(args.monitorId, { account_id: aid });
				return { accountId: aid, monitor };
			},
		},

		cf_load_balancer_monitor_create: {
			description: "Create a load balancer monitor. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, type: { type: "string", enum: ["http", "https", "tcp", "udp_icmp", "icmp_ping", "smtp"] },
					description: { type: "string" }, method: { type: "string" }, path: { type: "string" }, port: { type: "number" },
					expectedCodes: { type: "string" }, expectedBody: { type: "string" }, header: { type: "object" }, interval: { type: "number" },
					timeout: { type: "number" }, retries: { type: "number" }, consecutiveUp: { type: "number" }, consecutiveDown: { type: "number" },
					allowInsecure: { type: "boolean" }, followRedirects: { type: "boolean" }, probeZone: { type: "string" },
				},
			},
			execute: async (args: any) => {
				requireApply("cf_load_balancer_monitor_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const monitor = await runtime.client.loadBalancers.monitors.create({
					account_id: aid,
					type: args.type,
					description: args.description,
					method: args.method,
					path: args.path,
					port: args.port,
					expected_codes: args.expectedCodes,
					expected_body: args.expectedBody,
					header: args.header,
					interval: args.interval,
					timeout: args.timeout,
					retries: args.retries,
					consecutive_up: args.consecutiveUp,
					consecutive_down: args.consecutiveDown,
					allow_insecure: args.allowInsecure,
					follow_redirects: args.followRedirects,
					probe_zone: args.probeZone,
				});
				return { accountId: aid, monitor };
			},
		},

		cf_load_balancer_monitor_delete: {
			description: "Delete a load balancer monitor. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, monitorId: { type: "string" } }, required: ["monitorId"] },
			execute: async (args: any) => {
				requireApply("cf_load_balancer_monitor_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.loadBalancers.monitors.delete(args.monitorId, { account_id: aid });
				return { accountId: aid, result };
			},
		},

		cf_load_balancer_pools_list: {
			description: "List load balancer pools for an account.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const pools = await collectAsync(runtime.client.loadBalancers.pools.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: pools.length, pools };
			},
		},

		cf_load_balancer_pool_get: {
			description: "Get a load balancer pool by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, poolId: { type: "string" } }, required: ["poolId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const pool = await runtime.client.loadBalancers.pools.get(args.poolId, { account_id: aid });
				return { accountId: aid, pool };
			},
		},

		cf_load_balancer_pool_create: {
			description: "Create a load balancer pool. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					accountId: { type: "string" }, name: { type: "string" }, origins: { type: "array", items: { type: "object" } },
					description: { type: "string" }, enabled: { type: "boolean" }, minimumOrigins: { type: "number" }, monitor: { type: "string" },
					monitorGroup: { type: "string" }, checkRegions: { type: "array", items: { type: "string" } }, notificationEmail: { type: "string" },
					latitude: { type: "number" }, longitude: { type: "number" }, networks: { type: "array", items: { type: "string" } },
				},
				required: ["name", "origins"],
			},
			execute: async (args: any) => {
				requireApply("cf_load_balancer_pool_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const pool = await runtime.client.loadBalancers.pools.create({
					account_id: aid,
					name: args.name,
					origins: args.origins,
					description: args.description,
					enabled: args.enabled,
					minimum_origins: args.minimumOrigins,
					monitor: args.monitor,
					monitor_group: args.monitorGroup,
					notification_email: args.notificationEmail,
					latitude: args.latitude,
					longitude: args.longitude,
				});
				return { accountId: aid, pool };
			},
		},

		cf_load_balancer_pool_delete: {
			description: "Delete a load balancer pool. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, poolId: { type: "string" } }, required: ["poolId"] },
			execute: async (args: any) => {
				requireApply("cf_load_balancer_pool_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.loadBalancers.pools.delete(args.poolId, { account_id: aid });
				return { accountId: aid, result };
			},
		},

		cf_load_balancer_pool_health_get: {
			description: "Get the current health for a load balancer pool.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, poolId: { type: "string" } }, required: ["poolId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const health = await runtime.client.loadBalancers.pools.health.get(args.poolId, { account_id: aid });
				return { accountId: aid, poolId: args.poolId, health };
			},
		},

		// ----- Health Checks -----

		cf_healthchecks_list: {
			description: "List health checks for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, maxItems: { type: "number" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const checks = await collectAsync(runtime.client.healthchecks.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { zoneId: args.zoneId, count: checks.length, healthchecks: checks };
			},
		},

		cf_healthcheck_get: {
			description: "Get a health check by ID.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, healthcheckId: { type: "string" } }, required: ["zoneId", "healthcheckId"] },
			execute: async (args: any) => {
				const healthcheck = await runtime.client.healthchecks.get(args.healthcheckId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, healthcheck };
			},
		},

		cf_healthcheck_create: {
			description: "Create a health check. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" }, name: { type: "string" }, address: { type: "string" }, type: { type: "string" }, description: { type: "string" },
					interval: { type: "number" }, retries: { type: "number" }, suspended: { type: "boolean" }, timeout: { type: "number" },
					checkRegions: { type: "array", items: { type: "string" } }, httpConfig: { type: "object" }, tcpConfig: { type: "object" },
				},
				required: ["zoneId", "name", "address"],
			},
			execute: async (args: any) => {
				requireApply("cf_healthcheck_create");
				const healthcheck = await runtime.client.healthchecks.create({
					zone_id: args.zoneId,
					name: args.name,
					address: args.address,
					type: args.type,
					description: args.description,
					interval: args.interval,
					retries: args.retries,
					suspended: args.suspended,
					timeout: args.timeout,
					check_regions: args.checkRegions,
					http_config: args.httpConfig,
					tcp_config: args.tcpConfig,
				});
				return { zoneId: args.zoneId, healthcheck };
			},
		},

		cf_healthcheck_delete: {
			description: "Delete a health check. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, healthcheckId: { type: "string" } }, required: ["zoneId", "healthcheckId"] },
			execute: async (args: any) => {
				requireApply("cf_healthcheck_delete");
				const result = await runtime.client.healthchecks.delete(args.healthcheckId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, result };
			},
		},

		// ----- Registrar -----

		cf_registrar_domains_list: {
			description: "List domains in Cloudflare Registrar for an account.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const domains = await collectAsync(runtime.client.registrar.domains.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: domains.length, domains };
			},
		},

		cf_registrar_domain_get: {
			description: "Get a Registrar domain by name.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, domainName: { type: "string" } }, required: ["domainName"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const domain = await runtime.client.registrar.domains.get(args.domainName, { account_id: aid });
				return { accountId: aid, domainName: args.domainName, domain };
			},
		},

		cf_registrar_domain_update: {
			description: "Update Registrar domain settings. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, domainName: { type: "string" }, autoRenew: { type: "boolean" }, locked: { type: "boolean" }, privacy: { type: "boolean" } },
				required: ["domainName"],
			},
			execute: async (args: any) => {
				requireApply("cf_registrar_domain_update");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const domain = await runtime.client.registrar.domains.update(args.domainName, {
					account_id: aid,
					auto_renew: args.autoRenew,
					locked: args.locked,
					privacy: args.privacy,
				});
				return { accountId: aid, domainName: args.domainName, domain };
			},
		},

		// ----- Waiting Rooms -----

		cf_waiting_rooms_list: {
			description: "List waiting rooms for an account or zone.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, zoneId: { type: "string" }, maxItems: { type: "number" } },
			},
			execute: async (args: any) => {
				let path = "";
				if (args?.zoneId) path = `/zones/${args.zoneId}/waiting_rooms`;
				else {
					const aid = await runtime.resolveAccountId(args?.accountId);
					path = `/accounts/${aid}/waiting_rooms`;
				}
				const response = await runtime.rawApiRequest({ method: "GET", path });
				const waitingRooms = Array.isArray(unwrapCfResult(response.body)) ? unwrapCfResult(response.body) : [];
				const maxItems = args?.maxItems ?? waitingRooms.length;
				return {
					scope: args?.zoneId ? { zone_id: args.zoneId } : { account_id: await runtime.resolveAccountId(args?.accountId) },
					count: Math.min(waitingRooms.length, maxItems),
					waitingRooms: waitingRooms.slice(0, maxItems),
					response: response.body,
				};
			},
		},

		cf_waiting_room_get: {
			description: "Get a waiting room by ID.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, waitingRoomId: { type: "string" } }, required: ["zoneId", "waitingRoomId"] },
			execute: async (args: any) => {
				const waitingRoom = await runtime.client.waitingRooms.get(args.waitingRoomId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, waitingRoom };
			},
		},

		cf_waiting_room_status_get: {
			description: "Get the live status of a waiting room.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, waitingRoomId: { type: "string" } }, required: ["zoneId", "waitingRoomId"] },
			execute: async (args: any) => {
				const status = await runtime.client.waitingRooms.statuses.get(args.waitingRoomId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, waitingRoomId: args.waitingRoomId, status };
			},
		},

		cf_waiting_room_create: {
			description: "Create a waiting room. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" }, host: { type: "string" }, name: { type: "string" }, newUsersPerMinute: { type: "number" }, totalActiveUsers: { type: "number" },
					path: { type: "string" }, description: { type: "string" }, queueAll: { type: "boolean" }, queueingMethod: { type: "string" }, sessionDuration: { type: "number" },
					suspended: { type: "boolean" }, customPageHtml: { type: "string" }, additionalRoutes: { type: "array", items: { type: "object" } }, cookieSuffix: { type: "string" },
				},
				required: ["zoneId", "host", "name", "newUsersPerMinute", "totalActiveUsers"],
			},
			execute: async (args: any) => {
				requireApply("cf_waiting_room_create");
				const waitingRoom = await runtime.client.waitingRooms.create({
					zone_id: args.zoneId,
					host: args.host,
					name: args.name,
					new_users_per_minute: args.newUsersPerMinute,
					total_active_users: args.totalActiveUsers,
					path: args.path,
					description: args.description,
					queue_all: args.queueAll,
					queueing_method: args.queueingMethod,
					session_duration: args.sessionDuration,
					suspended: args.suspended,
					custom_page_html: args.customPageHtml,
					additional_routes: args.additionalRoutes,
					cookie_suffix: args.cookieSuffix,
				});
				return { zoneId: args.zoneId, waitingRoom };
			},
		},

		cf_waiting_room_delete: {
			description: "Delete a waiting room. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, waitingRoomId: { type: "string" } }, required: ["zoneId", "waitingRoomId"] },
			execute: async (args: any) => {
				requireApply("cf_waiting_room_delete");
				const result = await runtime.client.waitingRooms.delete(args.waitingRoomId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, result };
			},
		},

		cf_waiting_room_events_list: {
			description: "List events for a waiting room.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, waitingRoomId: { type: "string" }, maxItems: { type: "number" } }, required: ["zoneId", "waitingRoomId"] },
			execute: async (args: any) => {
				const events = await collectAsync(runtime.client.waitingRooms.events.list(args.waitingRoomId, { zone_id: args.zoneId }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { zoneId: args.zoneId, waitingRoomId: args.waitingRoomId, count: events.length, events };
			},
		},

		cf_waiting_room_event_get: {
			description: "Get a waiting room event by ID.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, waitingRoomId: { type: "string" }, eventId: { type: "string" } }, required: ["zoneId", "waitingRoomId", "eventId"] },
			execute: async (args: any) => {
				const event = await runtime.client.waitingRooms.events.get(args.waitingRoomId, args.eventId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, waitingRoomId: args.waitingRoomId, event };
			},
		},

		cf_waiting_room_event_create: {
			description: "Create a waiting room event. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" }, waitingRoomId: { type: "string" }, name: { type: "string" },
					eventStartTime: { type: "string" }, eventEndTime: { type: "string" }, description: { type: "string" },
					newUsersPerMinute: { type: "number" }, totalActiveUsers: { type: "number" }, prequeueStartTime: { type: "string" },
					shuffleAtEventStart: { type: "boolean" }, suspended: { type: "boolean" },
				},
				required: ["zoneId", "waitingRoomId", "name", "eventStartTime", "eventEndTime"],
			},
			execute: async (args: any) => {
				requireApply("cf_waiting_room_event_create");
				const event = await runtime.client.waitingRooms.events.create(args.waitingRoomId, {
					zone_id: args.zoneId,
					name: args.name,
					event_start_time: args.eventStartTime,
					event_end_time: args.eventEndTime,
					description: args.description,
					new_users_per_minute: args.newUsersPerMinute,
					total_active_users: args.totalActiveUsers,
					prequeue_start_time: args.prequeueStartTime,
					shuffle_at_event_start: args.shuffleAtEventStart,
					suspended: args.suspended,
				});
				return { zoneId: args.zoneId, waitingRoomId: args.waitingRoomId, event };
			},
		},

		cf_waiting_room_event_delete: {
			description: "Delete a waiting room event. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, waitingRoomId: { type: "string" }, eventId: { type: "string" } }, required: ["zoneId", "waitingRoomId", "eventId"] },
			execute: async (args: any) => {
				requireApply("cf_waiting_room_event_delete");
				const result = await runtime.client.waitingRooms.events.delete(args.waitingRoomId, args.eventId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, waitingRoomId: args.waitingRoomId, result };
			},
		},

		// ----- Alerting -----

		cf_alerting_available_alerts_list: {
			description: "List alert types the account is eligible for.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const alerts = await runtime.client.alerting.availableAlerts.list({ account_id: aid });
				return { accountId: aid, alerts };
			},
		},

		cf_alerting_policies_list: {
			description: "List notification policies for an account.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const policies = await collectAsync(runtime.client.alerting.policies.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: policies.length, policies };
			},
		},

		cf_alerting_policy_get: {
			description: "Get a notification policy by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, policyId: { type: "string" } }, required: ["policyId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const policy = await runtime.client.alerting.policies.get(args.policyId, { account_id: aid });
				return { accountId: aid, policy };
			},
		},

		cf_alerting_policy_create: {
			description: "Create a notification policy. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { accountId: { type: "string" }, name: { type: "string" }, alertType: { type: "string" }, enabled: { type: "boolean" }, mechanisms: { type: "object" }, description: { type: "string" }, filters: { type: "object" }, alertInterval: { type: "string" } },
				required: ["name", "alertType", "enabled", "mechanisms"],
			},
			execute: async (args: any) => {
				requireApply("cf_alerting_policy_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const policy = await runtime.client.alerting.policies.create({
					account_id: aid,
					name: args.name,
					alert_type: args.alertType,
					enabled: args.enabled,
					mechanisms: args.mechanisms,
					description: args.description,
					filters: args.filters,
					alert_interval: args.alertInterval,
				});
				return { accountId: aid, policy };
			},
		},

		cf_alerting_policy_delete: {
			description: "Delete a notification policy. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, policyId: { type: "string" } }, required: ["policyId"] },
			execute: async (args: any) => {
				requireApply("cf_alerting_policy_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.alerting.policies.delete(args.policyId, { account_id: aid });
				return { accountId: aid, result };
			},
		},

		cf_alerting_webhooks_list: {
			description: "List notification webhook destinations.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const webhooks = await collectAsync(runtime.client.alerting.destinations.webhooks.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { accountId: aid, count: webhooks.length, webhooks };
			},
		},

		cf_alerting_webhook_get: {
			description: "Get a notification webhook destination by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, webhookId: { type: "string" } }, required: ["webhookId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const webhook = await runtime.client.alerting.destinations.webhooks.get(args.webhookId, { account_id: aid });
				return { accountId: aid, webhook };
			},
		},

		cf_alerting_webhook_create: {
			description: "Create a notification webhook destination. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, name: { type: "string" }, url: { type: "string" }, secret: { type: "string" } }, required: ["name", "url"] },
			execute: async (args: any) => {
				requireApply("cf_alerting_webhook_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const webhook = await runtime.client.alerting.destinations.webhooks.create({ account_id: aid, name: args.name, url: args.url, secret: args.secret });
				return { accountId: aid, webhook };
			},
		},

		cf_alerting_webhook_delete: {
			description: "Delete a notification webhook destination. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, webhookId: { type: "string" } }, required: ["webhookId"] },
			execute: async (args: any) => {
				requireApply("cf_alerting_webhook_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.alerting.destinations.webhooks.delete(args.webhookId, { account_id: aid });
				return { accountId: aid, result };
			},
		},

		// ----- API Gateway -----

		cf_api_gateway_config_get: {
			description: "Get API Gateway / API Shield configuration for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, normalize: { type: "boolean" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const config = await runtime.client.apiGateway.configurations.get({ zone_id: args.zoneId, normalize: args.normalize });
				return { zoneId: args.zoneId, config };
			},
		},

		cf_api_gateway_discovery_get: {
			description: "Get API discovery output rendered as OpenAPI schemas for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const discovery = await runtime.client.apiGateway.discovery.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, discovery };
			},
		},

		cf_api_gateway_operations_list: {
			description: "List API Gateway / API Shield operations for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, maxItems: { type: "number" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const operations = await collectAsync(runtime.client.apiGateway.operations.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>, args?.maxItems ?? 200);
				return { zoneId: args.zoneId, count: operations.length, operations };
			},
		},

		cf_api_gateway_operation_get: {
			description: "Get an API Gateway operation by ID.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, operationId: { type: "string" } }, required: ["zoneId", "operationId"] },
			execute: async (args: any) => {
				const operation = await runtime.client.apiGateway.operations.get(args.operationId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, operation };
			},
		},

		cf_api_gateway_operation_create: {
			description: "Create an API Gateway operation. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, host: { type: "string" }, endpoint: { type: "string" }, method: { type: "string" } }, required: ["zoneId", "host", "endpoint", "method"] },
			execute: async (args: any) => {
				requireApply("cf_api_gateway_operation_create");
				const operation = await runtime.client.apiGateway.operations.create({ zone_id: args.zoneId, host: args.host, endpoint: args.endpoint, method: args.method });
				return { zoneId: args.zoneId, operation };
			},
		},

		cf_api_gateway_operation_delete: {
			description: "Delete an API Gateway operation. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, operationId: { type: "string" } }, required: ["zoneId", "operationId"] },
			execute: async (args: any) => {
				requireApply("cf_api_gateway_operation_delete");
				const result = await runtime.client.apiGateway.operations.delete(args.operationId, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, result };
			},
		},

		// ----- Rules Lists -----

		cf_rules_lists_list: {
			description: "List account rules lists.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, maxItems: { type: "number" } } },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const lists = await collectAsync(runtime.client.rules.lists.list({ account_id: aid }) as unknown as AsyncIterable<any>, args?.maxItems ?? 200);
				return { accountId: aid, count: lists.length, lists };
			},
		},

		cf_rules_list_get: {
			description: "Get an account rules list by ID.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, listId: { type: "string" } }, required: ["listId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const list = await runtime.client.rules.lists.get(args.listId, { account_id: aid });
				return { accountId: aid, list };
			},
		},

		cf_rules_list_create: {
			description: "Create an account rules list. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, kind: { type: "string", enum: ["ip", "redirect", "hostname", "asn"] }, name: { type: "string" }, description: { type: "string" } }, required: ["kind", "name"] },
			execute: async (args: any) => {
				requireApply("cf_rules_list_create");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const list = await runtime.client.rules.lists.create({ account_id: aid, kind: args.kind, name: args.name, description: args.description });
				return { accountId: aid, list };
			},
		},

		cf_rules_list_delete: {
			description: "Delete an account rules list. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, listId: { type: "string" } }, required: ["listId"] },
			execute: async (args: any) => {
				requireApply("cf_rules_list_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.rules.lists.delete(args.listId, { account_id: aid });
				return { accountId: aid, result };
			},
		},

		cf_rules_list_items_list: {
			description: "List items in an account rules list.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, listId: { type: "string" }, maxItems: { type: "number" }, search: { type: "string" } }, required: ["listId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const items = await collectAsync(runtime.client.rules.lists.items.list(args.listId, { account_id: aid, search: args.search }) as unknown as AsyncIterable<any>, args?.maxItems ?? 500);
				return { accountId: aid, listId: args.listId, count: items.length, items };
			},
		},

		cf_rules_list_items_add: {
			description: "Append items to an account rules list. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, listId: { type: "string" }, items: { type: "array", items: { type: "object" } } }, required: ["listId", "items"] },
			execute: async (args: any) => {
				requireApply("cf_rules_list_items_add");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.rules.lists.items.create(args.listId, { account_id: aid, body: args.items });
				return { accountId: aid, listId: args.listId, result };
			},
		},

		cf_rules_list_items_replace: {
			description: "Replace all items in an account rules list. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, listId: { type: "string" }, items: { type: "array", items: { type: "object" } } }, required: ["listId", "items"] },
			execute: async (args: any) => {
				requireApply("cf_rules_list_items_replace");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.rules.lists.items.update(args.listId, { account_id: aid, body: args.items });
				return { accountId: aid, listId: args.listId, result };
			},
		},

		cf_rules_list_items_delete: {
			description: "Delete items from an account rules list. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, listId: { type: "string" }, items: { type: "array", items: { type: "object" } } }, required: ["listId"] },
			execute: async (args: any) => {
				requireApply("cf_rules_list_items_delete");
				const aid = await runtime.resolveAccountId(args?.accountId);
				const result = await runtime.client.rules.lists.items.delete(args.listId, { account_id: aid, items: args.items });
				return { accountId: aid, listId: args.listId, result };
			},
		},

		cf_rules_list_bulk_operation_get: {
			description: "Get status for an asynchronous account rules list bulk operation.",
			inputSchema: { type: "object", properties: { accountId: { type: "string" }, operationId: { type: "string" } }, required: ["operationId"] },
			execute: async (args: any) => {
				const aid = await runtime.resolveAccountId(args?.accountId);
				const operation = await runtime.client.rules.lists.bulkOperations.get(args.operationId, { account_id: aid });
				return { accountId: aid, operation };
			},
		},

		// ----- Snippets -----

		cf_snippets_list: {
			description: "List snippets for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, maxItems: { type: "number" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const snippets = await collectAsync(runtime.client.snippets.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
				return { zoneId: args.zoneId, count: snippets.length, snippets };
			},
		},

		cf_snippet_get: {
			description: "Get snippet metadata by name.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, snippetName: { type: "string" } }, required: ["zoneId", "snippetName"] },
			execute: async (args: any) => {
				const snippet = await runtime.client.snippets.get(args.snippetName, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, snippet };
			},
		},

		cf_snippet_content_get: {
			description: "Get raw multipart snippet content by name.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, snippetName: { type: "string" } }, required: ["zoneId", "snippetName"] },
			execute: async (args: any) => {
				const res = await runtime.client.snippets.content.get(args.snippetName, { zone_id: args.zoneId });
				return {
					zoneId: args.zoneId,
					snippetName: args.snippetName,
					contentType: res.headers.get("content-type"),
					content: await res.text(),
				};
			},
		},

		cf_snippet_put: {
			description: "Create or update a snippet from a single main module file. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: {
					zoneId: { type: "string" },
					snippetName: { type: "string" },
					content: { type: "string", description: "JavaScript/TypeScript source for the main module." },
					mainModule: { type: "string", description: "Filename for the main module, e.g. index.js." },
				},
				required: ["zoneId", "snippetName", "content"],
			},
			execute: async (args: any) => {
				requireApply("cf_snippet_put");
				const mainModule = args.mainModule ?? "index.js";
				const file = new File([args.content], mainModule, { type: "application/javascript" });
				const params: any = { zone_id: args.zoneId, metadata: { main_module: mainModule } };
				params[mainModule] = file;
				const snippet = await runtime.client.snippets.update(args.snippetName, params);
				return { zoneId: args.zoneId, snippet };
			},
		},

		cf_snippet_delete: {
			description: "Delete a snippet by name. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, snippetName: { type: "string" } }, required: ["zoneId", "snippetName"] },
			execute: async (args: any) => {
				requireApply("cf_snippet_delete");
				const result = await runtime.client.snippets.delete(args.snippetName, { zone_id: args.zoneId });
				return { zoneId: args.zoneId, result };
			},
		},

		cf_snippet_rules_list: {
			description: "List all snippet rules for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, maxItems: { type: "number" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				try {
					const rules = await collectAsync(runtime.client.snippets.rules.list({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>, args?.maxItems ?? 100);
					return { zoneId: args.zoneId, count: rules.length, rules };
				} catch (error) {
					const msg = toErrorMessage(error);
					if (msg.includes("could not find entrypoint ruleset in the http_request_snippets phase")) {
						return { zoneId: args.zoneId, count: 0, rules: [], message: "No snippet ruleset exists yet for this zone." };
					}
					throw error;
				}
			},
		},

		cf_snippet_rules_update: {
			description: "Replace all snippet rules for a zone. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, rules: { type: "array", items: { type: "object" }, description: "Each rule should contain at least expression and snippet_name." } }, required: ["zoneId", "rules"] },
			execute: async (args: any) => {
				requireApply("cf_snippet_rules_update");
				const rules = await collectAsync(runtime.client.snippets.rules.update({ zone_id: args.zoneId, rules: args.rules }) as unknown as AsyncIterable<any>, 1000);
				return { zoneId: args.zoneId, count: rules.length, rules };
			},
		},

		cf_snippet_rules_delete: {
			description: "Delete all snippet rules for a zone. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				requireApply("cf_snippet_rules_delete");
				const rules = await collectAsync(runtime.client.snippets.rules.delete({ zone_id: args.zoneId }) as unknown as AsyncIterable<any>, 1000);
				return { zoneId: args.zoneId, count: rules.length, rules };
			},
		},

		// ----- Zaraz -----

		cf_zaraz_config_get: {
			description: "Get the current Zaraz configuration for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const config = await runtime.client.zaraz.config.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, config };
			},
		},

		cf_zaraz_config_update: {
			description: "Update Zaraz configuration for a zone. Mutating — requires mode=apply.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, config: { type: "object", description: "Full Zaraz config body minus zone_id." } },
				required: ["zoneId", "config"],
			},
			execute: async (args: any) => {
				requireApply("cf_zaraz_config_update");
				const config = await runtime.client.zaraz.config.update({ zone_id: args.zoneId, ...(args.config ?? {}) });
				return { zoneId: args.zoneId, config };
			},
		},

		cf_zaraz_publish: {
			description: "Publish the current Zaraz preview configuration. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, description: { type: "string", description: "Optional publish description." } }, required: ["zoneId"] },
			execute: async (args: any) => {
				requireApply("cf_zaraz_publish");
				const result = await runtime.client.zaraz.publish.create({ zone_id: args.zoneId, body: args.description });
				return { zoneId: args.zoneId, result };
			},
		},

		cf_zaraz_workflow_get: {
			description: "Get whether Zaraz is in preview or realtime workflow for a zone.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, required: ["zoneId"] },
			execute: async (args: any) => {
				const workflow = await runtime.client.zaraz.workflow.get({ zone_id: args.zoneId });
				return { zoneId: args.zoneId, workflow };
			},
		},

		cf_zaraz_history_list: {
			description: "List published Zaraz configuration history for a zone.",
			inputSchema: {
				type: "object",
				properties: { zoneId: { type: "string" }, limit: { type: "number" }, offset: { type: "number" }, sortField: { type: "string" }, sortOrder: { type: "string", enum: ["DESC", "ASC"] } },
				required: ["zoneId"],
			},
			execute: async (args: any) => {
				try {
					const entries = await collectAsync(runtime.client.zaraz.history.list({ zone_id: args.zoneId, limit: args.limit, offset: args.offset, sortField: args.sortField, sortOrder: args.sortOrder }) as unknown as AsyncIterable<any>, args?.limit ?? 100);
					return { zoneId: args.zoneId, previewModeRequired: false, count: entries.length, entries };
				} catch (error) {
					const msg = toErrorMessage(error);
					if (msg.includes("preview mode to work with configs history")) {
						return { zoneId: args.zoneId, previewModeRequired: true, count: 0, entries: [], message: "Zaraz config history is only available while the zone is in preview mode." };
					}
					throw error;
				}
			},
		},

		cf_zaraz_history_restore: {
			description: "Restore a historical Zaraz configuration by history ID. Mutating — requires mode=apply.",
			inputSchema: { type: "object", properties: { zoneId: { type: "string" }, historyId: { type: "number" } }, required: ["zoneId", "historyId"] },
			execute: async (args: any) => {
				requireApply("cf_zaraz_history_restore");
				const config = await runtime.client.zaraz.history.update({ zone_id: args.zoneId, body: args.historyId });
				return { zoneId: args.zoneId, config };
			},
		},

		// ----- Escape hatch -----

		cf_api_request: {
			description: "Direct Cloudflare v4 API request. Non-GET requires mode=apply. Path starts with '/'.",
			inputSchema: {
				type: "object",
				properties: {
					method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
					path: { type: "string" },
					query: { type: "object" },
					body: {},
				},
				required: ["method", "path"],
			},
			execute: async (args: any) => {
				if (args.method !== "GET") requireApply("cf_api_request (non-GET)");
				return runtime.rawApiRequest(args);
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Schema generation
// ---------------------------------------------------------------------------

const SEARCH_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"by",
	"cloudflare",
	"current",
	"does",
	"for",
	"from",
	"get",
	"in",
	"into",
	"is",
	"list",
	"of",
	"on",
	"only",
	"or",
	"requires",
	"return",
	"returns",
	"the",
	"to",
	"with",
]);

const SHORT_SEARCH_TOKENS = new Set(["ai", "cf", "d1", "kv", "r2", "waf"]);

function normalizeSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function tokenizeForSearch(value: string): string[] {
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

function inferProductDetails(toolName: string): { product: string; aliases: string[] } {
	const coreName = toolName.replace(/^cf_/, "");
	const entries: Array<{ pattern: RegExp; product: string; aliases: string[] }> = [
		{ pattern: /^accounts?_/, product: "Accounts", aliases: ["account", "accounts"] },
		{ pattern: /^workers?_ai_/, product: "Workers AI", aliases: ["workers ai", "ai", "model", "models"] },
		{ pattern: /^workers?_/, product: "Workers", aliases: ["worker", "workers", "script", "scripts", "service", "services"] },
		{ pattern: /^d1_/, product: "D1", aliases: ["d1", "sqlite", "sql", "database", "databases"] },
		{ pattern: /^kv_/, product: "KV", aliases: ["kv", "key", "value", "namespace", "namespaces"] },
		{ pattern: /^r2_/, product: "R2", aliases: ["r2", "bucket", "buckets", "object", "storage"] },
		{ pattern: /^zones?_/, product: "Zones", aliases: ["zone", "zones", "domain", "domains"] },
		{ pattern: /^dns_/, product: "DNS", aliases: ["dns", "record", "records", "zone", "domain"] },
		{ pattern: /^pages_/, product: "Pages", aliases: ["pages", "project", "projects", "site", "sites"] },
		{ pattern: /^zero_trust_/, product: "Zero Trust", aliases: ["zero trust", "cloudflare one", "organization", "team", "team domain", "auth domain"] },
		{ pattern: /^access_/, product: "Access", aliases: ["access", "zero trust", "cloudflare one", "application", "applications", "policy", "policies", "identity provider", "identity providers", "group", "groups", "service token", "service tokens"] },
		{ pattern: /^email_sending_/, product: "Email Sending", aliases: ["email sending", "email service", "send email", "outbound email", "mail send", "mail sending"] },
		{ pattern: /^email_/, product: "Email Routing", aliases: ["email", "mail", "routing", "forwarding", "rule", "rules"] },
		{ pattern: /^queues_/, product: "Queues", aliases: ["queue", "queues", "message", "messages"] },
		{ pattern: /^tunnels_/, product: "Tunnels", aliases: ["tunnel", "tunnels", "cloudflared"] },
		{ pattern: /^vectorize_/, product: "Vectorize", aliases: ["vectorize", "vector", "vectors", "embedding", "embeddings", "index", "indexes"] },
		{ pattern: /^cache_/, product: "Cache", aliases: ["cache", "purge", "cdn"] },
		{ pattern: /^ssl_/, product: "SSL", aliases: ["ssl", "tls", "certificate", "certificates"] },
		{ pattern: /^graphql_/, product: "GraphQL Analytics", aliases: ["graphql", "analytics", "observability", "metrics"] },
		{ pattern: /^workflows_/, product: "Workflows", aliases: ["workflow", "workflows", "instance", "instances"] },
		{ pattern: /^durable_/, product: "Durable Objects", aliases: ["durable", "object", "objects", "namespace", "namespaces"] },
		{ pattern: /^hyperdrive_/, product: "Hyperdrive", aliases: ["hyperdrive", "database", "postgres", "mysql"] },
		{ pattern: /^ai_gateway_/, product: "AI Gateway", aliases: ["ai gateway", "gateway", "gateways", "ai"] },
		{ pattern: /^stream_/, product: "Stream", aliases: ["stream", "video", "videos", "live"] },
		{ pattern: /^images_/, product: "Images", aliases: ["images", "image", "delivery", "transformations"] },
		{ pattern: /^turnstile_/, product: "Turnstile", aliases: ["turnstile", "captcha", "widget", "widgets"] },
		{ pattern: /^secrets_store_/, product: "Secrets Store", aliases: ["secret", "secrets", "store", "stores"] },
		{ pattern: /^logpush_/, product: "Logpush", aliases: ["logpush", "log", "logs"] },
		{ pattern: /^waf_/, product: "WAF", aliases: ["waf", "firewall", "ruleset", "rulesets"] },
		{ pattern: /^logs_/, product: "Zone Logs", aliases: ["log", "logs", "ray", "request", "edge"] },
		{ pattern: /^browser_/, product: "Browser Rendering", aliases: ["browser", "render", "html", "markdown", "pdf", "screenshot"] },
		{ pattern: /^load_balancer_/, product: "Load Balancers", aliases: ["load balancer", "load balancers", "pool", "monitor", "origin"] },
		{ pattern: /^healthcheck_/, product: "Health Checks", aliases: ["healthcheck", "health check", "health", "monitoring"] },
		{ pattern: /^registrar_/, product: "Registrar", aliases: ["registrar", "domain", "domains", "whois", "privacy", "lock"] },
		{ pattern: /^waiting_room_/, product: "Waiting Rooms", aliases: ["waiting room", "waiting rooms", "queue", "traffic spike"] },
		{ pattern: /^alert_/, product: "Alerting", aliases: ["alert", "alerts", "notification", "notifications", "webhook", "webhooks"] },
		{ pattern: /^api_gateway_/, product: "API Gateway", aliases: ["api gateway", "api shield", "discovery", "operation", "operations"] },
		{ pattern: /^rules_/, product: "Rules Lists", aliases: ["rules", "list", "lists", "ip", "redirect", "hostname", "asn"] },
		{ pattern: /^snippets_/, product: "Snippets", aliases: ["snippet", "snippets", "zone logic"] },
		{ pattern: /^zaraz_/, product: "Zaraz", aliases: ["zaraz", "tag", "tags", "analytics", "marketing"] },
		{ pattern: /^api_request$/, product: "Cloudflare API", aliases: ["api", "v4", "request", "raw request"] },
	];

	for (const entry of entries) {
		if (entry.pattern.test(coreName)) return { product: entry.product, aliases: entry.aliases };
	}
	return { product: "Cloudflare", aliases: ["cloudflare"] };
}

function inferMutating(toolName: string, description: string): boolean {
	if (/mutating|requires mode=apply/i.test(description)) return true;
	return /_(create|update|delete|put|edit|append|replace|restore|publish|purge)\b/i.test(toolName);
}

function buildSchemaMethods(tools: Record<string, ToolDescriptor>): SchemaMethodDescriptor[] {
	const methods: SchemaMethodDescriptor[] = [];
	for (const [name, tool] of Object.entries(tools)) {
		const { product, aliases } = inferProductDetails(name);
		const required = Array.isArray(tool.inputSchema.required)
			? tool.inputSchema.required.filter((value): value is string => typeof value === "string")
			: [];
		const keywords = uniqueStrings([
			...tokenizeForSearch(name),
			...tokenizeForSearch(tool.description),
			...aliases.flatMap((alias) => tokenizeForSearch(alias)),
		]).slice(0, 32);

		methods.push({
			name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			required,
			mutating: inferMutating(name, tool.description),
			product,
			aliases,
			keywords,
		});
	}
	return methods;
}

function buildSchemaDescriptors(tools: Record<string, ToolDescriptor>) {
	const descriptors: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {};
	for (const [name, tool] of Object.entries(tools)) {
		descriptors[name] = { description: tool.description, inputSchema: tool.inputSchema };
	}
	return descriptors;
}

function generateSchema(tools: Record<string, ToolDescriptor>): string {
	const descriptors = buildSchemaDescriptors(tools);
	try {
		return generateTypesFromJsonSchema(descriptors);
	} catch {
		// Fallback: hand-build a simple type string
		const lines: string[] = [];
		lines.push("declare const codemode: {");
		for (const [name, tool] of Object.entries(tools)) {
			const safeName = sanitizeToolName(name);
			lines.push(`  /** ${tool.description} */`);
			lines.push(`  ${safeName}: (input: Record<string, unknown>) => Promise<unknown>;`);
		}
		lines.push("};");
		return lines.join("\n");
	}
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function buildToolFunctions(
	tools: Record<string, ToolDescriptor>,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
	const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
	for (const [name, tool] of Object.entries(tools)) {
		fns[name] = async (...args: unknown[]) => {
			// Codemode sandbox calls: codemode.toolName(inputObject)
			// The first argument is the input object.
			const input = args[0] ?? {};
			return tool.execute(input);
		};
	}
	return fns;
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

const executePayloadSchema = z.object({
	mode: z.enum(["plan", "apply"]),
	code: z.string().min(1),
});

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health
		if (request.method === "GET" && url.pathname === "/health") {
			return json({ ok: true, service: "cloudflare-codemode-executor" });
		}

		// Schema — returns TS type definitions plus structured metadata so Pi can search and validate the API surface
		if (request.method === "GET" && url.pathname === "/schema") {
			const unauthorized = assertAuthorized(request, env);
			if (unauthorized) return unauthorized;

			try {
				const runtime = new CloudflareRuntime(env);
				const tools = buildTools(runtime, "plan");
				const types = generateSchema(tools);
				const toolNames = Object.keys(tools);
				const methods = buildSchemaMethods(tools);
				return json({
					schemaVersion: 2,
					generatedAt: new Date().toISOString(),
					types,
					tools: toolNames,
					methods,
				});
			} catch (error) {
				return json({ error: toErrorMessage(error) }, 500);
			}
		}

		// Execute — runs Pi-authored code in the sandbox
		if (request.method === "POST" && url.pathname === "/execute") {
			const unauthorized = assertAuthorized(request, env);
			if (unauthorized) return unauthorized;

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}

			const parsed = executePayloadSchema.safeParse(body);
			if (!parsed.success) {
				return json({ error: "Invalid payload", details: parsed.error.issues }, 400);
			}

			const { mode, code } = parsed.data;
			const runId = crypto.randomUUID();
			const startedAt = Date.now();

			try {
				const runtime = new CloudflareRuntime(env);
				const tools = buildTools(runtime, mode);
				const fns = buildToolFunctions(tools);
				const executor = new DynamicWorkerExecutor({ loader: env.LOADER as never });
				const result = await executor.execute(code, fns);
				const durationMs = Date.now() - startedAt;

				return json({
					runId,
					status: result.error ? "error" : "ok",
					result: result.result,
					error: result.error,
					logs: result.logs ?? [],
					durationMs,
				});
			} catch (error) {
				const durationMs = Date.now() - startedAt;
				return json({ runId, status: "error", error: toErrorMessage(error), durationMs }, 500);
			}
		}

		return json({ error: "Not found" }, 404);
	},
};
