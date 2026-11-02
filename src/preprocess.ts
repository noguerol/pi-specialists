/**
 * Input preprocessing and expansion for batched specialist calls.
 *
 * Turns the tool's `input` values into the smallest set of work items that fit
 * the specialist budget:
 *   - directories are expanded recursively (depth 2)
 *   - PDFs become page images (pdftoppm) for image/OCR specialists
 *   - oversized images are resized/recompressed (ffmpeg)
 *   - long audio is split into chunks (ffmpeg)
 *   - text files are split at paragraph/sentence boundaries
 *   - urls and data URIs are materialised to temporary files first
 *
 * Everything created here lives in a temporary directory and is removed by
 * `cleanup()` after the batch finishes.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { Budget } from "./budget-types.ts";
import { findType } from "./catalog.ts";
import type { Specialist } from "./config.ts";

const run = promisify(execFile);
const MAX_DEPTH = 2;
const COMMAND_TIMEOUT_MS = 180_000;

export type WorkKind = "image" | "audio" | "text" | "video" | "file";

export interface WorkItem {
	label: string;
	/** Prepared file path (image/audio/page). */
	path?: string;
	/** Text chunk for text specialists. */
	text?: string;
	kind: WorkKind;
	mimeType: string;
	/** Original path/URL, for diagnostics. */
	source?: string;
}

export interface PreparedInputs {
	items: WorkItem[];
	warnings: string[];
	cleanup: () => Promise<void>;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".wma"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"]);
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".log", ".yaml", ".yml", ".xml", ".html", ".htm"]);

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".avif": "image/avif",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".opus": "audio/opus",
	".wma": "audio/x-ms-wma",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
};

function mimeFor(path: string): string {
	return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function sanitize(name: string): string {
	return name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "item";
}

function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function formatClock(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

async function command(file: string, args: string[]): Promise<string> {
	const { stdout } = await run(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
	return stdout;
}

/** Split text at paragraph/line/sentence boundaries. */
export function splitText(text: string, maxChars: number): string[] {
	const clean = text.replace(/\r\n/g, "\n").trim();
	if (!clean) return [];
	if (clean.length <= maxChars) return [clean];
	const chunks: string[] = [];
	let rest = clean;
	while (rest.length > maxChars) {
		let cut = rest.lastIndexOf("\n\n", maxChars);
		if (cut < maxChars * 0.5) cut = rest.lastIndexOf("\n", maxChars);
		if (cut < maxChars * 0.5) cut = rest.lastIndexOf(". ", maxChars);
		if (cut < maxChars * 0.5) cut = maxChars;
		const chunk = rest.slice(0, cut).trim();
		if (chunk) chunks.push(chunk);
		rest = rest.slice(cut).trim();
	}
	if (rest) chunks.push(rest);
	return chunks;
}

/** Expand inputs into budget-sized work items. */
export async function prepareInputs(
	values: string[],
	spec: Specialist,
	budget: Budget,
	signal?: AbortSignal,
): Promise<PreparedInputs> {
	const info = findType(spec.type);
	const accepts = {
		image: info?.input.includes("image") ?? false,
		audio: info?.input.includes("audio") ?? false,
		text: info?.input.includes("text") ?? false,
		video: info?.input.includes("video") ?? false,
	};
	const warnings: string[] = [];
	const items: WorkItem[] = [];
	let tempDir: string | undefined;
	let counter = 0;
	let capped = false;

	const temp = async (): Promise<string> => {
		if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), "pi-specialists-prep-"));
		return tempDir;
	};

	const tempPath = async (name: string, ext: string): Promise<string> => {
		const dir = await temp();
		counter += 1;
		return join(dir, `${String(counter).padStart(3, "0")}-${sanitize(name)}${ext}`);
	};

	const cleanup = async (): Promise<void> => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		tempDir = undefined;
	};

	const add = (item: WorkItem): boolean => {
		if (items.length >= budget.maxItems) {
			if (!capped) {
				capped = true;
				warnings.push(`Limit of ${budget.maxItems} items reached; additional files were skipped.`);
			}
			return false;
		}
		items.push(item);
		return true;
	};

	const imageSize = async (path: string): Promise<{ width: number; height: number } | undefined> => {
		try {
			const out = await command("identify", ["-format", "%w %h", `${path}[0]`]);
			const [width, height] = out.trim().split(/\s+/).map(Number);
			if (width && height) return { width, height };
		} catch {
			// fall through to ffprobe
		}
		try {
			const out = await command("ffprobe", [
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height",
				"-of",
				"csv=p=0",
				path,
			]);
			const [width, height] = out.trim().split(",").map(Number);
			if (width && height) return { width, height };
		} catch {
			// ignore
		}
		return undefined;
	};

	const prepareImage = async (path: string, label: string, source?: string): Promise<void> => {
		const size = await imageSize(path);
		if (!size) {
			add({ label, path, kind: "image", mimeType: mimeFor(path), source });
			return;
		}
		const sideScale = Math.min(1, budget.maxImageSide / Math.max(size.width, size.height));
		const pixelScale = Math.min(1, Math.sqrt(budget.maxImagePixels / (size.width * size.height)));
		const scale = Math.min(sideScale, pixelScale);
		if (scale >= 0.999) {
			add({ label, path, kind: "image", mimeType: mimeFor(path), source });
			return;
		}
		const width = Math.max(1, Math.round(size.width * scale));
		const height = Math.max(1, Math.round(size.height * scale));
		const target = await tempPath(basename(path, extname(path)), ".jpg");
		try {
			await command("ffmpeg", [
				"-y",
				"-loglevel",
				"error",
				"-i",
				path,
				"-vf",
				`scale=${width}:${height}:force_original_aspect_ratio=decrease`,
				"-frames:v",
				"1",
				"-q:v",
				"2",
				target,
			]);
			warnings.push(`${label}: ${size.width}x${size.height} → ${width}x${height} to fit the budget.`);
			add({ label, path: target, kind: "image", mimeType: "image/jpeg", source });
		} catch {
			warnings.push(`${label}: could not resize; sending the original.`);
			add({ label, path, kind: "image", mimeType: mimeFor(path), source });
		}
	};

	const mediaDuration = async (path: string): Promise<number | undefined> => {
		try {
			const out = await command("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=nw=1:nk=1",
				path,
			]);
			const duration = Number(out.trim());
			return Number.isFinite(duration) && duration > 0 ? duration : undefined;
		} catch {
			return undefined;
		}
	};

	const prepareAudio = async (path: string, label: string, source?: string): Promise<void> => {
		const duration = await mediaDuration(path);
		if (!duration || duration <= budget.maxAudioSeconds + 1) {
			add({ label, path, kind: "audio", mimeType: mimeFor(path), source });
			return;
		}
		const dir = await temp();
		const prefix = join(dir, `${String(++counter).padStart(3, "0")}-${sanitize(basename(path, extname(path)))}`);
		try {
			await command("ffmpeg", [
				"-y",
				"-loglevel",
				"error",
				"-i",
				path,
				"-ar",
				"16000",
				"-ac",
				"1",
				"-f",
				"segment",
				"-segment_time",
				String(budget.maxAudioSeconds),
				"-reset_timestamps",
				"1",
				`${prefix}-%03d.wav`,
			]);
			const files = (await readdir(dir))
				.filter((file) => file.startsWith(basename(prefix) + "-") && file.endsWith(".wav"))
				.sort(naturalCompare);
			if (files.length === 0) throw new Error("no chunks");
			warnings.push(`${label}: ${formatClock(duration)} → ${files.length} chunks of ${budget.maxAudioSeconds}s.`);
			files.forEach((file, index) => {
				const start = index * budget.maxAudioSeconds;
				const end = Math.min(duration, start + budget.maxAudioSeconds);
				add({
					label: `${label} [${formatClock(start)}–${formatClock(end)}]`,
					path: join(dir, file),
					kind: "audio",
					mimeType: "audio/wav",
					source,
				});
			});
		} catch {
			warnings.push(`${label}: could not split the audio; sending it whole.`);
			add({ label, path, kind: "audio", mimeType: mimeFor(path), source });
		}
	};

	const prepareText = async (path: string, label: string, source?: string): Promise<void> => {
		let text: string;
		try {
			text = await readFile(path, "utf-8");
		} catch (error) {
			warnings.push(`${label}: could not read it (${error instanceof Error ? error.message : String(error)}).`);
			return;
		}
		const reserve = budget.maxOutputTokens + 256;
		const available = Math.max(512, (budget.contextTokens ?? 4_096) - reserve);
		const maxChars = Math.max(1_000, Math.floor(available * 4 * 0.9));
		const chunks = splitText(text, maxChars);
		if (chunks.length === 0) {
			warnings.push(`${label}: empty.`);
			return;
		}
		chunks.forEach((chunk, index) => {
			add({
				label: chunks.length > 1 ? `${label} [${index + 1}/${chunks.length}]` : label,
				text: chunk,
				kind: "text",
				mimeType: "text/plain",
				source,
			});
		});
	};

	const preparePdf = async (path: string, label: string, source?: string): Promise<void> => {
		let pages = 0;
		try {
			const infoOut = await command("pdfinfo", [path]);
			const match = /^Pages:\s+(\d+)/m.exec(infoOut);
			pages = match ? Number(match[1]) : 0;
		} catch {
			// pdftoppm will fail with a clearer error
		}
		const wanted = pages > 0 ? Math.min(pages, budget.maxItems) : budget.maxItems;
		const dir = await temp();
		const prefix = join(dir, `${String(++counter).padStart(3, "0")}-${sanitize(basename(path, extname(path)))}`);
		try {
			await command("pdftoppm", [
				"-png",
				"-r",
				String(budget.pdfDpi),
				"-f",
				"1",
				"-l",
				String(wanted),
				path,
				prefix,
			]);
			const files = (await readdir(dir))
				.filter((file) => file.startsWith(basename(prefix) + "-") && file.endsWith(".png"))
				.sort(naturalCompare);
			if (files.length === 0) throw new Error("no pages");
			if (pages > files.length) warnings.push(`${label}: ${pages} pages, processing ${files.length}.`);
			for (let index = 0; index < files.length; index++) {
				await prepareImage(join(dir, files[index]), `${label} p.${index + 1}`, source);
			}
		} catch (error) {
			warnings.push(
				`${label}: could not convert the PDF (${error instanceof Error ? error.message : String(error)}); is poppler-utils installed?`,
			);
		}
	};

	const prepareFile = async (path: string, label: string): Promise<void> => {
		const ext = extname(path).toLowerCase();
		const source = path;
		if (ext === ".pdf") {
			if (!accepts.image) {
				warnings.push(`${label}: PDF skipped (the specialist does not accept images).`);
				return;
			}
			await preparePdf(path, label, source);
			return;
		}
		if (IMAGE_EXT.has(ext)) {
			if (!accepts.image) {
				warnings.push(`${label}: image skipped (the specialist does not accept images).`);
				return;
			}
			await prepareImage(path, label, source);
			return;
		}
		if (AUDIO_EXT.has(ext)) {
			if (!accepts.audio) {
				warnings.push(`${label}: audio skipped (the specialist does not accept audio).`);
				return;
			}
			await prepareAudio(path, label, source);
			return;
		}
		if (TEXT_EXT.has(ext)) {
			if (!accepts.text) {
				warnings.push(`${label}: text skipped (the specialist does not accept text).`);
				return;
			}
			await prepareText(path, label, source);
			return;
		}
		if (VIDEO_EXT.has(ext)) {
			if (!accepts.video) {
				warnings.push(`${label}: video skipped (the specialist does not accept video).`);
				return;
			}
			add({ label, path, kind: "video", mimeType: mimeFor(path), source });
			return;
		}
		warnings.push(`${label}: unsupported file type.`);
	};

	const expandDirectory = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH || items.length >= budget.maxItems) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			warnings.push(`${dir}: could not list it (${error instanceof Error ? error.message : String(error)}).`);
			return;
		}
		entries.sort((a, b) => naturalCompare(a.name, b.name));
		for (const entry of entries) {
			if (items.length >= budget.maxItems) return;
			if (entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await expandDirectory(path, depth + 1);
			else if (entry.isFile()) await prepareFile(path, entry.name);
		}
	};

	let inputIndex = 0;
	for (const raw of values) {
		if (items.length >= budget.maxItems) break;
		const value = String(raw).trim();
		if (!value) continue;
		inputIndex += 1;
		const label = `input-${inputIndex}`;
		try {
			const dataUri = /^data:([^;,]+)?;base64,(.+)$/s.exec(value);
			if (dataUri) {
				const ext = dataUri[1]?.includes("pdf")
					? ".pdf"
					: dataUri[1]?.startsWith("image/")
						? ".png"
						: dataUri[1]?.startsWith("audio/")
							? ".wav"
							: ".bin";
				const path = await tempPath(label, ext);
				await writeFile(path, Buffer.from(dataUri[2], "base64"));
				await prepareFile(path, `${label}${ext}`);
				continue;
			}
			if (/^https?:\/\//i.test(value)) {
				const timeout = AbortSignal.timeout(60_000);
				const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
				const response = await fetch(value, { signal: combined });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const buffer = Buffer.from(await response.arrayBuffer());
				const urlPath = new URL(value).pathname;
				const ext = extname(urlPath) || ".bin";
				const path = await tempPath(basename(urlPath, extname(urlPath)) || label, ext);
				await writeFile(path, buffer);
				await prepareFile(path, basename(urlPath) || label);
				continue;
			}
			const infoStat = await stat(value);
			if (infoStat.isDirectory()) await expandDirectory(value, 0);
			else await prepareFile(value, basename(value));
		} catch (error) {
			warnings.push(`${value}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { items, warnings, cleanup };
}

/** Whether values include anything that needs expansion/preprocessing. */
export async function wantsPreprocessing(values: string[], spec: Specialist): Promise<boolean> {
	if (values.length > 1) return true;
	if (values.length === 0) return false;
	const info = findType(spec.type);
	const acceptsImage = info?.input.includes("image") ?? false;
	const acceptsAudio = info?.input.includes("audio") ?? false;
	const acceptsText = info?.input.includes("text") ?? false;
	for (const value of values) {
		const clean = String(value).split("?")[0];
		if (/^data:/i.test(clean)) continue;
		if (/^https?:\/\//i.test(clean)) {
			const ext = extname(new URL(clean).pathname).toLowerCase();
			if (ext === ".pdf" && acceptsImage) return true;
			if (AUDIO_EXT.has(ext) && acceptsAudio) return true;
			if (TEXT_EXT.has(ext) && acceptsText) return true;
			continue;
		}
		try {
			if ((await stat(clean)).isDirectory()) return true;
		} catch {
			// Missing paths are reported by executeSingle.
		}
		const ext = extname(clean).toLowerCase();
		if (ext === ".pdf" && acceptsImage) return true;
		if (AUDIO_EXT.has(ext) && acceptsAudio) return true;
		if (IMAGE_EXT.has(ext) && acceptsImage) return true;
		if (TEXT_EXT.has(ext) && acceptsText) return true;
	}
	return false;
}
