/**
 * Image recreation pipeline.
 *
 * Captions a source image with an image-to-text specialist, asks for a clean
 * text-to-image prompt that includes the source dimensions/aspect ratio, then
 * generates a new image with a text-to-image specialist at matching
 * dimensions. Returns the generated image and the caption used.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Specialist } from "./config.ts";
import { executeSpecialist, type SpecialistRunResult } from "./execute.ts";

const run = promisify(execFile);
const COMMAND_TIMEOUT_MS = 60_000;

export interface ImageSize {
	width: number;
	height: number;
}

export interface RecreateOptions {
	/** Extra instruction appended to the caption prompt. */
	prompt?: string;
	/** Maximum generated side (default 1024). */
	maxSide?: number;
	width?: number;
	height?: number;
	output?: string;
	outputDir?: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

export function aspectLabel(width: number, height: number): string {
	const divisor = gcd(width, height) || 1;
	return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

/** Fit the source aspect ratio into a max side, rounded to multiples of 16. */
export function outputDimensions(width: number, height: number, maxSide = 1_024): ImageSize {
	const limit = Math.max(256, Math.min(2_048, Math.round(maxSide)));
	const scale = limit / Math.max(width, height);
	const round16 = (value: number): number => Math.max(64, Math.round(value / 16) * 16);
	let w = round16(width * scale);
	let h = round16(height * scale);
	if (w > limit) w = limit;
	if (h > limit) h = limit;
	return { width: w, height: h };
}

async function imageSize(path: string): Promise<ImageSize | undefined> {
	try {
		const out = await run("identify", ["-format", "%w %h", `${path}[0]`], {
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const [width, height] = out.stdout.trim().split(/\s+/).map(Number);
		if (width && height) return { width, height };
	} catch {
		// fall back to ffprobe
	}
	try {
		const out = await run(
			"ffprobe",
			["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
			{ timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
		);
		const [width, height] = out.stdout.trim().split(",").map(Number);
		if (width && height) return { width, height };
	} catch {
		// dimensions are optional; use the default size
	}
	return undefined;
}

function stamp(): string {
	const d = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeBase(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "image";
}

/**
 * Guarantee that the final prompt contains the source aspect ratio. Small VLMs
 * sometimes guess a different ratio or omit it; the generator should always
 * receive the exact source shape (and the latent size matches it).
 */
export function ensureAspect(caption: string, aspect: string): string {
	const ratio = /\b\d{1,2}:\d{1,2}\b/g;
	const found = caption.match(ratio) ?? [];
	let result = caption;
	if (found.some((value) => value !== aspect)) result = result.replace(ratio, aspect);
	if (!result.includes(aspect)) result = `${aspect} aspect ratio. ${result}`;
	return result.trim();
}

/**
 * Normalise an LLM caption before handing it to the generator: force the
 * source aspect ratio, remove "square" claims for non-square images and replace
 * source pixel dimensions with the actual generation size.
 */
export function sanitizeCaption(caption: string, source: ImageSize, target: ImageSize): string {
	const aspect = aspectLabel(source.width, source.height);
	let result = ensureAspect(caption, aspect);
	if (aspect !== "1:1") {
		result = result.replace(/\bsquare (format|image|composition|frame|canvas)\b/gi, `${aspect} format`);
	}
	result = result.replace(/\b\d{3,5}\s*[x×]\s*\d{3,5}\b/g, `${target.width}x${target.height}`);
	if (!result.includes(`${target.width}x${target.height}`)) {
		result = `${aspect} aspect ratio, ${target.width}x${target.height}. ${result}`;
	}
	return result.trim();
}

export function captionPrompt(size: ImageSize, extra?: string): string {
	const aspect = aspectLabel(size.width, size.height);
	return [
		`Analyze this photograph and write one highly detailed text-to-image prompt that recreates it as closely as possible.`,
		`The source image is ${size.width}x${size.height} pixels, aspect ratio ${aspect}. Explicitly include that exact aspect ratio and the composition.`,
		`Describe only what is visible; do not invent grain, depth of field, style, or objects that are not present.`,
		`Include: main subject, setting/background, composition, camera position/angle and lens, lighting/time of day, color palette, textures, materials, mood, and any visible text.`,
		`Write it as imperative prompt language for an image generator, not as an analysis. Return only the prompt, with no preamble or markdown.`,
		...(extra ? [`Additional instructions: ${extra}`] : []),
	].join("\n");
}

/**
 * Caption the source with `vision`, then generate a matching image with
 * `generator`. Saves the caption/report and returns the generated media.
 */
export async function recreateImage(
	vision: Specialist,
	generator: Specialist,
	image: string,
	options: RecreateOptions = {},
): Promise<SpecialistRunResult> {
	const source = (await imageSize(image)) ?? { width: 1_024, height: 1_024 };
	const target = outputDimensions(source.width, source.height, options.maxSide ?? 1_024);
	const width = Math.max(64, Math.round(options.width ?? target.width));
	const height = Math.max(64, Math.round(options.height ?? target.height));
	const dir = await mkdtemp(join(tmpdir(), "pi-specialists-recreate-"));

	try {
		options.onProgress?.(`captioning ${source.width}x${source.height}`);
		const captionResult = await executeSpecialist(
			vision,
			{ prompt: captionPrompt(source, options.prompt), input: [image] },
			{
				signal: options.signal,
				outputDir: options.outputDir,
				onProgress: (message) => options.onProgress?.(`caption ${message}`),
			},
		);
		const rawCaption = captionResult.text.trim();
		if (!rawCaption) throw new Error("The image-to-text specialist returned an empty caption");
		const caption = sanitizeCaption(rawCaption, source, { width, height });

		options.onProgress?.(`generating ${width}x${height}`);
		const generated = await executeSpecialist(
			generator,
			{
				prompt: caption,
				options: {
					width,
					height,
					size: `${width}x${height}`,
				},
			},
			{
				output: options.output,
				outputDir: options.outputDir,
				signal: options.signal,
				onProgress: (message) => options.onProgress?.(`generate ${message}`),
			},
		);
		if (generated.outputs.length === 0) throw new Error("The image-to-text generator returned no image");

		const title = basename(image) || "image";
		const reportLines = [
			`# Image recreation: ${title}`,
			"",
			`- Source: ${source.width}x${source.height} (${aspectLabel(source.width, source.height)})`,
			`- Output: ${width}x${height}`,
			`- Vision: ${vision.name} (${vision.type})`,
			`- Generator: ${generator.name} (${generator.type})`,
			`- Generated: ${generated.outputs.map((media) => media.path).join(", ")}`,
			"",
			"## Caption prompt",
			"",
			caption,
			"",
		];
		const report = `${reportLines.join("\n").trim()}\n`;
		const outputDir = options.outputDir ?? join(tmpdir(), "pi-specialists");
		await mkdir(outputDir, { recursive: true });
		const reportFile = join(outputDir, `${stamp()}-${safeBase(title)}-recreate.md`);
		await writeFile(reportFile, report);

		return {
			text: report,
			images: generated.images,
			outputs: generated.outputs,
			json: generated.json,
			details: {
				image,
				sourceWidth: source.width,
				sourceHeight: source.height,
				aspect: aspectLabel(source.width, source.height),
				width,
				height,
				vision: vision.name,
				generator: generator.name,
				caption,
				reportFile,
				outputs: generated.outputs.map((media) => ({ path: media.path, mimeType: media.mimeType, bytes: media.bytes })),
			},
		};
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
