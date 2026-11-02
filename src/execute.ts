/**
 * Specialist execution: resolve inputs, perform the HTTP call, poll async
 * jobs, persist generated media and return a pi-friendly result.
 *
 * Kept independent from pi so it can be exercised from the CLI and tests; the
 * extension adapts the result to an AgentToolResult in index.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { findType, type OutputKind } from "./catalog.ts";
import { budgetSummary, discoverBudget, estimateTokens, truncateToTokens, type Budget } from "./budget.ts";
import { localFallbackUrl } from "./local.ts";
import { prepareInputs, wantsPreprocessing, type WorkItem } from "./preprocess.ts";
import type { Specialist } from "./config.ts";
import {
	buildRequest,
	extForMime,
	mediaKindForMime,
	mediaRefsFromJson,
	parseResponse,
	type MediaInput,
} from "./protocols.ts";

const EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".flac": "audio/flac",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".json": "application/json",
};

export interface SpecialistCallRequest {
	prompt?: string;
	/** Absolute paths, http(s) URLs or data URIs. */
	input?: string[];
	options?: Record<string, unknown>;
}

export interface RunOptions {
	/** Output path override for the first generated media file. */
	output?: string;
	/** Absolute fallback directory for generated media. */
	outputDir?: string;
	signal?: AbortSignal;
	/** Batch progress callback ("3/20 · doc.pdf p.3"). */
	onProgress?: (message: string) => void;
}

export interface GeneratedMedia {
	path: string;
	mimeType: string;
	base64?: string;
	bytes: number;
}

export interface SpecialistRunResult {
	text: string;
	details: Record<string, unknown>;
	images: GeneratedMedia[];
	outputs: GeneratedMedia[];
	json?: unknown;
}

export function mimeForPath(path: string): string | undefined {
	return EXT_MIME[extname(path).toLowerCase()];
}

function expandPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolvePath(path);
}

function isUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function decodeDataUri(value: string): { mimeType: string; base64: string } | undefined {
	const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(value);
	if (!match) return undefined;
	return { mimeType: match[1] || "application/octet-stream", base64: match[2] };
}

export interface InputOptions {
	/** Leave http(s) URLs untouched for protocols that accept them. */
	keepUrls?: boolean;
	/** Keep local paths without reading/base64-encoding the file. */
	keepPaths?: boolean;
}

/**
 * Resolve tool inputs (paths, http(s) URLs or data URIs) to base64 payloads or
 * references. `keepPaths` is used by the decision sidecar, which reads local
 * files itself; this avoids reading and encoding the image in the extension.
 */
export async function resolveInputs(
	values: string[],
	options: InputOptions = {},
	signal?: AbortSignal,
): Promise<MediaInput[]> {
	const keepUrls = options.keepUrls ?? false;
	const keepPaths = options.keepPaths ?? false;
	const inputs: MediaInput[] = [];
	for (const raw of values) {
		const value = String(raw).trim();
		if (!value) continue;
		const dataUri = decodeDataUri(value);
		if (dataUri) {
			inputs.push({
				kind: mediaKindForMime(dataUri.mimeType),
				mimeType: dataUri.mimeType,
				data: dataUri.base64,
			});
			continue;
		}
		if (isUrl(value)) {
			if (keepUrls) {
				const guessed = extForMime(mimeForPath(value.split("?")[0]), "bin");
				inputs.push({
					kind: mediaKindForMime(mimeForPath(value.split("?")[0])),
					mimeType: mimeForPath(value.split("?")[0]) ?? "application/octet-stream",
					url: value,
					filename: value.split("/").pop()?.split("?")[0] ?? `input.${guessed}`,
				});
				continue;
			}
			const response = await fetch(value, { signal });
			if (!response.ok) throw new Error(`could not download input ${value}: HTTP ${response.status}`);
			const buffer = Buffer.from(await response.arrayBuffer());
			const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || mimeForPath(value) || "application/octet-stream";
			inputs.push({
				kind: mediaKindForMime(mimeType),
				mimeType,
				data: buffer.toString("base64"),
				path: value,
				filename: value.split("/").pop()?.split("?")[0] ?? `input.${extForMime(mimeType)}`,
			});
			continue;
		}
		const path = expandPath(value);
		const mimeType = mimeForPath(path) ?? "application/octet-stream";
		if (keepPaths) {
			inputs.push({
				kind: mediaKindForMime(mimeType),
				mimeType,
				path,
				filename: path.split("/").pop(),
			});
			continue;
		}
		const buffer = await readFile(path);
		inputs.push({
			kind: mediaKindForMime(mimeType),
			mimeType,
			data: buffer.toString("base64"),
			path,
			filename: path.split("/").pop(),
		});
	}
	return inputs;
}

/** Detect the real media type from magic bytes, falling back to the header. */
export function sniffMime(bytes: Uint8Array, fallback?: string): string | undefined {
	const hex = (start: number, end: number): string =>
		Buffer.from(bytes.subarray(start, end)).toString("hex");
	if (bytes.length >= 8 && hex(0, 8) === "89504e470d0a1a0a") return "image/png";
	if (bytes.length >= 3 && hex(0, 3) === "ffd8ff") return "image/jpeg";
	if (bytes.length >= 6 && ["474946383761", "474946383961"].includes(hex(0, 6))) return "image/gif";
	if (bytes.length >= 12 && hex(0, 4) === "52494646" && hex(8, 12) === "57454250") return "image/webp";
	if (bytes.length >= 4 && hex(0, 4) === "4f676753") return "audio/ogg";
	if (bytes.length >= 12 && hex(0, 4) === "52494646" && hex(8, 12) === "57415645") return "audio/wav";
	if (bytes.length >= 3 && hex(0, 3) === "494433") return "audio/mpeg";
	if (bytes.length >= 2 && hex(0, 2) === "fffb") return "audio/mpeg";
	if (bytes.length >= 8 && hex(4, 8) === "66747970") return "video/mp4";
	if (bytes.length >= 4 && hex(0, 4) === "1a45dfa3") return "video/webm";
	if (bytes.length >= 4 && hex(0, 4) === "25504446") return "application/pdf";
	return fallback;
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeFileBase(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "specialist";
}

async function persistBytes(
	bytes: Uint8Array,
	mimeType: string | undefined,
	spec: Specialist,
	options: RunOptions,
	index: number,
): Promise<GeneratedMedia> {
	const mime = sniffMime(bytes, mimeType) ?? "application/octet-stream";
	const dir = options.outputDir ? expandPath(options.outputDir) : join(tmpdir(), "pi-specialists");
	await mkdir(dir, { recursive: true });
	let target: string;
	if (options.output && index === 0) {
		target = expandPath(options.output);
		const parent = target.split("/").slice(0, -1).join("/");
		if (parent) await mkdir(parent, { recursive: true });
	} else {
		target = join(dir, `${timestamp()}-${safeFileBase(spec.name)}${index ? `-${index + 1}` : ""}.${extForMime(mime)}`);
	}
	await writeFile(target, bytes);
	const result: GeneratedMedia = { path: target, mimeType: mime, bytes: bytes.byteLength };
	if (mime.startsWith("image/") && bytes.byteLength <= 8 * 1024 * 1024) {
		result.base64 = Buffer.from(bytes).toString("base64");
	}
	return result;
}

async function downloadMedia(
	url: string,
	spec: Specialist,
	options: RunOptions,
	index: number,
	signal?: AbortSignal,
): Promise<GeneratedMedia> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`could not download result ${url}: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || mimeForPath(url.split("?")[0]);
	return persistBytes(bytes, mimeType, spec, options, index);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("cancelled"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface ReplicatePrediction {
	id?: string;
	status?: string;
	output?: unknown;
	error?: string;
	urls?: { get?: string };
}

async function pollReplicate(
	prediction: Record<string, unknown>,
	spec: Specialist,
	headers: Record<string, string>,
	deadline: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	let current = prediction;
	let status = String(current.status ?? "");
	while (["starting", "processing", "queued"].includes(status)) {
		if (Date.now() > deadline) throw new Error(`Replicate did not finish within ${spec.timeoutMs} ms (status: ${status})`);
		const getUrl = (current.urls as ReplicatePrediction["urls"] | undefined)?.get;
		if (!getUrl) break;
		await sleep(1_500, signal);
		const getHeaders = { ...headers };
		delete getHeaders["Content-Type"];
		const response = await fetch(getUrl, { headers: getHeaders, signal });
		if (!response.ok) throw new Error(`Replicate GET ${response.status}: ${(await response.text()).slice(0, 300)}`);
		current = (await response.json()) as Record<string, unknown>;
		status = String(current.status ?? "");
	}
	if (String(current.status) === "failed" || String(current.status) === "canceled") {
		throw new Error(`Replicate ended with status ${current.status}: ${current.error ?? "(no detail)"}`);
	}
	return current;
}

async function readErrorBody(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text.replace(/\s+/g, " ").slice(0, 600);
	} catch {
		return "";
	}
}

/** Run one specialist request (no preprocessing/batching). */
async function executeSingle(
	spec: Specialist,
	request: SpecialistCallRequest,
	options: RunOptions = {},
): Promise<SpecialistRunResult> {
	const startedAt = Date.now();
	const typeInfo = findType(spec.type);
	const outputKind: OutputKind = typeInfo?.output ?? "text";
	const keepUrls = ["openai-chat", "replicate", "custom-json", "decision"].includes(spec.protocol);
	const inputs = await resolveInputs(
		request.input ?? [],
		{ keepUrls, keepPaths: spec.protocol === "decision" },
		options.signal,
	);
	const built = buildRequest(spec, { prompt: request.prompt, input: inputs, options: request.options });
	const deadline = Date.now() + spec.timeoutMs;
	const timeoutSignal = AbortSignal.timeout(spec.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	const perform = (url: string): Promise<Response> =>
		fetch(url, {
			method: built.method,
			headers: built.headers,
			body: built.body,
			signal,
		});

	// Services on this machine usually bind 127.0.0.1. The machine's own
	// tailnet name (e.g. "my-host") resolves to the tailnet interface, where nothing is
	// listening, so prefer loopback immediately for local HTTP hosts. This is
	// both the fast path and the correctness fix; if loopback is refused (the
	// service is bound to the tailnet IP instead), the configured host is tried
	// next instead of failing.
	const configuredUrl = built.url;
	const loopbackUrl = signal?.aborted ? undefined : localFallbackUrl(configuredUrl);
	let requestUrl = loopbackUrl ?? configuredUrl;
	let usedLoopback = loopbackUrl !== undefined;
	let usedConfiguredFallback = false;
	let response: Response;
	try {
		response = await perform(requestUrl);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/abort/i.test(message)) {
			throw new Error(`timed out after ${spec.timeoutMs} ms calling ${hostOf(configuredUrl)}`);
		}
		if (!loopbackUrl) throw new Error(`network failure calling ${hostOf(configuredUrl)}: ${message}`);
		try {
			response = await perform(configuredUrl);
			requestUrl = configuredUrl;
			usedLoopback = false;
			usedConfiguredFallback = true;
		} catch (retryError) {
			const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
			throw new Error(
				`network failure calling ${hostOf(loopbackUrl)} and ${hostOf(configuredUrl)}: ${message} / ${retryMessage}`,
			);
		}
	}

	if (!response.ok) {
		const body = await readErrorBody(response);
		const hint =
			response.status === 401 || response.status === 403
				? " — check the API key and authentication mode"
				: "";
		throw new Error(`HTTP ${response.status} ${response.statusText}${hint}: ${body || "(no body)"}`);
	}

	let parsed = await parseResponse(response, spec);
	let json = parsed.json;

	// Replicate async jobs: poll until done, then parse the final output.
	if (spec.protocol === "replicate" && json && typeof json === "object") {
		json = await pollReplicate(json as Record<string, unknown>, spec, built.headers, deadline, signal);
		parsed = { kind: "json", json };
	}

	const outputs: GeneratedMedia[] = [];
	const textParts: string[] = [];

	if (parsed.kind === "text") {
		if (parsed.text) textParts.push(parsed.text);
	} else if (parsed.kind === "binary") {
		const media = await persistBytes(parsed.data ?? new Uint8Array(), parsed.mimeType, spec, options, 0);
		outputs.push(media);
	} else if (parsed.kind === "json") {
		if (outputKind === "image" || outputKind === "audio" || outputKind === "video") {
			const refs = mediaRefsFromJson(json);
			for (const [index, ref] of refs.entries()) {
				if (ref.base64) {
					const bytes = new Uint8Array(Buffer.from(ref.base64, "base64"));
					outputs.push(await persistBytes(bytes, ref.mimeType, spec, options, index));
				} else if (ref.url) {
					outputs.push(await downloadMedia(ref.url, spec, options, index, signal));
				}
			}
			if (outputs.length === 0 && findType(spec.type)?.output === "image") {
				// Some servers return raw JSON text for generation errors.
				textParts.push(JSON.stringify(json, null, 2).slice(0, 4_000));
			}
		} else if (outputKind === "vectors") {
			const vectorPath = options.output
				? expandPath(options.output)
				: join(options.outputDir ? expandPath(options.outputDir) : join(tmpdir(), "pi-specialists"), `${timestamp()}-${safeFileBase(spec.name)}-embeddings.json`);
			await mkdir(vectorPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
			await writeFile(vectorPath, `${JSON.stringify(json, null, 2)}\n`);
			textParts.push(`Embeddings guardados en ${vectorPath}`);
		} else {
			const text = jsonToReadable(json);
			if (text) textParts.push(text);
		}
	}

	if (outputs.length === 0 && textParts.length === 0) {
		textParts.push("(the specialist returned no text or media)");
	}

	const label = outputs[0]?.mimeType?.split("/")[0] ?? outputKind;
	const mediaSummary = outputs.map((media) => `${label} → ${media.path} (${media.bytes} B)`).join("\n");
	const text = [textParts.join("\n"), mediaSummary].filter(Boolean).join("\n\n").trim();

	return {
		text,
		images: outputs.filter((media) => media.mimeType.startsWith("image/")),
		outputs,
		json,
		details: {
			specialist: spec.name,
			type: spec.type,
			protocol: spec.protocol,
			model: spec.model,
			url: requestUrl.replace(/[?].*$/, ""),
			status: response.status,
			...(usedLoopback ? { fallback: "loopback", configuredUrl: configuredUrl.replace(/[?].*$/, "") } : {}),
			...(usedConfiguredFallback ? { fallback: "configured-host", loopbackTried: true } : {}),
			elapsedMs: Date.now() - startedAt,
			...(parsed.language ? { language: parsed.language } : {}),
			inputs: inputs.map((input) => input.path ?? input.url ?? input.mimeType),
			outputs: outputs.map((media) => ({ path: media.path, mimeType: media.mimeType, bytes: media.bytes })),
		},
	};
}


// ─── Batch-aware entry point ────────────────────────────────────────────────

const MAX_ATTACHED_IMAGES = 4;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A prompt reserve for the output and protocol overhead. */
function fitPrompt(prompt: string, budget: Budget): { text: string; truncated: boolean } {
	const reserve = budget.maxOutputTokens + 256;
	const maxInput = Math.max(128, (budget.contextTokens ?? 4_096) - reserve);
	return truncateToTokens(prompt, maxInput);
}

function itemOptions(
	spec: Specialist,
	base: Record<string, unknown> | undefined,
	budget: Budget,
): Record<string, unknown> | undefined {
	const options: Record<string, unknown> = { ...(base ?? {}) };
	if (spec.protocol === "openai-chat" && options.max_tokens === undefined && budget.contextTokens) {
		options.max_tokens = budget.maxOutputTokens;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

interface ItemOk {
	item: WorkItem;
	result: SpecialistRunResult;
}
interface ItemError {
	item: WorkItem;
	error: string;
}
type ItemOutcome = ItemOk | ItemError;

/**
 * Budget-aware entry point.
 *
 * Plain single requests keep the previous fast path. Directories, PDFs, long
 * audio, text files, multiple inputs or oversized media are expanded into
 * work items that fit the server budget, processed sequentially/parallel and
 * aggregated into one result (plus a full-result markdown file).
 */
export async function executeSpecialist(
	spec: Specialist,
	request: SpecialistCallRequest,
	options: RunOptions = {},
): Promise<SpecialistRunResult> {
	const inputs = request.input ?? [];
	// A long prompt without files still has to fit the context window.
	const fitLongPrompt = async (): Promise<SpecialistRunResult | undefined> => {
		if (estimateTokens(request.prompt) <= 1_024) return undefined;
		const budget = await discoverBudget(spec, options.signal);
		const fitted = fitPrompt(request.prompt ?? "", budget);
		return executeSingle(
			spec,
			{
				...request,
				prompt: fitted.text,
				options: itemOptions(spec, request.options, budget),
			},
			options,
		);
	};
	if (inputs.length === 0) return (await fitLongPrompt()) ?? executeSingle(spec, request, options);
	if (!(await wantsPreprocessing(inputs, spec))) {
		return (await fitLongPrompt()) ?? executeSingle(spec, request, options);
	}

	const budget = await discoverBudget(spec, options.signal);
	const prepared = await prepareInputs(inputs, spec, budget, options.signal);
	const warnings = [...prepared.warnings];
	try {
		if (prepared.items.length === 0) {
			throw new Error(
				`No processable items in ${inputs.join(", ")}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`,
			);
		}

		// A single file that already fits keeps the exact single-call behavior.
		if (
			prepared.items.length === 1 &&
			!prepared.items[0].text &&
			prepared.items[0].path === inputs[0] &&
			warnings.length === 0
		) {
			return executeSingle(spec, request, options);
		}

		const total = prepared.items.length;
		const started = Date.now();
		let startedCount = 0;
		let doneCount = 0;
		const outcomes = await mapLimit(prepared.items, budget.maxParallel, async (item, index): Promise<ItemOutcome> => {
			startedCount += 1;
			options.onProgress?.(`${startedCount}/${total} · ${item.label}`);
			const basePrompt = request.prompt ?? "";
			const prompt = item.text ? [basePrompt, item.text].filter(Boolean).join("\n\n") : basePrompt;
			const fitted = fitPrompt(prompt, budget);
			if (fitted.truncated) warnings.push(`${item.label}: prompt truncated to ~${budget.contextTokens} tokens.`);
			const extraOptions = itemOptions(spec, request.options, budget);
			const decisionState =
				item.text && spec.protocol === "decision"
					? { ...(extraOptions ?? {}), state: item.text }
					: extraOptions;
			try {
				const result = await executeSingle(
					spec,
					{
						prompt: fitted.text,
						input: item.path ? [item.path] : [],
						options: decisionState,
					},
					{
						...options,
						output: index === 0 ? options.output : undefined,
						onProgress: undefined,
					},
				);
				doneCount += 1;
				options.onProgress?.(`${doneCount}/${total} · ${item.label} done`);
				return { item, result };
			} catch (error) {
				doneCount += 1;
				options.onProgress?.(`${doneCount}/${total} · ${item.label} error`);
				return { item, error: errorText(error) };
			}
		});

		const failures = outcomes.filter((outcome): outcome is ItemError => "error" in outcome);
		if (failures.length === outcomes.length) {
			throw new Error(
				`All items failed: ${failures.map((failure) => `${failure.item.label}: ${failure.error}`).join(" | ")}`,
			);
		}

		const sections = outcomes.map((outcome) =>
			"error" in outcome
				? `## ${outcome.item.label}\nERROR: ${outcome.error}`
				: `## ${outcome.item.label}\n${outcome.result.text}`,
		);
		const aggregate = sections.join("\n\n");
		const allImages = outcomes.flatMap((outcome) => ("result" in outcome ? outcome.result.images : []));
		const allOutputs = outcomes.flatMap((outcome) => ("result" in outcome ? outcome.result.outputs : []));
		const languages = Array.from(
			new Set(
				outcomes.flatMap((outcome) => {
					if (!("result" in outcome)) return [];
					const language = outcome.result.details.language;
					return typeof language === "string" ? [language] : [];
				}),
			),
		);

		const outputDir = options.outputDir ? expandPath(options.outputDir) : join(tmpdir(), "pi-specialists");
		await mkdir(outputDir, { recursive: true });
		const outputFile = join(outputDir, `${timestamp()}-${safeFileBase(spec.name)}-batch.md`);
		await writeFile(outputFile, `${aggregate}\n`);
		const header = [
			`📄 ${total} items · ${failures.length} errors`,
			...(warnings.length > 0 ? [`Warnings: ${warnings.join(" | ")}`] : []),
			`Full result: ${outputFile}`,
		].join("\n");
		const text = `${header}\n\n${aggregate}`;

		return {
			text,
			images: allImages.slice(0, MAX_ATTACHED_IMAGES),
			outputs: allOutputs,
			details: {
				specialist: spec.name,
				type: spec.type,
				protocol: spec.protocol,
				model: spec.model,
				batch: true,
				items: total,
				errors: failures.length,
				elapsedMs: Date.now() - started,
				budget: budgetSummary(budget),
				outputFile,
				warnings,
				sources: inputs,
				inputs: prepared.items.map((item) => item.path ?? item.label),
				outputs: allOutputs.map((media) => ({ path: media.path, mimeType: media.mimeType, bytes: media.bytes })),
				...(languages.length > 0 ? { language: languages.join(", ") } : {}),
			},
		};
	} finally {
		await prepared.cleanup();
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function jsonToReadable(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => jsonToReadable(item)).filter(Boolean).join("\n");
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		// System-1 decision sidecars: { answers: {...}, usage: {...}, ms: 26 }
		if (obj.answers && typeof obj.answers === "object") {
			const ms = typeof obj.ms === "number" ? `\n(${obj.ms} ms)` : "";
			return `${JSON.stringify(obj.answers, null, 2)}${ms}`;
		}
		for (const key of ["text", "generated_text", "transcription", "transcript", "label", "error", "detail"]) {
			if (typeof obj[key] === "string") return String(obj[key]);
		}
		const compact = JSON.stringify(value, null, 2);
		return compact.length > 6_000 ? `${compact.slice(0, 6_000)}\n… (truncated)` : compact;
	}
	return String(value ?? "");
}
