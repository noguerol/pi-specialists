/**
 * HTTP protocol adapters.
 *
 * The router speaks a handful of wire protocols so one config can mix local
 * runtimes (LM Studio, vLLM, Ollama's OpenAI endpoint, ComfyUI bridges),
 * hosted OpenAI-compatible APIs, Hugging Face Inference, Replicate and plain
 * JSON endpoints. `buildRequest()` is pure (given a resolved api key from the
 * environment) and returns a standard `RequestInit`, so it is unit-testable
 * without network access.
 */

import { resolveApiKey, type Specialist } from "./config.ts";
import { findType, type OutputKind } from "./catalog.ts";

export type MediaKind = "image" | "audio" | "video" | "file";

/** One resolved input: either remote URL or base64 payload. */
export interface MediaInput {
	kind: MediaKind;
	mimeType: string;
	/** base64 without the `data:` prefix */
	data?: string;
	url?: string;
	/** Original path, for error messages / details. */
	path?: string;
	filename?: string;
}

export interface SpecialistRequest {
	prompt?: string;
	input?: MediaInput[];
	options?: Record<string, unknown>;
}

export type RequestBody = string | FormData | Blob | Uint8Array;

export interface BuiltRequest {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: RequestBody;
	responseKind: "auto" | "json" | "text" | "binary";
}

export interface ParsedResponse {
	kind: "text" | "json" | "binary";
	text?: string;
	json?: unknown;
	data?: Uint8Array;
	mimeType?: string;
	ext?: string;
	/** Detected language for ASR responses (when the server reports it). */
	language?: string;
}

export const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/svg+xml": "svg",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
	"audio/flac": "flac",
	"audio/mp4": "m4a",
	"audio/aac": "aac",
	"audio/webm": "weba",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"application/pdf": "pdf",
	"application/json": "json",
	"text/plain": "txt",
};

export function extForMime(mimeType: string | undefined, fallback = "bin"): string {
	if (!mimeType) return fallback;
	const clean = mimeType.split(";")[0].trim().toLowerCase();
	return MIME_EXT[clean] ?? fallback;
}

export function mediaKindForMime(mimeType: string | undefined): MediaKind {
	const mime = (mimeType ?? "").toLowerCase();
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("video/")) return "video";
	return "file";
}

export function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	if (!path) return base;
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}`;
}

/** Apply the optional specialist port on top of its base URL. */
export function withPort(baseUrl: string, port?: number): string {
	if (!port) return baseUrl;
	try {
		const url = new URL(baseUrl);
		url.port = String(port);
		return url.toString().replace(/\/+$/, "");
	} catch {
		return baseUrl;
	}
}

function dataUrl(input: MediaInput): string {
	if (input.url) return input.url;
	return `data:${input.mimeType};base64,${input.data ?? ""}`;
}

function inputBlob(input: MediaInput): Blob {
	const bytes = Buffer.from(input.data ?? "", "base64");
	return new Blob([bytes], { type: input.mimeType || "application/octet-stream" });
}

function inputFilename(input: MediaInput, fallbackExt = "bin"): string {
	if (input.filename) return input.filename;
	if (input.path) return input.path.split("/").pop() || `input.${fallbackExt}`;
	return `input.${extForMime(input.mimeType, fallbackExt)}`;
}

/** Apply the configured authentication to headers/query params. */
export function applyAuth(
	spec: Specialist,
	headers: Record<string, string>,
	query: Record<string, string>,
): void {
	const auth = spec.auth ?? { type: spec.apiKey ? "bearer" : "none" };
	const key = resolveApiKey(spec.apiKey);
	if (auth.type === "none" || !key) return;
	const prefix = auth.prefix ?? (auth.type === "bearer" ? "Bearer " : "");
	switch (auth.type) {
		case "bearer":
			headers.Authorization = `${prefix}${key}`;
			break;
		case "header":
			headers[auth.headerName || "X-API-Key"] = `${prefix}${key}`;
			break;
		case "query":
			query[auth.queryName || "api_key"] = key;
			break;
		case "basic":
			headers.Authorization = `Basic ${Buffer.from(`${auth.username ?? ""}:${key}`, "utf-8").toString("base64")}`;
			break;
	}
}

function withQuery(url: string, query: Record<string, string>): string {
	const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
	if (entries.length === 0) return url;
	const params = new URLSearchParams(entries);
	return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
}

function templateValue(value: unknown, ctx: Record<string, unknown>): unknown {
	if (typeof value === "string") {
		return value.replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, (match, key: string) => {
			const replacement = ctx[key];
			if (replacement === undefined || replacement === null) return match;
			return typeof replacement === "string" ? replacement : JSON.stringify(replacement);
		});
	}
	if (Array.isArray(value)) return value.map((item) => templateValue(item, ctx));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = templateValue(item, ctx);
		}
		return out;
	}
	return value;
}

/** Build the `questions` object expected by a System-1 decision sidecar. */
export function normalizeDecisionQuestions(raw: unknown, prompt: string): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw === "string" && raw.trim()) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// fall through to the default question
		}
	}
	return {
		answer: {
			type: "text",
			instructions: prompt || "Answer the request.",
		},
	};
}

function decisionMedia(input: MediaInput): Record<string, string> | undefined {
	if (input.path) return { type: "path", path: input.path };
	if (input.url) return { type: "url", url: input.url };
	if (input.data) return { type: "base64", data: input.data };
	return undefined;
}

/**
 * Replace `{{name}}` placeholders in a ComfyUI workflow. An exact placeholder
 * keeps the value type (numbers for width/height/seed), embedded placeholders
 * are stringified.
 */
export function templateDeep(value: unknown, context: Record<string, unknown>): unknown {
	if (typeof value === "string") {
		const exact = /^\{\{\s*([a-z0-9_.-]+)\s*\}\}$/i.exec(value);
		if (exact) {
			const replacement = context[exact[1]];
			return replacement === undefined || replacement === null ? value : replacement;
		}
		return value.replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, (match, key: string) => {
			const replacement = context[key];
			return replacement === undefined || replacement === null ? match : String(replacement);
		});
	}
	if (Array.isArray(value)) return value.map((item) => templateDeep(item, context));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = templateDeep(item, context);
		}
		return out;
	}
	return value;
}

function defaultPath(spec: Specialist): string {
	if (spec.path) return spec.path;
	switch (spec.protocol) {
		case "openai-chat":
			return "/chat/completions";
		case "openai-images":
			return "/images/generations";
		case "comfyui":
			return "/prompt";
		case "openai-speech":
			return "/audio/speech";
		case "openai-transcriptions":
			return "/audio/transcriptions";
		case "openai-embeddings":
			return "/embeddings";
		case "decision":
			return "/decide";
		case "replicate":
			return "/predictions";
		case "hf-inference":
			return spec.model ? `/models/${spec.model.split("/").map(encodeURIComponent).join("/")}` : "";
		case "custom-json":
			return "";
	}
}

/** Build the HTTP request for a specialist call. */
export function buildRequest(spec: Specialist, request: SpecialistRequest): BuiltRequest {
	const headers: Record<string, string> = {
		Accept: "application/json",
		...spec.headers,
	};
	const query: Record<string, string> = { ...spec.query };
	applyAuth(spec, headers, query);

	const inputs = request.input ?? [];
	const prompt = request.prompt ?? "";
	const options = request.options ?? {};
	const first = inputs[0];
	const typeInfo = findType(spec.type);
	const output: OutputKind = typeInfo?.output ?? "text";

	let url = joinUrl(withPort(spec.baseUrl, spec.port), defaultPath(spec));
	let body: RequestBody | undefined;
	let responseKind: BuiltRequest["responseKind"] = "auto";

	switch (spec.protocol) {
		case "openai-chat": {
			const content: unknown[] = [];
			if (prompt) content.push({ type: "text", text: prompt });
			for (const input of inputs) {
				if (input.kind === "image") {
					content.push({ type: "image_url", image_url: { url: dataUrl(input) } });
				} else if (input.kind === "audio") {
					content.push({
						type: "input_audio",
						input_audio: {
							data: input.data ?? "",
							format: extForMime(input.mimeType, "wav"),
						},
					});
				} else if (input.kind === "video") {
					throw new Error("The openai-chat protocol does not accept video input; use a video-to-video specialist or extract frames first.");
				}
			}
			const hasMedia = content.some((part) => (part as { type?: string }).type !== "text");
			const payload: Record<string, unknown> = {
				model: spec.model,
				messages: [
					{
						role: "user",
						content: hasMedia ? content : prompt,
					},
				],
				...spec.body,
				...options,
			};
			body = JSON.stringify(payload);
			headers["Content-Type"] = "application/json";
			responseKind = "auto";
			break;
		}

		case "openai-images": {
			const hasImage = inputs.some((input) => input.kind === "image");
			if (hasImage && !spec.path) url = joinUrl(withPort(spec.baseUrl, spec.port), "/images/edits");
			if (hasImage) {
				const form = new FormData();
				const image = inputs.find((input) => input.kind === "image")!;
				form.append("image", inputBlob(image), inputFilename(image, "png"));
				if (prompt) form.append("prompt", prompt);
				if (spec.model) form.append("model", spec.model);
				for (const [key, value] of Object.entries({ ...spec.body, ...options })) {
					if (value === undefined || value === null) continue;
					form.append(key, typeof value === "string" ? value : JSON.stringify(value));
				}
				if (!form.has("response_format")) form.append("response_format", "b64_json");
				body = form;
				delete headers["Content-Type"];
			} else {
				const payload: Record<string, unknown> = {
					model: spec.model,
					prompt,
					n: 1,
					response_format: "b64_json",
					...spec.body,
					...options,
				};
				body = JSON.stringify(payload);
				headers["Content-Type"] = "application/json";
			}
			responseKind = "json";
			break;
		}

		case "openai-speech": {
			const payload: Record<string, unknown> = {
				model: spec.model,
				input: prompt,
				voice: "alloy",
				response_format: "mp3",
				...spec.body,
				...options,
			};
			body = JSON.stringify(payload);
			headers["Content-Type"] = "application/json";
			responseKind = "binary";
			break;
		}

		case "openai-transcriptions": {
			const audio = inputs.find((input) => input.kind === "audio" || input.kind === "file");
			if (!audio) throw new Error("An audio file input is required for transcription.");
			const form = new FormData();
			form.append("file", inputBlob(audio), inputFilename(audio, "mp3"));
			if (spec.model) form.append("model", spec.model);
			if (prompt) form.append("prompt", prompt);
			for (const [key, value] of Object.entries({ ...spec.body, ...options })) {
				if (value === undefined || value === null) continue;
				form.append(key, typeof value === "string" ? value : JSON.stringify(value));
			}
			if (!form.has("response_format")) form.append("response_format", "json");
			body = form;
			delete headers["Content-Type"];
			responseKind = "auto";
			break;
		}

		case "openai-embeddings": {
			const payload: Record<string, unknown> = {
				model: spec.model,
				input: prompt || first?.url || "",
				...spec.body,
				...options,
			};
			body = JSON.stringify(payload);
			headers["Content-Type"] = "application/json";
			responseKind = "json";
			break;
		}

		case "decision": {
			// System-1 sidecars (transformers + torch) take a state and named
			// questions and answer in one pass, without generating tokens.
			const options = request.options ?? {};
			const state =
				(typeof options.state === "string" ? options.state : undefined) ??
				(typeof spec.body.state === "string" ? spec.body.state : undefined) ??
				prompt;
			const questions = normalizeDecisionQuestions(options.questions ?? spec.body.questions, prompt);
			const media = inputs.map(decisionMedia).filter((item): item is Record<string, string> => !!item);
			const payload: Record<string, unknown> = {
				...spec.body,
				state,
				questions,
				...(media.length > 0 ? { media } : {}),
			};
			body = JSON.stringify(payload);
			headers["Content-Type"] = "application/json";
			responseKind = "json";
			break;
		}

		case "comfyui": {
			const workflow = spec.body.workflow;
			if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
				throw new Error('The comfyui protocol requires a workflow object in "body.workflow"');
			}
			const bodyWithoutWorkflow: Record<string, unknown> = { ...spec.body };
			delete bodyWithoutWorkflow.workflow;
			const width = Number(options.width ?? bodyWithoutWorkflow.width ?? 1024);
			const height = Number(options.height ?? bodyWithoutWorkflow.height ?? 1024);
			const context: Record<string, unknown> = {
				...bodyWithoutWorkflow,
				...options,
				prompt,
				negative_prompt: options.negative_prompt ?? bodyWithoutWorkflow.negative_prompt ?? "",
				seed:
					options.seed ??
					bodyWithoutWorkflow.seed ??
					Math.floor(Math.random() * 2 ** 31),
				width,
				height,
				resolution: Math.max(width, height),
				steps: options.steps ?? bodyWithoutWorkflow.steps ?? 25,
				cfg: options.cfg ?? bodyWithoutWorkflow.cfg ?? 1,
				sampler: options.sampler ?? bodyWithoutWorkflow.sampler ?? "euler",
				scheduler: options.scheduler ?? bodyWithoutWorkflow.scheduler ?? "simple",
				model: spec.model,
			};
			const graph = templateDeep(workflow, context);
			body = JSON.stringify({
				prompt: graph,
				client_id: `pi-specialists-${Date.now()}`,
			});
			headers["Content-Type"] = "application/json";
			responseKind = "json";
			break;
		}

		case "hf-inference": {
			if (inputs.length > 0) {
				body = inputBlob(first);
				headers["Content-Type"] = first.mimeType || "application/octet-stream";
			} else {
				const payload: Record<string, unknown> = {
					inputs: prompt,
					...(Object.keys(options).length > 0 ? { parameters: options } : {}),
					...spec.body,
				};
				body = JSON.stringify(payload);
				headers["Content-Type"] = "application/json";
			}
			responseKind = output === "json" || output === "text" || output === "vectors" ? "auto" : "binary";
			break;
		}

		case "replicate": {
			const model = spec.model ?? "";
			const looksLikeVersion = /^[a-f0-9]{40,64}$/i.test(model);
			if (!looksLikeVersion && model.includes("/") && !spec.path) {
				url = joinUrl(withPort(spec.baseUrl, spec.port), `/models/${model}/predictions`);
			}
			const input: Record<string, unknown> = {
				...(prompt ? { prompt } : {}),
				...(first ? { [first.kind === "audio" ? "audio" : first.kind === "video" ? "video" : "image"]: dataUrl(first) } : {}),
				...options,
				...spec.body,
			};
			const payload: Record<string, unknown> = looksLikeVersion
				? { version: model, input }
				: { input };
			body = JSON.stringify(payload);
			headers["Content-Type"] = "application/json";
			if (!headers.Prefer && spec.timeoutMs >= 60_000) headers.Prefer = "wait=60";
			responseKind = "json";
			break;
		}

		case "custom-json": {
			const ctx: Record<string, unknown> = {
				prompt,
				model: spec.model,
				input: first ? dataUrl(first) : undefined,
				input_url: first?.url,
				mime: first?.mimeType,
				options,
				...options,
			};
			const template =
				Object.keys(spec.body).length > 0
					? spec.body
					: {
							model: "{{model}}",
							prompt: "{{prompt}}",
							input: "{{input}}",
						};
			body = JSON.stringify(templateValue(template, ctx));
			headers["Content-Type"] = "application/json";
			responseKind = "auto";
			break;
		}
	}

	return { url: withQuery(url, query), method: "POST", headers, body, responseKind };
}

function textFromJson(json: unknown): string | undefined {
	if (typeof json === "string") return json;
	if (Array.isArray(json)) {
		const texts = json
			.map((item) => textFromJson(item))
			.filter((item): item is string => typeof item === "string" && item.length > 0);
		return texts.length > 0 ? texts.join("\n") : undefined;
	}
	if (!json || typeof json !== "object") return undefined;
	const obj = json as Record<string, unknown>;

	// OpenAI chat/completions
	const choices = obj.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		const message = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts = content
				.map((part) => (typeof part === "object" && part ? (part as Record<string, unknown>).text : undefined))
				.filter((part): part is string => typeof part === "string");
			if (parts.length) return parts.join("\n");
		}
		const text = (choices[0] as Record<string, unknown>)?.text;
		if (typeof text === "string") return text;
	}

	for (const key of ["text", "generated_text", "transcription", "transcript", "translated_text", "summary"]) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return value;
		if (Array.isArray(value) && value.length > 0) {
			const nested = textFromJson(value);
			if (nested) return nested;
		}
	}
	const output = obj.output;
	if (typeof output === "string" && output.trim()) return output;
	return undefined;
}

function binaryMime(contentType: string | null, spec: Specialist): string | undefined {
	if (contentType && !contentType.includes("application/json") && !contentType.startsWith("text/")) {
		return contentType.split(";")[0].trim();
	}
	const output = findType(spec.type)?.output;
	if (output === "image") return "image/png";
	if (output === "audio") return "audio/mpeg";
	if (output === "video") return "video/mp4";
	return undefined;
}

/**
 * Qwen3-ASR (via llama.cpp) returns "language Spanish<asr_text>Hello...".
 * Strip the prefix and keep the detected language as metadata.
 */
export function extractTranscript(text: string): { text: string; language?: string } | undefined {
	const match = /^\s*language\s+([^<\n]+?)\s*<asr_text>([\s\S]*)$/i.exec(text);
	if (!match) return undefined;
	return { language: match[1].trim(), text: match[2].trim() };
}

/** Parse a fetch response according to its content type and the protocol. */
export async function parseResponse(response: Response, spec: Specialist): Promise<ParsedResponse> {
	const contentType = response.headers.get("content-type");
	const isJson = (contentType ?? "").includes("json");
	const isText = (contentType ?? "").startsWith("text/") || contentType === null;

	if (!isJson && !isText) {
		const buffer = new Uint8Array(await response.arrayBuffer());
		const mimeType = binaryMime(contentType, spec);
		return { kind: "binary", data: buffer, mimeType, ext: extForMime(mimeType, "bin") };
	}

	if (isJson) {
		const json = (await response.json()) as unknown;
		// Hugging Face sometimes answers JSON with base64 or a media URL.
		const text = textFromJson(json);
		if (text !== undefined && findType(spec.type)?.output !== "image" && findType(spec.type)?.output !== "audio") {
			if (spec.protocol === "openai-transcriptions" || spec.type === "automatic-speech-recognition") {
				const transcript = extractTranscript(text);
				if (transcript) return { kind: "text", text: transcript.text, language: transcript.language, json };
			}
			return { kind: "text", text, json };
		}
		return { kind: "json", json };
	}

	const text = await response.text();
	return { kind: "text", text };
}

/**
 * Extract generated media from a JSON response:
 *   - OpenAI images: `data[].b64_json` / `data[].url`
 *   - Replicate: `output` string or array of URLs/base64 data URIs
 */
export function mediaRefsFromJson(json: unknown): Array<{ base64?: string; url?: string; mimeType?: string }> {
	const out: Array<{ base64?: string; url?: string; mimeType?: string }> = [];
	const push = (value: unknown): void => {
		if (typeof value !== "string" || !value.trim()) return;
		if (value.startsWith("data:")) {
			const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(value);
			if (match) out.push({ mimeType: match[1], base64: match[2] });
			return;
		}
		if (/^https?:\/\//i.test(value)) out.push({ url: value });
	};
	if (!json || typeof json !== "object") return out;
	const obj = json as Record<string, unknown>;
	const data = obj.data;
	if (Array.isArray(data)) {
		for (const item of data) {
			if (item && typeof item === "object") {
				const record = item as Record<string, unknown>;
				if (typeof record.b64_json === "string") out.push({ base64: record.b64_json, mimeType: "image/png" });
				push(record.url);
			}
		}
	}
	const output = obj.output;
	if (typeof output === "string") push(output);
	else if (Array.isArray(output)) for (const item of output) push(item);
	push(obj.url);
	return out;
}
