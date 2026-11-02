/**
 * Specialist configuration.
 *
 * Stored outside the session, in the pi agent directory:
 *   ${PI_CODING_AGENT_DIR:-~/.pi/agent}/specialists.json
 *
 * Shape:
 * {
 *   "version": 1,
 *   "enabled": true,
 *   "outputDir": "/tmp/pi-specialists",      // optional, generated media
 *   "specialists": [
 *     { "name": "Qwen3-VL-2B", "type": "image-to-text", "protocol": "openai-chat",
 *       "baseUrl": "http://127.0.0.1", "port": 8080, "model": "my-model", ... }
 *   ]
 * }
 *
 * `name` is the only identifier: it must be unique and is what the tool, the
 * commands and the menu use to reference a specialist. Legacy files that still
 * carry an `id` are migrated on load: `name` wins, and the old id becomes an
 * alias so existing tool calls keep working. Saved files never contain `id`.
 *
 * Secrets are never required inline: `apiKey` accepts
 *   - a literal key
 *   - "env:VAR_NAME"
 *   - "file:/absolute/path" (or "file:~/...")
 * The file is written with mode 0600.
 *
 * Pure Node + catalog imports only: no pi imports, so the module is testable
 * with plain `node --test`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { normalizeBudget, validateBudget, type BudgetOverrides } from "./budget-types.ts";
import {
	PROTOCOLS,
	PROTOCOL_DEFAULT_BASE_URL,
	canonicalType,
	findType,
	type ProtocolId,
} from "./catalog.ts";

export type AuthType = "bearer" | "header" | "query" | "basic" | "none";

export interface SpecialistAuth {
	type: AuthType;
	/** Header name for `type: "header"` (default `X-API-Key`). */
	headerName?: string;
	/** Query parameter for `type: "query"` (default `api_key`). */
	queryName?: string;
	/** Prefix prepended to the key (default `Bearer ` for bearer, empty otherwise). */
	prefix?: string;
	/** Username for `type: "basic"`. */
	username?: string;
}

export interface Specialist {
	/** Unique display name and reference used by the tool and commands. */
	name: string;
	/** Extra references (legacy ids, synonyms). Optional. */
	aliases?: string[];
	/** Canonical Hugging Face pipeline tag (see catalog.ts). */
	type: string;
	protocol: ProtocolId;
	enabled: boolean;
	baseUrl: string;
	/** Optional port, applied on top of `baseUrl`. */
	port?: number;
	/** Override the protocol endpoint path, e.g. `/v1/chat/completions`. */
	path?: string;
	model?: string;
	/** Literal key, `env:VAR` or `file:/path`. */
	apiKey?: string;
	auth: SpecialistAuth;
	headers: Record<string, string>;
	query: Record<string, string>;
	/** Extra JSON merged into the request body. */
	body: Record<string, unknown>;
	/** Hard HTTP timeout in milliseconds. */
	timeoutMs: number;
	/**
	 * How long the tool waits inline before returning a background job id.
	 * 0 means "return a job immediately"; the default keeps the agent blocked
	 * for at most 250 ms while very fast specialists still answer inline.
	 */
	waitMs: number;
	/** Optional overrides for the auto-discovered context/media budget. */
	budget?: BudgetOverrides;
	notes?: string;
}

export interface SpecialistsConfig {
	version: 1;
	enabled: boolean;
	/** Where generated images/audio/video are written. */
	outputDir?: string;
	specialists: Specialist[];
}

export interface LoadedConfig {
	config: SpecialistsConfig;
	path: string;
	warnings: string[];
}

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Inline grace period before a call becomes a background job. */
export const DEFAULT_WAIT_MS = 250;
export const MAX_WAIT_MS = 600_000;

export function agentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configFilePath(): string {
	return join(agentConfigDir(), "specialists.json");
}

export function defaultConfig(): SpecialistsConfig {
	return { version: 1, enabled: true, specialists: [] };
}

export function slugify(value: string): string {
	return String(value)
		.trim()
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64) || "specialist";
}

/**
 * Accept a bare host or host:port and infer HTTP:
 *   my-host         -> http://my-host
 *   my-host:8080/v1 -> http://my-host:8080/v1
 *   127.0.0.1:8080  -> http://127.0.0.1:8080
 *   [::1]:8080      -> http://[::1]:8080
 *   https://x/v1    -> unchanged
 * Non-HTTP schemes are left untouched so validation can reject them.
 */
export function normalizeBaseUrl(value: string): string {
	let raw = String(value ?? "").trim();
	if (!raw) return "";
	if (raw.startsWith("//")) {
		raw = `http:${raw}`;
	} else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		// Bare IPv6 literal (more than one colon, not bracketed) needs brackets.
		if (!raw.startsWith("[") && (raw.match(/:/g)?.length ?? 0) > 1) raw = `http://[${raw}]`;
		else raw = `http://${raw}`;
	}
	try {
		return new URL(raw).toString().replace(/\/+$/, "");
	} catch {
		return raw.replace(/\/+$/, "");
	}
}

/** Two references point at the same specialist when names or slugs match. */
export function sameReference(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase() || slugify(a) === slugify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string") out[key] = raw;
		else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
	}
	return out;
}

function asProtocol(value: unknown, type: string): ProtocolId {
	const candidate = asString(value) as ProtocolId | undefined;
	if (candidate && PROTOCOLS.includes(candidate)) return candidate;
	const info = findType(type);
	return info?.protocol ?? "openai-chat";
}

function asAuth(value: unknown, apiKey: string | undefined): SpecialistAuth {
	if (isRecord(value)) {
		const rawType = asString(value.type) as AuthType | undefined;
		const type: AuthType =
			rawType && ["bearer", "header", "query", "basic", "none"].includes(rawType)
				? rawType
				: apiKey
					? "bearer"
					: "none";
		const auth: SpecialistAuth = { type };
		if (asString(value.headerName)) auth.headerName = asString(value.headerName);
		if (asString(value.queryName)) auth.queryName = asString(value.queryName);
		if (typeof value.prefix === "string") auth.prefix = value.prefix;
		if (asString(value.username)) auth.username = asString(value.username);
		return auth;
	}
	return { type: apiKey ? "bearer" : "none" };
}

function uniqueReferences(values: string[], exclude: string[] = []): string[] {
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		if (exclude.some((other) => sameReference(trimmed, other))) continue;
		if (out.some((other) => sameReference(trimmed, other))) continue;
		out.push(trimmed);
	}
	return out;
}

/** Coerce one raw JSON entry into a full Specialist (safe, no validation). */
export function normalizeSpecialist(raw: unknown, index = 0): Specialist {
	const obj = isRecord(raw) ? raw : {};
	const type = canonicalType(asString(obj.type) ?? "text-generation");
	const legacyId = asString(obj.id);
	const name = asString(obj.name) ?? legacyId ?? `specialist-${index + 1}`;
	const apiKey = asString(obj.apiKey);
	const protocol = asProtocol(obj.protocol, type);
	const timeoutRaw = Number(obj.timeoutMs);
	const timeoutMs =
		Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000 && timeoutRaw <= 1_800_000
			? Math.round(timeoutRaw)
			: DEFAULT_TIMEOUT_MS;
	// Keep out-of-range values so validation reports them instead of silently
	// substituting a default (and then saving something the user did not type).
	const waitProvided = obj.waitMs !== undefined && obj.waitMs !== null;
	const waitRaw = waitProvided ? Number(obj.waitMs) : DEFAULT_WAIT_MS;
	const waitMs = Number.isFinite(waitRaw) ? Math.round(waitRaw) : Number.NaN;
	const portProvided = obj.port !== undefined && obj.port !== null;
	const portRaw = portProvided ? Number(obj.port) : undefined;
	const port = portRaw === undefined ? undefined : Number.isFinite(portRaw) ? Math.round(portRaw) : Number.NaN;

	// Legacy configs had a separate id. When it differs from the name it
	// becomes an alias so old tool calls and saved snippets keep working.
	const aliases = uniqueReferences(
		[...(Array.isArray(obj.aliases) ? obj.aliases.filter((a): a is string => typeof a === "string") : []), ...(legacyId ? [legacyId] : [])],
		[name],
	);

	return {
		name,
		...(aliases.length > 0 ? { aliases } : {}),
		type,
		protocol,
		enabled: obj.enabled === undefined ? true : obj.enabled !== false,
		baseUrl: normalizeBaseUrl(asString(obj.baseUrl) ?? PROTOCOL_DEFAULT_BASE_URL[protocol] ?? ""),
		...(port !== undefined ? { port } : {}),
		path: asString(obj.path),
		model: asString(obj.model),
		apiKey,
		auth: asAuth(obj.auth, apiKey),
		headers: stringMap(obj.headers),
		query: stringMap(obj.query),
		body: isRecord(obj.body) ? { ...obj.body } : {},
		timeoutMs,
		waitMs,
		budget: normalizeBudget(obj.budget),
		notes: asString(obj.notes),
	};
}

/** Coerce a raw JSON document into a valid-shaped config (no validation). */
export function normalizeConfig(raw: unknown): SpecialistsConfig {
	const obj = isRecord(raw) ? raw : {};
	const list = Array.isArray(obj.specialists) ? obj.specialists : [];
	return {
		version: 1,
		enabled: obj.enabled === undefined ? true : obj.enabled !== false,
		outputDir: asString(obj.outputDir),
		specialists: list.map((entry, index) => normalizeSpecialist(entry, index)),
	};
}

/** Validation errors for one specialist (empty array = valid). */
export function validateSpecialist(spec: Specialist, all: Specialist[] = []): string[] {
	const errors: string[] = [];
	const label = spec.name || "(unnamed)";
	if (!spec.name || spec.name.length > 80 || /[\u0000-\u001f\u007f]/.test(spec.name)) {
		errors.push(`invalid name: "${spec.name}" (1–80 characters, no control characters)`);
	}
	const sameName = all.filter((other) => other !== spec && sameReference(other.name, spec.name));
	if (sameName.length > 0) {
		errors.push(`duplicate name: "${spec.name}" (already used by "${sameName[0].name}")`);
	}
	for (const alias of spec.aliases ?? []) {
		if (sameReference(alias, spec.name)) {
			errors.push(`redundant alias: "${alias}" is the name itself`);
			continue;
		}
		const clash = all.find(
			(other) =>
				other !== spec &&
				(sameReference(other.name, alias) || (other.aliases ?? []).some((candidate) => sameReference(candidate, alias))),
		);
		if (clash) errors.push(`alias "${alias}" is already used by "${clash.name}"`);
	}
	if (!findType(spec.type)) {
		errors.push(`unknown type: "${spec.type}" (not in the Hugging Face task catalog)`);
	}
	if (!PROTOCOLS.includes(spec.protocol)) {
		errors.push(`unknown protocol: "${spec.protocol}"`);
	}
	if (!spec.baseUrl) {
		errors.push("baseUrl is required");
	} else {
		try {
			const url = new URL(spec.baseUrl);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				errors.push(`baseUrl must be http(s): "${spec.baseUrl}"`);
			}
		} catch {
			errors.push(`baseUrl is not a valid URL: "${spec.baseUrl}"`);
		}
	}
	if (spec.port !== undefined && (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65_535)) {
		errors.push(`port must be an integer between 1 and 65535 (got: ${spec.port})`);
	}
	if ((spec.protocol === "hf-inference" || spec.protocol === "replicate") && !spec.model) {
		errors.push(`protocol ${spec.protocol} requires "model"`);
	}
	if (spec.auth.type === "header" && !spec.auth.headerName) spec.auth.headerName = "X-API-Key";
	if (spec.auth.type === "query" && !spec.auth.queryName) spec.auth.queryName = "api_key";
	if (spec.auth.type === "basic" && !spec.auth.username) {
		errors.push('auth "basic" requires username');
	}
	if (!(spec.timeoutMs >= 1_000 && spec.timeoutMs <= 1_800_000)) {
		errors.push("timeoutMs must be between 1000 and 1800000");
	}
	if (!(spec.waitMs >= 0 && spec.waitMs <= MAX_WAIT_MS)) {
		errors.push(`waitMs must be between 0 and ${MAX_WAIT_MS}`);
	}
	errors.push(...validateBudget(spec.budget));
	if (errors.length > 0 && !label) errors.unshift("specialist without a name");
	return errors;
}

export function validateConfig(config: SpecialistsConfig): string[] {
	const errors: string[] = [];
	config.specialists.forEach((spec, index) => {
		for (const error of validateSpecialist(spec, config.specialists)) {
			errors.push(`#${index + 1} ${spec.name || "(unnamed)"}: ${error}`);
		}
	});
	return errors;
}

/** Read and normalize the config file. Never throws: returns defaults + warnings. */
export function loadConfigFile(path = configFilePath()): LoadedConfig {
	const warnings: string[] = [];
	if (!existsSync(path)) {
		return { config: defaultConfig(), path, warnings };
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const config = normalizeConfig(raw);
		for (const error of validateConfig(config)) warnings.push(error);
		return { config, path, warnings };
	} catch (error) {
		warnings.push(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return { config: defaultConfig(), path, warnings };
	}
}

/** Atomically write the config with owner-only permissions. */
export function saveConfigFile(config: SpecialistsConfig, path = configFilePath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// best effort on filesystems without chmod
	}
	renameSync(tmp, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// best effort
	}
}

export function fileMode(path: string): number | undefined {
	try {
		return statSync(path).mode & 0o777;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a secret reference:
 *   env:NAME  -> process.env.NAME
 *   file:path -> trimmed file contents (~ is expanded)
 *   other     -> the literal value
 * Returns undefined when the reference is empty or cannot be resolved.
 */
export function resolveApiKey(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const value = ref.trim();
	if (!value) return undefined;
	if (value.startsWith("env:")) {
		const name = value.slice(4).trim();
		return name ? process.env[name] || undefined : undefined;
	}
	if (value.startsWith("file:")) {
		let path = value.slice(5).trim();
		if (path === "~") path = homedir();
		else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
		if (!isAbsolute(path)) path = resolvePath(path);
		try {
			const raw = readFileSync(path, "utf-8").trim();
			return raw || undefined;
		} catch {
			return undefined;
		}
	}
	return value;
}

/** Mask a secret for display. Never returns the full value. */
export function maskApiKey(ref: string | undefined): string {
	if (!ref) return "(no API key)";
	if (ref.startsWith("env:") || ref.startsWith("file:")) return ref;
	if (ref.length <= 8) return "••••••••";
	return `${ref.slice(0, 3)}…${ref.slice(-4)}`;
}

/**
 * Resolve a user reference to a configured specialist:
 *   - name, slug(name) or alias (case-insensitive)
 *   - canonical type or alias (e.g. "ocr"); when several match, an enabled one wins
 *   - "auto" -> first enabled specialist
 */
export function resolveSpecialist(
	config: SpecialistsConfig,
	ref: string | undefined,
): { specialist?: Specialist; error?: string } {
	if (!ref || ref === "auto") {
		const first = config.specialists.find((spec) => spec.enabled);
		return first ? { specialist: first } : { error: "no enabled specialists configured" };
	}
	const key = ref.trim();
	const byName = config.specialists.filter(
		(spec) =>
			sameReference(spec.name, key) || (spec.aliases ?? []).some((alias) => sameReference(alias, key)),
	);
	if (byName.length === 1) return { specialist: byName[0] };
	if (byName.length > 1) {
		return {
			error: `"${ref}" matches several specialists: ${byName.map((spec) => spec.name).join(", ")} — use the exact name`,
		};
	}

	const type = canonicalType(ref);
	const byType = config.specialists.filter((spec) => canonicalType(spec.type) === type);
	if (byType.length === 1) return { specialist: byType[0] };
	const enabled = byType.filter((spec) => spec.enabled);
	if (enabled.length === 1) return { specialist: enabled[0] };
	if (enabled.length > 1) {
		return {
			error: `several specialists of type "${type}": ${enabled.map((spec) => spec.name).join(", ")} — specify the name`,
		};
	}
	if (byType.length > 1) {
		return {
			error: `all specialists of type "${type}" are disabled: ${byType.map((spec) => spec.name).join(", ")}`,
		};
	}
	return {
		error: `specialist "${ref}" does not exist. Configured: ${
			config.specialists.map((spec) => spec.name).join(", ") || "(none)"
		}`,
	};
}

/** Enabled specialists, optionally filtered by type/alias. */
export function enabledSpecialists(config: SpecialistsConfig, type?: string): Specialist[] {
	const wanted = type ? canonicalType(type) : undefined;
	return config.specialists.filter(
		(spec) => spec.enabled && (!wanted || canonicalType(spec.type) === wanted),
	);
}

/** Effective endpoint URL with the optional port applied. */
export function specialistTarget(spec: Pick<Specialist, "baseUrl" | "port">): string {
	if (!spec.baseUrl) return "(no URL)";
	if (!spec.port) return spec.baseUrl;
	try {
		const url = new URL(spec.baseUrl);
		url.port = String(spec.port);
		return url.toString().replace(/\/$/, "");
	} catch {
		return `${spec.baseUrl}:${spec.port}`;
	}
}

/** One-line summary used by /specialists status and the config menu. */
export function describeSpecialist(spec: Specialist): string {
	const state = spec.enabled ? "✅" : "⛔";
	return `${state} ${spec.name} — ${spec.type} · ${spec.protocol} · ${specialistTarget(spec)}${
		spec.model ? ` · ${spec.model}` : ""
	}${spec.aliases?.length ? ` · alias: ${spec.aliases.join(", ")}` : ""}`;
}
