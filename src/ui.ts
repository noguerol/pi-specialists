/**
 * `/specialists config` interactive menu.
 *
 * Built on pi's native dialogs (`ctx.ui.select`, `input`, `confirm`,
 * `editor`), so it works in the TUI and over RPC. The menu edits the shared
 * config object and calls `deps.save()` after each change; `deps.save()`
 * validates, writes, reads the file back and returns false with a notification
 * when anything fails.
 *
 * UX notes:
 *   - `ctx.ui.input` ignores the placeholder argument in current pi versions,
 *     so every default/current value is shown in the dialog *title*.
 *   - Cancelling any step of the add wizard warns explicitly; it never fails
 *     silently.
 *   - Protocol requirements (a model for hf-inference/replicate, a valid URL)
 *     are enforced inline, before the final save.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeBudget } from "./budget-types.ts";
import {
	PROTOCOL_DEFAULT_BASE_URL,
	PROTOCOL_LABELS,
	PROTOCOLS,
	findType,
	typesByFamily,
	type ProtocolId,
	type SpecialistTypeInfo,
} from "./catalog.ts";
import {
	DEFAULT_WAIT_MS,
	MAX_WAIT_MS,
	describeSpecialist,
	maskApiKey,
	normalizeBaseUrl,
	normalizeSpecialist,
	sameReference,
	specialistTarget,
	validateSpecialist,
	type Specialist,
	type SpecialistsConfig,
} from "./config.ts";
import { executeSpecialist } from "./execute.ts";

export interface ConfigMenuDeps {
	getConfig(): SpecialistsConfig;
	/** Validate + persist + verify. Returns true only when the file was written. */
	save(): boolean;
	/** Re-render status/tool activation after a successful save. */
	refresh(): void;
	/** Human-readable diagnostics (path, permissions, disk vs memory). */
	doctor(): string;
	configPath: string;
}

const BACK = "↩ Back";
const CLOSE = "✅ Close";
const MODEL_REQUIRED: ProtocolId[] = ["hf-inference", "replicate"];

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, type);
}

function cancelled(ctx: ExtensionContext, what: string): false {
	notify(ctx, `${what} cancelled: nothing was added or changed.`, "info");
	return false;
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

async function choose<T>(
	ctx: ExtensionContext,
	title: string,
	items: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const labels = items.map((item) => item.label);
	const picked = await ctx.ui.select(title, labels);
	if (picked === undefined) return undefined;
	const index = labels.indexOf(picked);
	if (index < 0) {
		notify(ctx, `Unrecognised selection: "${picked}". Nothing was changed.`, "warning");
		return undefined;
	}
	return items[index].value;
}

/** Free-form input. The caller must show defaults in `title`. */
async function ask(ctx: ExtensionContext, title: string): Promise<string | undefined> {
	const value = await ctx.ui.input(title);
	return value === undefined ? undefined : value.trim();
}

async function askRequired(
	ctx: ExtensionContext,
	title: string,
	validate: (value: string) => string | undefined,
): Promise<string | undefined> {
	for (;;) {
		const value = await ask(ctx, title);
		if (value === undefined) return undefined;
		const problem = validate(value);
		if (!problem) return value;
		notify(ctx, problem, "warning");
	}
}

/** Ask for an editable value: Esc keeps, empty keeps, "-" clears. */
async function editValue(ctx: ExtensionContext, label: string, current: string | undefined): Promise<string | undefined> {
	const shown = current || "—";
	const value = await ask(ctx, `${label} [${shown}] (empty = keep, "-" = clear)`);
	if (value === undefined) return current;
	if (value === "-") return "";
	if (value === "") return current ?? "";
	return value;
}

async function chooseType(
	ctx: ExtensionContext,
	current?: SpecialistTypeInfo,
): Promise<SpecialistTypeInfo | undefined> {
	const groups = typesByFamily();
	// Keep the current family/type first so navigating back lands on what was
	// already selected.
	if (current) {
		const index = groups.findIndex((group) => group.family === current.family);
		if (index > 0) groups.unshift(groups.splice(index, 1)[0]);
	}
	// Two-level menu: Esc in the type list returns to the family list; Esc in
	// the family list leaves the type selection (the caller decides what that
	// means: cancel the wizard or keep editing).
	while (true) {
		const family = await choose(
			ctx,
			"Specialist family",
			groups.map((group) => ({
				label: `${group.family} (${group.types.length})`,
				value: group.family,
			})),
		);
		if (!family) return undefined;
		const group = groups.find((entry) => entry.family === family);
		if (!group) continue;
		const types = [...group.types];
		if (current && current.family === group.family) {
			const index = types.findIndex((info) => info.id === current.id);
			if (index > 0) types.unshift(types.splice(index, 1)[0]);
		}
		const type = await choose(
			ctx,
			`Type — ${family} (Esc returns to families)`,
			types.map((info) => ({
				label: `${info.emoji} ${info.id} — ${info.label}`,
				value: info,
			})),
		);
		if (!type) continue;
		return type;
	}
}

async function chooseProtocol(ctx: ExtensionContext, current: ProtocolId): Promise<ProtocolId | undefined> {
	const ordered = [current, ...PROTOCOLS.filter((protocol) => protocol !== current)];
	return choose(
		ctx,
		"HTTP protocol",
		ordered.map((protocol) => ({
			label: `${protocol} — ${PROTOCOL_LABELS[protocol]}`,
			value: protocol,
		})),
	);
}

async function configureAuth(ctx: ExtensionContext, spec: Specialist): Promise<boolean> {
	const options = [
		{ label: "No API key", value: "none" as const },
		{ label: "Bearer token (Authorization: Bearer ...)", value: "bearer" as const },
		{ label: "Custom header (e.g. X-API-Key)", value: "header" as const },
		{ label: "Query parameter (e.g. ?api_key=...)", value: "query" as const },
		{ label: "Basic auth (username + key)", value: "basic" as const },
	];
	const current = spec.auth?.type ?? (spec.apiKey ? "bearer" : "none");
	const currentIndex = options.findIndex((option) => option.value === current);
	if (currentIndex > 0) options.unshift(options.splice(currentIndex, 1)[0]);
	const choice = await choose(ctx, "Authentication (Esc goes back)", options);
	if (!choice) return false;
	if (choice === "none") {
		spec.apiKey = undefined;
		spec.auth = { type: "none" };
		return true;
	}
	const key = await ask(
		ctx,
		`API key [${spec.apiKey ? maskApiKey(spec.apiKey) : "none"}] (literal, env:VAR or file:/path; empty = keep)`,
	);
	if (key === undefined) return false;
	if (key !== "") spec.apiKey = key;
	spec.auth = { type: choice };
	if (choice === "header") {
		const headerName = await ask(ctx, `Header name [${spec.auth?.headerName ?? "X-API-Key"}]`);
		if (headerName === undefined) return false;
		if (headerName) spec.auth.headerName = headerName;
	}
	if (choice === "query") {
		const queryName = await ask(ctx, `Parameter name [${spec.auth?.queryName ?? "api_key"}]`);
		if (queryName === undefined) return false;
		if (queryName) spec.auth.queryName = queryName;
	}
	if (choice === "basic") {
		const username = await ask(ctx, `Username [${spec.auth?.username ?? "user"}]`);
		if (username === undefined) return false;
		if (username) spec.auth.username = username;
	}
	return true;
}

type WizardOutcome = "next" | "back" | "cancel";

interface AddDraft {
	type: SpecialistTypeInfo;
	name: string;
	protocol: ProtocolId;
	baseUrl: string;
	port?: number;
	model?: string;
	waitMs: number;
	apiKey?: string;
	auth: Specialist["auth"];
	enabled: boolean;
}

/**
 * Add wizard with real back navigation: Esc in a step returns to the previous
 * step (keeping what was already entered); Esc in the first step (type/family)
 * cancels the wizard and returns to the config menu.
 */
async function addSpecialist(ctx: ExtensionContext, config: SpecialistsConfig, deps: ConfigMenuDeps): Promise<boolean> {
	const info = await chooseType(ctx);
	if (!info) return cancelled(ctx, "Add specialist");

	const draft: AddDraft = {
		type: info,
		name: info.id,
		protocol: info.protocol,
		baseUrl: PROTOCOL_DEFAULT_BASE_URL[info.protocol],
		waitMs: DEFAULT_WAIT_MS,
		auth: { type: "none" },
		enabled: true,
	};

	const steps: Array<() => Promise<WizardOutcome>> = [
		// 0. type (only reached again when going back from step 1)
		async () => {
			const picked = await chooseType(ctx, draft.type);
			if (!picked) return "cancel";
			if (picked.id !== draft.type.id) {
				draft.type = picked;
				draft.protocol = picked.protocol;
				draft.baseUrl = PROTOCOL_DEFAULT_BASE_URL[picked.protocol];
				draft.model = undefined;
			}
			return "next";
		},

		// 1. name (the unique reference)
		async () => {
			const value = await askRequired(
				ctx,
				`Specialist name [${draft.name || draft.type.id}] (unique; used to reference it)`,
				(input) => {
					const candidate = input || draft.name || draft.type.id;
					if (!candidate.trim()) return "The name cannot be empty.";
					if (config.specialists.some((spec) => sameReference(spec.name, candidate))) {
						return `A specialist named "${candidate}" already exists. Use another name.`;
					}
					return undefined;
				},
			);
			if (value === undefined) return "back";
			draft.name = value || draft.name || draft.type.id;
			return "next";
		},

		// 2. protocol
		async () => {
			const protocol = await chooseProtocol(ctx, draft.protocol);
			if (!protocol) return "back";
			if (protocol !== draft.protocol) {
				draft.protocol = protocol;
				if (!draft.baseUrl) draft.baseUrl = PROTOCOL_DEFAULT_BASE_URL[protocol];
			}
			return "next";
		},

		// 3. base URL (scheme optional: "my-host:8080" works)
		async () => {
			const fallback = normalizeBaseUrl(draft.baseUrl || PROTOCOL_DEFAULT_BASE_URL[draft.protocol]);
			const value = await askRequired(
				ctx,
				`Base URL [${fallback}] (localhost, host:port or URL; http:// is optional)`,
				(input) => {
					const candidate = normalizeBaseUrl(input || fallback);
					return isValidHttpUrl(candidate) ? undefined : `Invalid URL: "${input || fallback}".`;
				},
			);
			if (value === undefined) return "back";
			draft.baseUrl = normalizeBaseUrl(value || fallback);
			return "next";
		},

		// 4. port
		async () => {
			const value = await askRequired(
				ctx,
				`Port [${draft.port ?? "from the URL"}] (empty = keep, "-" = clear)`,
				(input) => {
					if (!input || input === "-") return undefined;
					const parsed = Number(input);
					return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535
						? undefined
						: `Invalid port: "${input}" (integer 1-65535).`;
				},
			);
			if (value === undefined) return "back";
			if (value === "-") draft.port = undefined;
			else if (value !== "") draft.port = Number(value);
			return "next";
		},

		// 5. model
		async () => {
			const requiresModel = MODEL_REQUIRED.includes(draft.protocol);
			const value = await askRequired(
				ctx,
				requiresModel
					? `Model (REQUIRED for ${draft.protocol}; e.g. "owner/model" or the model id)`
					: `Model [${draft.model ?? "optional"}] (e.g. my-vision-model, gpt-image-1)`,
				(input) => {
					const candidate = input || draft.model || "";
					return requiresModel && !candidate ? `Protocol ${draft.protocol} needs a model.` : undefined;
				},
			);
			if (value === undefined) return "back";
			draft.model = value || draft.model || undefined;
			return "next";
		},

		// 6. inline wait
		async () => {
			const value = await askRequired(
				ctx,
				`Inline wait in ms [${draft.waitMs}] (0 = return a job immediately, no blocking)`,
				(input) => {
					if (!input) return undefined;
					const parsed = Number(input);
					return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_WAIT_MS
						? undefined
						: `Invalid wait: "${input}" (0-${MAX_WAIT_MS} ms).`;
				},
			);
			if (value === undefined) return "back";
			draft.waitMs = value ? Number(value) : draft.waitMs;
			return "next";
		},

		// 7. auth
		async () => {
			const temp = normalizeSpecialist({
				name: draft.name,
				type: draft.type.id,
				protocol: draft.protocol,
				baseUrl: draft.baseUrl,
				port: draft.port,
				model: draft.model,
				apiKey: draft.apiKey,
				auth: draft.auth,
				waitMs: draft.waitMs,
			});
			if (!(await configureAuth(ctx, temp))) return "back";
			draft.apiKey = temp.apiKey;
			draft.auth = temp.auth;
			return "next";
		},

		// 8. enabled
		async () => {
			const options = [
				{ label: "✅ Yes, available", value: true },
				{ label: "⛔ No, leave it disabled", value: false },
			];
			const current = options.findIndex((option) => option.value === draft.enabled);
			if (current > 0) options.unshift(options.splice(current, 1)[0]);
			const enabled = await choose(ctx, "Enable now?", options);
			if (enabled === undefined) return "back";
			draft.enabled = enabled;
			return "next";
		},
	];

	// The type was already chosen before the draft existed; step 0 only runs
	// again when the user walks back from the name step.
	let step = 1;
	while (step < steps.length) {
		const outcome = await steps[step]();
		if (outcome === "cancel") return cancelled(ctx, "Add specialist");
		if (outcome === "back") {
			if (step === 0) return cancelled(ctx, "Add specialist");
			step--;
			continue;
		}
		step++;
	}

	const spec = normalizeSpecialist({
		name: draft.name,
		type: draft.type.id,
		protocol: draft.protocol,
		baseUrl: draft.baseUrl,
		port: draft.port,
		model: draft.model,
		waitMs: draft.waitMs,
		apiKey: draft.apiKey,
		auth: draft.auth,
		enabled: draft.enabled,
	});
	const errors = validateSpecialist(spec, config.specialists);
	if (errors.length > 0) {
		notify(ctx, `"${draft.name}" was not added:\n${errors.join("\n")}`, "error");
		return false;
	}
	config.specialists.push(spec);
	if (!deps.save()) {
		config.specialists = config.specialists.filter((entry) => entry !== spec);
		notify(ctx, `"${spec.name}" was not added: could not write ${deps.configPath}. Run /specialists doctor.`, "error");
		return false;
	}
	deps.refresh();
	notify(
		ctx,
		`Added ${findType(spec.type)?.emoji ?? ""} ${spec.name} (${spec.type} → ${specialistTarget(spec)}). Saved to ${deps.configPath}.`,
	);
	return true;
}

async function editSpecialist(ctx: ExtensionContext, config: SpecialistsConfig, deps: ConfigMenuDeps): Promise<boolean> {
	// Two-level navigation: Esc/«Volver» in the field list returns to the
	// specialist list; Esc in the specialist list returns to the main menu.
	while (true) {
		const spec = await choose(
			ctx,
			"Edit specialist",
			config.specialists.map((entry) => ({
				label: `${findType(entry.type)?.emoji ?? "🧩"} ${entry.enabled ? "✅" : "⛔"} ${entry.name} — ${entry.type}`,
				value: entry,
			})),
		);
		if (!spec) return false;

		while (true) {
		const options: Array<{ label: string; value: string }> = [
			{ label: `Name: ${spec.name}`, value: "name" },
			{ label: `Type: ${spec.type}`, value: "type" },
			{ label: `Protocol: ${spec.protocol}`, value: "protocol" },
			{ label: `Base URL: ${spec.baseUrl}`, value: "baseUrl" },
			{ label: `Port: ${spec.port ?? "(from URL)"}`, value: "port" },
			{ label: `Path: ${spec.path ?? "(default)"}`, value: "path" },
			{ label: `Model: ${spec.model ?? "(none)"}`, value: "model" },
			{ label: `API key: ${maskApiKey(spec.apiKey)}`, value: "apiKey" },
			{ label: `Authentication: ${spec.auth.type}`, value: "auth" },
			{ label: `Headers: ${Object.keys(spec.headers).length}`, value: "headers" },
			{ label: `Query params: ${Object.keys(spec.query).length}`, value: "query" },
			{ label: `Extra body: ${Object.keys(spec.body).length} keys`, value: "body" },
			{ label: `Timeout HTTP: ${spec.timeoutMs} ms`, value: "timeout" },
			{ label: `Inline wait: ${spec.waitMs} ms`, value: "waitMs" },
			{ label: `Budget: ${spec.budget ? JSON.stringify(spec.budget) : "(auto)"}`, value: "budget" },
			{ label: `Notes: ${spec.notes ?? "(none)"}`, value: "notes" },
			{ label: `Enabled: ${spec.enabled ? "✅ yes" : "⛔ no"}`, value: "enabled" },
			{ label: BACK, value: "back" },
		];
		const field = await choose(ctx, `${spec.name} — edit (Esc returns to the list)`, options);
		if (!field || field === "back") break;

		switch (field) {
			case "name": {
				const value = await editValue(ctx, "Name", spec.name);
				if (value === undefined) break;
				const next = value.trim();
				if (!next) {
					notify(ctx, "The name cannot be empty.", "error");
					break;
				}
				if (config.specialists.some((other) => other !== spec && sameReference(other.name, next))) {
					notify(ctx, `A specialist named "${next}" already exists.`, "error");
					break;
				}
				if (!sameReference(next, spec.name)) {
					// Keep the old reference working after a rename.
					spec.aliases = [...new Set([...(spec.aliases ?? []), spec.name])].filter(
						(alias) => !sameReference(alias, next),
					);
					spec.name = next;
				}
				break;
			}
			case "type": {
				const info = await chooseType(ctx, findType(spec.type));
				if (info) spec.type = info.id;
				break;
			}
			case "protocol": {
				const protocol = await chooseProtocol(ctx, spec.protocol);
				if (protocol) {
					spec.protocol = protocol;
					if (!spec.baseUrl) spec.baseUrl = PROTOCOL_DEFAULT_BASE_URL[protocol];
				}
				break;
			}
			case "baseUrl": {
				const value = await editValue(ctx, "Base URL", spec.baseUrl);
				if (value !== undefined) {
					const normalized = normalizeBaseUrl(value);
					if (!normalized || !isValidHttpUrl(normalized)) notify(ctx, `Invalid URL: "${value}"`, "error");
					else spec.baseUrl = normalized;
				}
				break;
			}
			case "port": {
				const value = await editValue(ctx, "Port", spec.port !== undefined ? String(spec.port) : undefined);
				if (value === undefined) break;
				if (value === "") {
					spec.port = undefined;
					break;
				}
				const parsed = Number(value);
				if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) spec.port = parsed;
				else notify(ctx, `Invalid port: "${value}" (integer 1-65535).`, "error");
				break;
			}
			case "path": {
				const value = await editValue(ctx, "Endpoint path", spec.path);
				if (value !== undefined) spec.path = value || undefined;
				break;
			}
			case "model": {
				const value = await editValue(ctx, "Model", spec.model);
				if (value !== undefined) spec.model = value || undefined;
				break;
			}
			case "apiKey": {
				const value = await editValue(ctx, "API key (literal, env:VAR or file:/path)", spec.apiKey);
				if (value !== undefined) {
					spec.apiKey = value || undefined;
					if (spec.apiKey && spec.auth.type === "none") spec.auth = { type: "bearer" };
				}
				break;
			}
			case "auth": {
				if (!(await configureAuth(ctx, spec))) notify(ctx, "Authentication unchanged.", "info");
				break;
			}
			case "headers":
			case "query": {
				const current = field === "headers" ? spec.headers : spec.query;
				const edited = await ctx.ui.editor(
					`${field === "headers" ? "Headers" : "Query params"} (JSON object)`,
					JSON.stringify(current, null, 2),
				);
				if (edited !== undefined) {
					try {
						const parsed = JSON.parse(edited || "{}");
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
						const clean: Record<string, string> = {};
						for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) clean[key] = String(value);
						if (field === "headers") spec.headers = clean;
						else spec.query = clean;
					} catch (error) {
						notify(ctx, `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				break;
			}
			case "body": {
				const edited = await ctx.ui.editor("Extra body (JSON object)", JSON.stringify(spec.body, null, 2));
				if (edited !== undefined) {
					try {
						const parsed = JSON.parse(edited || "{}");
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
						spec.body = parsed as Record<string, unknown>;
					} catch (error) {
						notify(ctx, `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				break;
			}
			case "budget": {
				const edited = await ctx.ui.editor(
					"Budget (JSON; empty = auto-discover from the server)",
					JSON.stringify(spec.budget ?? {}, null, 2),
				);
				if (edited !== undefined) {
					try {
						const parsed = JSON.parse(edited || "{}");
						spec.budget = normalizeBudget(parsed);
					} catch (error) {
						notify(ctx, `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				break;
			}
			case "waitMs": {
				const value = await ask(ctx, `Inline wait in ms [${spec.waitMs}] (0-${MAX_WAIT_MS}; 0 = always background)`);
				if (value !== undefined && value !== "") {
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_WAIT_MS) spec.waitMs = Math.round(parsed);
					else notify(ctx, `Invalid wait (0-${MAX_WAIT_MS} ms).`, "error");
				}
				break;
			}
			case "timeout": {
				const value = await ask(ctx, `Timeout HTTP en ms [${spec.timeoutMs}] (1000–1800000)`);
				if (value !== undefined && value !== "") {
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 1_800_000) spec.timeoutMs = Math.round(parsed);
					else notify(ctx, "Timeout must be between 1000 and 1800000 ms.", "error");
				}
				break;
			}
			case "notes": {
				const value = await editValue(ctx, "Notes", spec.notes);
				if (value !== undefined) spec.notes = value || undefined;
				break;
			}
			case "enabled": {
				spec.enabled = !spec.enabled;
				break;
			}
		}

		const errors = validateSpecialist(spec, config.specialists);
		if (errors.length > 0) {
			notify(ctx, `Changes not saved:\n${errors.join("\n")}`, "error");
			continue;
		}
		if (deps.save()) deps.refresh();
		}
	}
}

async function toggleSpecialist(ctx: ExtensionContext, config: SpecialistsConfig, deps: ConfigMenuDeps): Promise<void> {
	const spec = await choose(
		ctx,
		"Enable / disable",
		config.specialists.map((entry) => ({
			label: `${findType(entry.type)?.emoji ?? "🧩"} ${entry.enabled ? "✅ enabled" : "⛔ disabled"} · ${entry.name}`,
			value: entry,
		})),
	);
	if (!spec) return;
	spec.enabled = !spec.enabled;
	if (deps.save()) {
		deps.refresh();
		notify(ctx, `${spec.name} ${spec.enabled ? "enabled" : "disabled"}.`);
	} else {
		spec.enabled = !spec.enabled;
	}
}

async function removeSpecialist(ctx: ExtensionContext, config: SpecialistsConfig, deps: ConfigMenuDeps): Promise<void> {
	const spec = await choose(
		ctx,
		"Delete specialist",
		config.specialists.map((entry) => ({
			label: `${findType(entry.type)?.emoji ?? "🧩"} ${entry.name} — ${entry.type}`,
			value: entry,
		})),
	);
	if (!spec) return;
	if (!(await ctx.ui.confirm("Delete specialist", `Delete "${spec.name}" (${spec.type})?`))) return;
	config.specialists = config.specialists.filter((entry) => entry !== spec);
	if (deps.save()) {
		deps.refresh();
		notify(ctx, `Deleted ${spec.name}.`);
	} else {
		// The in-memory list no longer matches the file; restore it so the menu
		// does not lie about what is persisted.
		config.specialists.push(spec);
	}
}

async function testSpecialist(ctx: ExtensionContext, config: SpecialistsConfig): Promise<void> {
	const spec = await choose(
		ctx,
		"Test specialist",
		config.specialists.map((entry) => ({
			label: `${findType(entry.type)?.emoji ?? "🧩"} ${entry.name} — ${entry.type}`,
			value: entry,
		})),
	);
	if (!spec) return;
	const prompt = await ask(ctx, "Test prompt [Hello, reply OK.]");
	if (prompt === undefined) return;
	const info = findType(spec.type);
	const wantsMedia = info?.input.some((kind) => kind === "image" || kind === "audio" || kind === "video") ?? false;
	const input = wantsMedia ? await ask(ctx, "Input file (absolute path or URL; empty = no input)") : undefined;
	notify(ctx, `Testing ${spec.name}...`);
	try {
		const result = await executeSpecialist(
			spec,
			{ prompt: prompt || "Hello, reply OK.", input: input ? [input] : [] },
			{ outputDir: config.outputDir, signal: ctx.signal },
		);
		notify(ctx, `✅ ${spec.name} (${result.outputs.length} files · ${result.details.elapsedMs ?? "?"} ms): ${result.text.slice(0, 500)}`);
	} catch (error) {
		notify(ctx, `❌ ${spec.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function viewConfig(ctx: ExtensionContext, config: SpecialistsConfig, deps: ConfigMenuDeps): void {
	const lines = [
		`Specialists ${config.enabled ? "ON" : "OFF"} · ${config.specialists.length} configured`,
		`File: ${deps.configPath}`,
		config.outputDir ? `Output: ${config.outputDir}` : "Output: /tmp/pi-specialists",
		"",
		...config.specialists.map((spec) => `${describeSpecialist(spec)} · key ${maskApiKey(spec.apiKey)}`),
	];
	notify(ctx, lines.join("\n"));
}

export async function showConfigMenu(ctx: ExtensionContext, deps: ConfigMenuDeps): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, "Interactive configuration requires TUI or RPC. Use /specialists add|remove|enable|disable.", "warning");
		return;
	}
	const config = deps.getConfig();

	while (true) {
		const title = `Specialists — ${config.specialists.length} configured · ${config.enabled ? "✅ ON" : "⛔ OFF"}`;
		const choice = await choose(ctx, title, [
			{ label: "➕ Add specialist", value: "add" },
			{ label: "✏️ Edit specialist", value: "edit" },
			{ label: "🔄 Enable / disable", value: "toggle" },
			{ label: "🗑️ Delete specialist", value: "remove" },
			{ label: "🧪 Test specialist", value: "test" },
			{ label: "📋 View configuration", value: "view" },
			{ label: "🩺 Diagnostics", value: "doctor" },
			{ label: `🔌 Extension: ${config.enabled ? "✅ enabled" : "⛔ disabled"}`, value: "master" },
			{ label: CLOSE, value: "close" },
		]);
		if (!choice || choice === "close") return;

		if (config.specialists.length === 0 && ["edit", "toggle", "remove", "test"].includes(choice)) {
			notify(ctx, 'No specialists configured yet. Use "➕ Add specialist".', "warning");
			continue;
		}

		switch (choice) {
			case "add":
				await addSpecialist(ctx, config, deps);
				break;
			case "edit":
				await editSpecialist(ctx, config, deps);
				break;
			case "toggle":
				await toggleSpecialist(ctx, config, deps);
				break;
			case "remove":
				await removeSpecialist(ctx, config, deps);
				break;
			case "test":
				await testSpecialist(ctx, config);
				break;
			case "view":
				viewConfig(ctx, config, deps);
				break;
			case "doctor":
				notify(ctx, deps.doctor());
				break;
			case "master":
				config.enabled = !config.enabled;
				if (deps.save()) {
					deps.refresh();
					notify(ctx, `Extension ${config.enabled ? "enabled" : "disabled"}.`);
				} else {
					config.enabled = !config.enabled;
				}
				break;
		}
	}
}
