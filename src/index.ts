/**
 * Specialists — a router to small, task-specific models.
 *
 * One extension, N configured specialists (OCR, vision, image/audio/video
 * generation, speech, embeddings...). Each specialist is a Hugging Face
 * pipeline tag plus a URL/port (local or remote), an optional protocol and
 * optional authentication. The configured capabilities are:
 *
 *   - advertised to the agent every turn (system prompt section)
 *   - callable through the `specialist` tool (`list|run|result|jobs`)
 *   - shown in the toolbar as `<emoji><green dot>` per active type
 *
 * Latency model: a tool call waits at most `waitMs` (default 1.5 s). If the
 * specialist finishes sooner, the result is returned inline (the normal case
 * for small local models). Otherwise the call returns a job id in milliseconds
 * and the request keeps running in the background; when it finishes, the result
 * is delivered as a `specialist-result` message for the next turn without
 * forcing a new agent run. `wait: true` blocks until completion, `wait: false`
 * always dispatches in the background.
 *
 * Commands:
 *   /specialists on|off          enable/disable the whole extension
 *   /specialists config          interactive CRUD menu
 *   /specialists status|list     summary / configured specialists
 *   /specialists add ...         add from the CLI
 *   /specialists remove|enable|disable <name>
 *   /specialists test <name> [prompt]
 *   /specialists reload          re-read specialists.json
 *   /specialists doctor          path, permissions, disk vs memory, errors
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { SPECIALIST_TYPES, defaultPromptFor, findType } from "./catalog.ts";
import {
	configFilePath,
	describeSpecialist,
	enabledSpecialists,
	fileMode,
	loadConfigFile,
	maskApiKey,
	normalizeSpecialist,
	resolveSpecialist,
	sameReference,
	saveConfigFile,
	specialistTarget,
	validateConfig,
	type Specialist,
	type SpecialistsConfig,
} from "./config.ts";
import { budgetSummary, discoverBudget } from "./budget.ts";
import { executeSpecialist, type SpecialistRunResult } from "./execute.ts";
import { runningLine, summarizeTask, type RunningInfo } from "./status.ts";

export const TOOL_NAME = "specialist";
const STATUS_KEY = "specialists";
const RUNNING_KEY = "specialists-running";
const RUNNING_REFRESH_MS = 500;
const RUNNING_LINGER_MS = 700;
const MAX_TOOL_TEXT = 24_000;
const MAX_JOBS = 32;
const JOB_TTL_MS = 10 * 60 * 1000;

interface Runtime {
	config: SpecialistsConfig;
	warnings: string[];
	path: string;
}

let runtime: Runtime = (() => {
	const loaded = loadConfigFile();
	return { config: loaded.config, warnings: loaded.warnings, path: loaded.path };
})();
let lastWarningsReported = "";

// ─── Background jobs ────────────────────────────────────────────────────────

type JobStatus = "running" | "done" | "error";

interface Job {
	id: string;
	name: string;
	type: string;
	/** Short task description shown in the running footer line. */
	summary: string;
	status: JobStatus;
	startedAt: number;
	finishedAt?: number;
	elapsedMs?: number;
	result?: SpecialistRunResult;
	error?: string;
	delivered: boolean;
	/** True once the tool returned a job id instead of the inline result. */
	background: boolean;
	/** Frozen line kept briefly for jobs too fast to be seen. */
	lingerLine?: string;
	lingerUntil?: number;
	promise: Promise<SpecialistRunResult>;
}

const jobs = new Map<string, Job>();
let jobSequence = 0;

function pruneJobs(): void {
	const now = Date.now();
	for (const [id, job] of jobs) {
		if (job.status !== "running" && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
	}
	const finished = [...jobs.values()]
		.filter((job) => job.status !== "running")
		.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
	while (jobs.size > MAX_JOBS && finished.length > 0) {
		jobs.delete(finished.shift()!.id);
	}
}

function preview(text: string, size = 180): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > size ? `${clean.slice(0, size)}…` : clean;
}

type ToolContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function resultContent(result: SpecialistRunResult, header?: string): ToolContentPart[] {
	const text = header ? `${header}\n\n${formatResult(result)}` : formatResult(result);
	const content: ToolContentPart[] = [{ type: "text", text }];
	for (const image of result.images) {
		if (image.base64) content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
	}
	return content;
}

/** Deliver a finished background job as a stored message for the next turn. */
function deliverJob(pi: ExtensionAPI, ctx: ExtensionContext, job: Job): void {
	if (job.delivered || !job.background || job.status === "running") return;
	job.delivered = true;
	const header =
		job.status === "done"
			? `✅ Specialist ${job.name} (${job.type}) · ${job.elapsedMs ?? 0} ms`
			: `❌ Specialist ${job.name} (${job.type}) after ${job.elapsedMs ?? 0} ms: ${job.error ?? "error"}`;
	const content: ToolContentPart[] =
		job.status === "done" && job.result ? resultContent(job.result, header) : [{ type: "text", text: header }];
	try {
		pi.sendMessage(
			{
				customType: "specialist-result",
				content,
				display: true,
				details: {
					jobId: job.id,
					specialist: job.name,
					type: job.type,
					status: job.status,
					elapsedMs: job.elapsedMs,
					error: job.error,
				},
			},
			// nextTurn: available to the model on its next request without
			// starting a new run or steering the current one.
			{ deliverAs: "nextTurn" },
		);
	} catch {
		// No active session (shutdown); the job stays in the registry.
	}
	try {
		ctx.ui.notify(
			job.status === "done"
				? `✅ ${job.name}: ${preview(job.result?.text ?? "(no text)")}`
				: `❌ ${job.name}: ${job.error ?? "error"}`,
			job.status === "done" ? "info" : "error",
		);
	} catch {
		// UI gone
	}
}

/**
 * Start a request in the background. The promise always resolves the job; the
 * returned promise is consumed by the tool for the inline grace period.
 */
function startJob(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	specialist: Specialist,
	request: { prompt: string; input: string[]; options?: Record<string, unknown>; output?: string },
	signal: AbortSignal | undefined,
): Job {
	pruneJobs();
	const job: Job = {
		id: `job-${++jobSequence}`,
		name: specialist.name,
		type: specialist.type,
		summary: summarizeTask(
			request.prompt || (typeof request.options?.state === "string" ? request.options.state : ""),
			request.input,
			specialist.type,
		),
		status: "running",
		startedAt: Date.now(),
		delivered: false,
		background: false,
		promise: Promise.resolve({} as SpecialistRunResult),
	};
	job.promise = executeSpecialist(
		specialist,
		{ prompt: request.prompt, input: request.input, options: request.options },
		{
			output: request.output,
			outputDir: runtime.config.outputDir,
			signal,
			onProgress: (message) => {
				job.summary = message;
				refreshStatus(ctx);
			},
		},
	)
		.then((result) => {
			job.status = "done";
			job.result = result;
			job.elapsedMs = Date.now() - job.startedAt;
			job.finishedAt = Date.now();
			keepFinishedJobVisible(job);
			refreshStatus(ctx);
			deliverJob(pi, ctx, job);
			return result;
		})
		.catch((error: unknown) => {
			job.status = "error";
			job.error = errorMessage(error);
			job.elapsedMs = Date.now() - job.startedAt;
			job.finishedAt = Date.now();
			keepFinishedJobVisible(job);
			refreshStatus(ctx);
			deliverJob(pi, ctx, job);
			throw error;
		});
	// A background job may finish after the tool call returned; never leave an
	// unhandled rejection behind.
	job.promise.catch(() => {});
	jobs.set(job.id, job);
	refreshStatus(ctx);
	return job;
}

function jobSummary(job: Job): string {
	const elapsed = job.status === "running" ? Date.now() - job.startedAt : job.elapsedMs ?? 0;
	return `${job.status === "done" ? "✅" : job.status === "error" ? "❌" : "⏳"} ${job.id} · ${job.name} (${job.type}) · ${elapsed} ms${
		job.error ? ` · ${job.error}` : ""
	}`;
}

// ─── Config / state ─────────────────────────────────────────────────────────

function reloadFromDisk(): void {
	const loaded = loadConfigFile();
	runtime = { config: loaded.config, warnings: loaded.warnings, path: loaded.path };
}

function persist(): string[] {
	const errors = validateConfig(runtime.config);
	if (errors.length > 0) return errors;
	const path = runtime.path || configFilePath();
	try {
		saveConfigFile(runtime.config, path);
	} catch (error) {
		return [`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`];
	}

	// Read the file back: a successful write call is not proof that the next
	// session will see the same specialists.
	const disk = loadConfigFile(path);
	if (disk.warnings.length > 0) {
		return [`saved file is not valid (${path}): ${disk.warnings.join(" | ")}`];
	}
	if (disk.config.specialists.length !== runtime.config.specialists.length) {
		return [
			`${path} has ${disk.config.specialists.length} specialists but ${runtime.config.specialists.length} were expected; check permissions and /specialists doctor`,
		];
	}
	const onDisk = new Set(disk.config.specialists.map((spec) => spec.name));
	const missing = runtime.config.specialists.filter((spec) => !onDisk.has(spec.name)).map((spec) => spec.name);
	if (missing.length > 0) return [`no aparecen en ${path} tras guardar: ${missing.join(", ")}`];
	return [];
}

/** Self-diagnosis shown by `/specialists doctor` and the config menu. */
function diagnostics(): string {
	const path = runtime.path || configFilePath();
	const dir = dirname(path);
	const exists = existsSync(path);
	const mode = fileMode(path);
	let writable = true;
	try {
		accessSync(dir, constants.W_OK);
	} catch {
		writable = false;
	}
	const disk = exists ? loadConfigFile(path) : undefined;
	const active = enabledSpecialists(runtime.config);
	const withKey = runtime.config.specialists.filter((spec) => spec.apiKey).length;
	const validation = validateConfig(runtime.config);
	const running = [...jobs.values()].filter((job) => job.status === "running").length;
	const lines = [
		`Extension: ${runtime.config.enabled ? "ON" : "OFF"}`,
		`Config: ${path}`,
		`File: ${exists ? `exists${mode !== undefined ? ` (mode ${mode.toString(8).padStart(3, "0")})` : ""}` : "does not exist yet"}`,
		`Directory writable: ${writable ? "yes" : "NO — check permissions of " + dir}`,
		`In memory: ${runtime.config.specialists.length} (${active.length} enabled) · on disk: ${disk ? disk.config.specialists.length : "—"}`,
		`API keys configured: ${withKey} · running jobs: ${running}`,
	];
	if (disk?.warnings.length) lines.push(`File warnings: ${disk.warnings.join(" | ")}`);
	if (validation.length) lines.push(`Validation errors: ${validation.join(" | ")}`);
	if (!writable || validation.length > 0) lines.push("Hint: fix the issue and run /specialists reload.");
	return lines.join("\n");
}

function statusText(ctx: ExtensionContext): string {
	const theme = ctx.ui.theme;
	if (!runtime.config.enabled) return theme.fg("dim", "⏸️ specialists off");
	const active = enabledSpecialists(runtime.config);
	if (active.length === 0) return theme.fg("muted", "🧩 specialists: 0");
	const counts = new Map<string, number>();
	for (const spec of active) {
		const emoji = findType(spec.type)?.emoji ?? "🧩";
		counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
	}
	const dot = theme.fg("success", "●");
	const parts = [...counts.entries()].map(([emoji, count]) => `${emoji}${dot}${count > 1 ? `×${count}` : ""}`);
	return parts.join(" ");
}

function runningJobs(): Job[] {
	return [...jobs.values()]
		.filter((job) => job.status === "running")
		.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Keep the line on screen for a minimum time when a job finishes faster than
 * the first repaint. Long jobs clear immediately.
 */
function keepFinishedJobVisible(job: Job): void {
	const elapsed = job.elapsedMs ?? 0;
	if (elapsed >= RUNNING_LINGER_MS) return;
	const finishedAt = job.finishedAt ?? Date.now();
	job.lingerLine = runningLine(
		[{ name: job.name, type: job.type, summary: job.summary, startedAt: finishedAt - elapsed }],
		finishedAt,
	);
	job.lingerUntil = Date.now() + (RUNNING_LINGER_MS - elapsed);
}

function activeRunningText(): string | undefined {
	const running = runningJobs();
	if (running.length > 0) {
		const infos: RunningInfo[] = running.map((job) => ({
			name: job.name,
			type: job.type,
			summary: job.summary,
			startedAt: job.startedAt,
		}));
		return runningLine(infos);
	}
	const now = Date.now();
	let lingering: Job | undefined;
	for (const job of jobs.values()) {
		if (!job.lingerLine || !job.lingerUntil || job.lingerUntil <= now) continue;
		if (!lingering || job.lingerUntil > (lingering.lingerUntil ?? 0)) lingering = job;
	}
	return lingering?.lingerLine;
}

// The footer line is refreshed by a timer so wallclock time advances even when
// no other event happens. A single interval serves every running job.
let runningTimer: NodeJS.Timeout | undefined;
let runningCtx: ExtensionContext | undefined;

function stopRunningTimer(): void {
	if (runningTimer) clearInterval(runningTimer);
	runningTimer = undefined;
}

function writeStatus(ctx: ExtensionContext): boolean {
	try {
		const running = activeRunningText();
		const base = statusText(ctx);
		// Running information goes first so a narrow footer never truncates it
		// behind the capability markers.
		ctx.ui.setStatus(STATUS_KEY, running ? `${running} · ${base}` : base);
		ctx.ui.setStatus(RUNNING_KEY, undefined);
		return true;
	} catch {
		// UI gone; stop ticking
		stopRunningTimer();
		runningCtx = undefined;
		return false;
	}
}

function refreshStatus(ctx: ExtensionContext): void {
	runningCtx = ctx;
	if (!writeStatus(ctx)) return;
	const hasActive = activeRunningText() !== undefined;
	if (hasActive && !runningTimer) {
		runningTimer = setInterval(() => {
			if (runningCtx) refreshStatus(runningCtx);
		}, RUNNING_REFRESH_MS);
		runningTimer.unref?.();
	} else if (!hasActive) {
		stopRunningTimer();
	}
}

/** Keep the `specialist` tool in the active set only while the extension is on. */
function syncToolActivation(pi: ExtensionAPI): void {
	try {
		const active = pi.getActiveTools();
		const has = active.includes(TOOL_NAME);
		if (runtime.config.enabled && !has) pi.setActiveTools([...active, TOOL_NAME]);
		else if (!runtime.config.enabled && has) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	} catch {
		// Non-interactive runtimes may not expose tool activation; the tool_call
		// guard still blocks execution while disabled.
	}
}

function applyState(pi: ExtensionAPI, ctx: ExtensionContext): void {
	refreshStatus(ctx);
	syncToolActivation(pi);
}

function capabilitiesSection(): string | undefined {
	if (!runtime.config.enabled) return undefined;
	const active = enabledSpecialists(runtime.config);
	if (active.length === 0) return undefined;
	const lines = active.map((spec) => {
		const info = findType(spec.type);
		const kind = info ? `${info.emoji} ${spec.type}` : spec.type;
		const aliases = spec.aliases?.length ? ` (alias: ${spec.aliases.join(", ")})` : "";
		return `- ${kind} · \`${spec.name}\`${aliases}${info ? ` — ${info.hint}` : ""}`;
	});
	return [
		"## Specialists",
		"You can delegate specialised work to models configured in this pi session (local or remote). Call the `specialist` tool:",
		'`specialist({ specialist: "<name or type>", prompt: "...", input: ["/abs/path/or/url"], options: {} })`',
		`Calls wait at most \`waitMs\` (default ${runtime.config.specialists.find((spec) => spec.enabled)?.waitMs ?? 250} ms). If the specialist answers sooner you get the result inline; otherwise the call returns a job id in milliseconds and the result arrives later as a \`specialist-result\` message. Do not poll or block: continue with other work. Pass \`wait: true\` only when you need the answer to continue in the same turn; use \`action:"result"\` with the job id to collect it later, and \`action:"jobs"\` to list running jobs. Multiple specialists can run in parallel.`,
		"Prefer a specialist when the active model cannot do the task (no vision, no audio, no image generation) or when a small dedicated model is better. Always pass absolute file paths. Inputs may be directories, PDFs, long audio or text files: the router expands, resizes, splits and batches them to the server budget and returns aggregated sections plus the full result file. Generated images come back attached; audio/video as saved file paths.",
		...(active.some((spec) => spec.protocol === "decision")
			? [
					'System-1 decision specialists use `state` (context) plus named `questions`: `specialist({ specialist: "...", state: "...", questions: { intent: { type: "choice", instructions: "...", criteria: { a: "...", b: "..." } } } })`. They answer in one transformers+torch pass (no token generation).',
				]
			: []),
		...lines,
	].join("\n");
}

function listText(): string {
	const { config } = runtime;
	const active = enabledSpecialists(config);
	const running = [...jobs.values()].filter((job) => job.status === "running").length;
	const header = `Specialists ${config.enabled ? "ON" : "OFF"} · ${config.specialists.length} configured · ${active.length} enabled · ${running} jobs`;
	if (config.specialists.length === 0) {
		return `${header}\nNo specialists configured. Add one with /specialists config or /specialists add <type> <name> <url>.`;
	}
	const lines = config.specialists.map((spec) => {
		const emoji = findType(spec.type)?.emoji ?? "🧩";
		return `${emoji} ${describeSpecialist(spec)} · ${maskApiKey(spec.apiKey)} · wait ${spec.waitMs} ms`;
	});
	return [
		header,
		...lines,
		'Run: specialist({ specialist: "<name>", prompt: "...", input: ["/path"] })',
	].join("\n");
}

function statusReport(): string {
	const session = runtime.warnings.length > 0 ? `\nWarnings: ${runtime.warnings.join(" | ")}` : "";
	return `${listText()}\n\nConfig: ${runtime.path}${runtime.config.outputDir ? `\nSalida: ${runtime.config.outputDir}` : ""}${session}`;
}

function formatResult(result: { text: string; outputs: Array<{ path: string; mimeType: string }> }): string {
	const text = result.text || "(no text)";
	return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n… (truncado)` : text;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Split CLI arguments respecting single and double quotes anywhere in a token,
 * so `--questions='{"intent": {"type": "choice"}}'` stays one argument even
 * when the JSON contains spaces.
 */
function splitArgs(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				out.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) out.push(current);
	return out;
}

function parseFlags(tokens: string[]): { positional: string[]; flags: Record<string, string> } {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	for (const token of tokens) {
		const match = /^--([a-z0-9-]+)=(.*)$/i.exec(token);
		if (match) {
			let value = match[2];
			// Allow shell-style quoting around the value: --state="..." or
			// --questions='{"q": ...}' (the tokenizer keeps the quotes because
			// the token starts with --flag=).
			if (
				value.length >= 2 &&
				((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
			) {
				value = value.slice(1, -1);
			}
			flags[match[1].toLowerCase()] = value;
		} else positional.push(token);
	}
	return { positional, flags };
}

function findByNameOrType(name: string): Specialist | undefined {
	return resolveSpecialist(runtime.config, name).specialist;
}

/** Wait for a job for at most `ms`; returns undefined on timeout. */
async function waitForJob(
	job: Job,
	ms: number,
): Promise<{ status: "done"; result: SpecialistRunResult } | { status: "error"; error: string } | { status: "timeout" }> {
	if (ms <= 0) return { status: "timeout" };
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<{ status: "timeout" }>((resolve) => {
		timer = setTimeout(() => resolve({ status: "timeout" }), ms);
	});
	try {
		return await Promise.race([
			job.promise.then(
				(result) => ({ status: "done" as const, result }),
				(error: unknown) => ({ status: "error" as const, error: errorMessage(error) }),
			),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default function specialistsExtension(pi: ExtensionAPI): void {
	// Re-read on every session so external edits (or another pi window) win.
	pi.on("session_start", async (_event, ctx) => {
		reloadFromDisk();
		applyState(pi, ctx);
		if (runtime.warnings.length > 0) {
			const joined = runtime.warnings.join("\n");
			if (joined !== lastWarningsReported) {
				lastWarningsReported = joined;
				ctx.ui.notify(`specialists: configuration warnings:\n${joined}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopRunningTimer();
		runningCtx = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setStatus(RUNNING_KEY, undefined);
		} catch {
			// ignore
		}
		jobs.clear();
	});

	// Advertise the configured capabilities to the active model.
	pi.on("before_agent_start", async (event) => {
		const section = capabilitiesSection();
		if (!section) return;
		event.systemPromptOptions.sections.specialists = section;
	});

	// Fail closed while the extension is off.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== TOOL_NAME) return;
		if (!runtime.config.enabled) {
			return {
				block: true,
				reason: "Specialists are disabled. Run /specialists on to enable them.",
			};
		}
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Specialists",
		description:
			"Run a configured specialist model on a prompt and optional input files, or inspect its jobs. " +
			"Specialists cover OCR, image understanding, image/video generation, speech-to-text, " +
			"text-to-speech, audio/music generation, classification, segmentation and embeddings. " +
			'Use action "list" to see the configured specialists and their types. ' +
			"Calls return within `waitMs` (milliseconds) when the model is fast; otherwise they return a job id " +
			"immediately and the result arrives later as a `specialist-result` message (no agent interruption). " +
			"Inputs are absolute file paths, directories, PDFs, http(s) URLs or data URIs; directories, PDF pages, " +
			"long audio and text files are split/resized and batched to the server budget automatically. Generated " +
			"images are returned attached, audio/video/embeddings as saved files.",
		promptSnippet: "specialist: run a configured specialist (OCR, vision, image, audio, video, embeddings)",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[Type.Literal("list"), Type.Literal("run"), Type.Literal("result"), Type.Literal("jobs")],
					{ description: '"list" configured specialists; "run" execute; "result" collect a job; "jobs" list jobs' },
				),
			),
			specialist: Type.Optional(
				Type.String({ description: "Specialist name (or type: ocr, text-to-image, tts, ...). Omit to list" }),
			),
			prompt: Type.Optional(Type.String({ description: "Instruction for the specialist" })),
			input: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], {
					description: "Input paths, directories, PDFs, URLs or data URIs (image, audio, video, text)",
				}),
			),
			output: Type.Optional(Type.String({ description: "Output path for the first generated media file (optional)" })),
			state: Type.Optional(
				Type.String({ description: "State/context for decision models (System-1 / decision protocol)" }),
			),
			questions: Type.Optional(
				Type.Record(Type.String(), Type.Any(), {
					description: "Named questions for System-1: { q: { type, instructions, criteria } }",
				}),
			),
			options: Type.Optional(
				Type.Record(Type.String(), Type.Any(), {
					description: "Extra protocol parameters (size, voice, language, num_frames, ...)",
				}),
			),
			waitMs: Type.Optional(
				Type.Number({ description: "Maximum milliseconds to wait inline before returning a job (default: specialist waitMs)" }),
			),
			wait: Type.Optional(
				Type.Boolean({ description: "true = wait for completion; false = return a job immediately; omit = waitMs grace period" }),
			),
			jobId: Type.Optional(Type.String({ description: "Job id for action: result" })),
		}),
		defaultActive: runtime.config.enabled,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime.config.enabled) {
				throw new Error("Specialists are disabled. Run /specialists on to enable them.");
			}
			const action = params.action ?? (params.specialist ? "run" : "list");

			if (action === "list") {
				return { content: [{ type: "text", text: listText() }], details: { action: "list" } };
			}

			if (action === "jobs") {
				const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
				const text =
					list.length === 0
						? "No jobs."
						: ["Jobs (newest first):", ...list.map((job) => jobSummary(job))].join("\n");
				return { content: [{ type: "text", text }], details: { action: "jobs", jobs: list.length } };
			}

			if (action === "result") {
				const jobId = params.jobId;
				if (!jobId) throw new Error("action: result requires jobId.");
				const job = jobs.get(jobId) ?? [...jobs.values()].find((candidate) => candidate.name === jobId);
				if (!job) throw new Error(`No job "${jobId}". Use action:"jobs".`);
				if (job.status === "running") {
					return {
						content: [{ type: "text", text: `⏳ ${jobSummary(job)} — still running.` }],
						details: { action: "result", jobId: job.id, status: "running" },
					};
				}
				if (job.status === "error") {
					throw new Error(`Job ${job.id} (${job.name}) failed: ${job.error}`);
				}
				return {
					content: resultContent(job.result!, `✅ ${job.name} (${job.type}) · ${job.elapsedMs} ms · job ${job.id}`),
					details: { action: "result", jobId: job.id, status: "done", ...job.result!.details },
				};
			}

			if (!params.specialist) {
				throw new Error(
					`Specify a specialist. Configured: ${runtime.config.specialists.map((spec) => spec.name).join(", ") || "(none)"}`,
				);
			}
			const { specialist, error } = resolveSpecialist(runtime.config, params.specialist);
			if (!specialist) throw new Error(error ?? `specialist "${params.specialist}" does not exist`);
			if (!specialist.enabled) {
				throw new Error(`Specialist "${specialist.name}" is disabled. Enable it with /specialists enable "${specialist.name}"`);
			}

			const info = findType(specialist.type);
			const input = params.input === undefined ? [] : Array.isArray(params.input) ? params.input : [params.input];
			if (info) {
				const needsMedia = info.input.some((kind) => kind === "image" || kind === "audio" || kind === "video");
				if (needsMedia && input.length === 0) {
					throw new Error(
						`Specialist "${specialist.name}" (${specialist.type}) needs a ${info.input.join("/")} input. Pass input: ["/path/to/file"].`,
					);
				}
			}
			const options: Record<string, unknown> = { ...(params.options as Record<string, unknown> | undefined) };
			if (params.state !== undefined) options.state = params.state;
			if (params.questions !== undefined) options.questions = params.questions;
			const prompt = params.prompt ?? defaultPromptFor(specialist.type) ?? "";
			const decisionInput =
				specialist.protocol === "decision" &&
				((typeof options.state === "string" && options.state.trim().length > 0) ||
					(options.questions !== undefined && typeof options.questions === "object"));
			if (!prompt && !decisionInput && info?.output !== "image" && info?.output !== "audio" && info?.output !== "video") {
				throw new Error(`Specialist "${specialist.name}" needs a prompt.`);
			}

			const waitMode = params.wait;
			const graceMs =
				waitMode === true
					? specialist.timeoutMs + 1_000
					: waitMode === false
						? 0
						: Math.max(0, Math.min(params.waitMs ?? specialist.waitMs, specialist.timeoutMs));
			// Only a blocking call honours the turn's abort signal. A background
			// job needs to survive the tool call returning.
			const job = startJob(
				pi,
				ctx,
				specialist,
				{ prompt, input, options: Object.keys(options).length > 0 ? options : undefined, output: params.output },
				waitMode === true ? signal : undefined,
			);
			const dispatchMs = Date.now() - job.startedAt;
			const outcome = await waitForJob(job, graceMs);

			if (outcome.status === "done") {
				// The result goes inline: suppress the background delivery.
				job.delivered = true;
				return {
					content: resultContent(
						outcome.result,
						`✅ ${specialist.name} (${specialist.type}) · ${job.elapsedMs} ms`,
					),
					details: { action: "run", jobId: job.id, mode: "inline", dispatchMs, ...outcome.result.details },
				};
			}
			if (outcome.status === "error") {
				throw new Error(`Specialist "${specialist.name}" (${specialist.type}): ${outcome.error}`);
			}

			// From here on the result must be delivered when it finishes.
			job.background = true;
			deliverJob(pi, ctx, job);
			return {
				content: [
					{
						type: "text",
						text:
							`⏱️ ${specialist.name} (${specialist.type}) is still running in the background · job ${job.id} · dispatch ${dispatchMs} ms.\n` +
							`No need to wait: the result will be delivered as a \`specialist-result\` message on the next turn. ` +
							`If you need it now, use specialist({ action: "result", jobId: "${job.id}" }).`,
					},
				],
				details: {
					action: "run",
					jobId: job.id,
					mode: "background",
					dispatchMs,
					status: "running",
					waitMs: graceMs,
				},
			};
		},
	});

	pi.registerCommand("specialists", {
		description:
			"Specialist router: on|off|config|status|list|add|remove|enable|disable|test|probe|reload|doctor",
		getArgumentCompletions: (prefix) => {
			const commands = ["on", "off", "config", "status", "list", "add", "remove", "enable", "disable", "test", "probe", "reload", "doctor"];
			const names = runtime.config.specialists.map((spec) => spec.name);
			const types = SPECIALIST_TYPES.map((info) => info.id);
			const pool = [...commands, ...names, ...types];
			const needle = prefix.trim().toLowerCase();
			return pool
				.filter((value) => value.toLowerCase().startsWith(needle))
				.slice(0, 30)
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const tokens = splitArgs(args.trim());
			const sub = (tokens.shift() ?? "status").toLowerCase();
			const { positional, flags } = parseFlags(tokens);

			const notify = (message: string, type: "info" | "warning" | "error" = "info"): void =>
				ctx.ui.notify(message, type);

			const commit = (): boolean => {
				const errors = persist();
				if (errors.length > 0) {
					notify(`Specialist not saved:\n${errors.join("\n")}`, "error");
					return false;
				}
				applyState(pi, ctx);
				return true;
			};

			switch (sub) {
				case "on":
				case "off": {
					const previous = runtime.config.enabled;
					runtime.config.enabled = sub === "on";
					if (!commit()) runtime.config.enabled = previous;
					else notify(`Specialists ${sub === "on" ? "enabled" : "disabled"}.`);
					return;
				}
				case "status": {
					notify(statusReport());
					return;
				}
				case "list": {
					notify(listText());
					return;
				}
				case "reload": {
					reloadFromDisk();
					applyState(pi, ctx);
					notify(`Configuration reloaded from ${runtime.path}.${runtime.warnings.length ? `\nWarnings: ${runtime.warnings.join(" | ")}` : ""}`);
					return;
				}
				case "doctor": {
					notify(diagnostics());
					return;
				}
				case "probe": {
					const name = positional[0];
					const target = name ? findByNameOrType(name) : undefined;
					if (!target) {
						notify(name ? "No such specialist." : 'Usage: /specialists probe "<name>"', "warning");
						return;
					}
					const budget = await discoverBudget(target, ctx.signal);
					notify(`${target.name} (${target.type})
${budgetSummary(budget)}`);
					return;
				}
				case "config": {
					// The file is the source of truth: pick up external edits (another
					// pi window, a hand-edited specialists.json) before showing the menu.
					reloadFromDisk();
					applyState(pi, ctx);
					const { showConfigMenu } = await import("./ui.ts");
					await showConfigMenu(ctx, {
						getConfig: () => runtime.config,
						save: commit,
						refresh: () => applyState(pi, ctx),
						doctor: diagnostics,
						configPath: runtime.path,
					});
					return;
				}
				case "add": {
					const [typeArg, nameArg, urlArg, ...modelParts] = positional;
					if (!typeArg || !nameArg || !urlArg) {
						notify(
							'Usage: /specialists add <type> "<name>" <url> [model] [--port=8080] [--key=env:VAR] [--protocol=openai-chat] [--waitms=250]',
							"warning",
						);
						return;
					}
					const info = findType(typeArg);
					if (!info) {
						notify(`Unknown type "${typeArg}". Types: ${SPECIALIST_TYPES.map((t) => t.id).join(", ")}`, "error");
						return;
					}
					if (runtime.config.specialists.some((spec) => sameReference(spec.name, nameArg))) {
						notify(`A specialist named "${nameArg}" already exists.`, "error");
						return;
					}
					const portFlag = flags.port === undefined ? undefined : Number(flags.port);
					if (flags.port !== undefined && (!Number.isInteger(portFlag) || portFlag! < 1 || portFlag! > 65_535)) {
						notify(`invalid --port: "${flags.port}"`, "error");
						return;
					}
					const waitFlag = flags.waitms === undefined ? undefined : Number(flags.waitms);
					if (flags.waitms !== undefined && (!Number.isFinite(waitFlag) || waitFlag! < 0)) {
						notify(`invalid --waitms: "${flags.waitms}"`, "error");
						return;
					}
					const created = normalizeSpecialist({
						name: nameArg,
						type: info.id,
						baseUrl: urlArg,
						port: portFlag,
						model: modelParts.join(" ") || undefined,
						protocol: flags.protocol,
						apiKey: flags.key,
						notes: flags.notes,
						waitMs: waitFlag,
					});
					runtime.config.specialists.push(created);
					if (commit()) {
						notify(`Added ${created.name} (${created.type} → ${specialistTarget(created)}). Saved to ${runtime.path}.`);
					} else {
						runtime.config.specialists = runtime.config.specialists.filter((spec) => spec !== created);
					}
					return;
				}
				case "remove": {
					const name = positional[0];
					const target = name ? findByNameOrType(name) : undefined;
					if (!target) {
						notify(name ? "No such specialist." : 'Usage: /specialists remove "<name>"', "warning");
						return;
					}
					runtime.config.specialists = runtime.config.specialists.filter((spec) => spec !== target);
					if (commit()) notify(`Removed ${target.name}.`);
					else runtime.config.specialists.push(target);
					return;
				}
				case "enable":
				case "disable": {
					const name = positional[0];
					const target = name ? findByNameOrType(name) : undefined;
					if (!target) {
						notify(name ? "No such specialist." : `Usage: /specialists ${sub} "<name>"`, "warning");
						return;
					}
					target.enabled = sub === "enable";
					if (commit()) notify(`${target.name} ${target.enabled ? "enabled" : "disabled"}.`);
					else target.enabled = !target.enabled;
					return;
				}
				case "test": {
					const name = positional[0];
					const target = name ? findByNameOrType(name) : undefined;
					if (!target) {
						notify(
							name
								? "No such specialist."
								: 'Usage: /specialists test "<name>" [prompt] [--input=/path] [--state="..."] [--questions=\'{"q":{"type":"noul","instructions":"..."}}\']',
							"warning",
						);
						return;
					}
					const prompt = positional.slice(1).join(" ") || defaultPromptFor(target.type) || "Hello, reply OK.";
					const input = flags.input ? [flags.input] : [];
					const testOptions: Record<string, unknown> = {};
					if (flags.state) testOptions.state = flags.state;
					if (flags.questions) {
						try {
							const parsed = JSON.parse(flags.questions);
							if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
							testOptions.questions = parsed;
						} catch (error) {
							notify(`invalid --questions: ${errorMessage(error)}`, "error");
							return;
						}
					}
					notify(`Testing ${target.name} (${target.type})...`);
					// Route the manual test through the job registry so the live
					// footer line appears and ticks while it runs.
					const job = startJob(
						pi,
						ctx,
						target,
						{ prompt, input, options: Object.keys(testOptions).length > 0 ? testOptions : undefined },
						undefined,
					);
					const outcome = await waitForJob(job, target.timeoutMs + 1_000);
					if (outcome.status === "done") {
						notify(`✅ ${target.name} · ${job.elapsedMs} ms: ${formatResult(outcome.result).slice(0, 600)}`, "info");
					} else if (outcome.status === "error") {
						notify(`❌ ${target.name}: ${outcome.error}`, "error");
					} else {
						notify(`⏱️ ${target.name} is still running (job ${job.id}).`, "warning");
					}
					return;
				}
				default: {
					notify(
						`Unknown subcommand "${sub}". Use /specialists on|off|config|status|list|add|remove|enable|disable|test|probe|reload|doctor.`,
						"warning",
					);
				}
			}
		},
	});
}

export { capabilitiesSection, statusText, listText };
