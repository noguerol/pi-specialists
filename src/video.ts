/**
 * Video analysis pipeline.
 *
 * 1. Probe duration / resolution / audio track with ffprobe.
 * 2. Plan evenly spaced frames: 1 fps up to 12 frames, then evenly spaced
 *    across longer videos (or an explicit `frames` / `interval`).
 * 3. Extract frames with ffmpeg and describe them with an image-to-text
 *    specialist (budget-aware batching).
 * 4. Extract audio to 16 kHz mono and transcribe it with an ASR specialist.
 * 5. Write a markdown report with a visual timeline and the transcript.
 *
 * The pipeline is independent from pi so it can be tested with plain Node.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { Specialist } from "./config.ts";
import { executeSpecialist, type SpecialistRunResult } from "./execute.ts";

const run = promisify(execFile);

export interface VideoProbe {
	duration: number;
	width?: number;
	height?: number;
	hasVideo: boolean;
	hasAudio: boolean;
	format?: string;
}

export interface FramePlan {
	frames: number;
	interval: number;
	timestamps: number[];
	/** Why the plan looks like this (shown in the report). */
	reason: string;
}

export interface VideoAnalysisOptions {
	frames?: number;
	interval?: number;
	maxFrames?: number;
	prompt?: string;
	output?: string;
	outputDir?: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

interface ExtractedFrame {
	path: string;
	time: number;
}

const DEFAULT_FRAMES = 12;
const DEFAULT_MAX_FRAMES = 24;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_FRAME_PROMPT =
	"You are analyzing one frame of a video. Describe what is visible: setting, people, objects, actions, on-screen text (quote it exactly), and anything that changes over time. Be concise and factual. Do not invent details.";

function clock(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function stamp(): string {
	const d = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeBase(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "video";
}

function displayName(value: string): string {
	try {
		if (/^https?:\/\//i.test(value)) return basename(new URL(value).pathname) || "video";
	} catch {
		// use the raw value
	}
	return basename(value) || "video";
}

const DIRECT_MEDIA_EXT = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".ogv", ".mpg", ".mpeg"]);

function hasDirectMediaExtension(value: string): boolean {
	try {
		const path = /^https?:\/\//i.test(value) ? new URL(value).pathname : value;
		return DIRECT_MEDIA_EXT.has(extname(path).toLowerCase());
	} catch {
		return false;
	}
}

function errorDetail(error: unknown): string {
	const object = error as { stderr?: string; stdout?: string; message?: string };
	return (object.stderr || object.stdout || object.message || String(error)).trim().slice(-800);
}

/**
 * Download a webpage/YouTube URL with yt-dlp when needed. Direct media URLs
 * are left to ffmpeg/ffprobe. The binary can be overridden with
 * PI_SPECIALISTS_YTDLP (or YT_DLP).
 */
async function materializeVideo(
	video: string,
	dir: string,
	signal?: AbortSignal,
): Promise<{ source: string; downloaded: boolean; title?: string }> {
	if (!/^https?:\/\//i.test(video) || hasDirectMediaExtension(video)) {
		return { source: video, downloaded: false };
	}
	const ytdlp = process.env.PI_SPECIALISTS_YTDLP || process.env.YT_DLP || "yt-dlp";
	const target = join(dir, "source.%(ext)s");
	try {
		await command(
			ytdlp,
			[
				"--no-playlist",
				"-f",
				"bv*[height<=720]+ba/b[height<=720]",
				"--merge-output-format",
				"mp4",
				"--write-info-json",
				"-o",
				target,
				video,
			],
			signal,
		);
	} catch (error) {
		const detail = errorDetail(error);
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				"yt-dlp is required to analyze this URL. Install yt-dlp (or set PI_SPECIALISTS_YTDLP) or pass a local media file.",
			);
		}
		throw new Error(`yt-dlp failed for ${video}: ${detail || "unknown error"}`);
	}
	const files = (await readdir(dir)).filter(
		(file) => file.startsWith("source.") && !file.endsWith(".part") && !file.endsWith(".info.json"),
	);
	if (files.length === 0) throw new Error("yt-dlp finished without producing a media file");
	let title: string | undefined;
	const infoFile = (await readdir(dir)).find((file) => file.startsWith("source.") && file.endsWith(".info.json"));
	if (infoFile) {
		try {
			const info = JSON.parse(await readFile(join(dir, infoFile), "utf-8")) as { title?: unknown };
			if (typeof info.title === "string" && info.title.trim()) title = info.title.trim();
		} catch {
			// metadata is optional
		}
	}
	return { source: join(dir, files[0]), downloaded: true, ...(title ? { title } : {}) };
}

async function command(file: string, args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await run(file, args, {
		timeout: COMMAND_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		signal,
	});
	return stdout;
}

/** Probe duration, dimensions and audio/video tracks. */
export async function probeVideo(path: string, signal?: AbortSignal): Promise<VideoProbe> {
	let output: string;
	try {
		output = await command(
			"ffprobe",
			[
				"-v",
				"error",
				"-print_format",
				"json",
				"-show_format",
				"-show_streams",
				path,
			],
			signal,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("ffmpeg/ffprobe is required for video analysis");
		}
		throw error;
	}
	const data = JSON.parse(output) as {
		format?: { duration?: string; format_name?: string };
		streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
	};
	const streams = data.streams ?? [];
	const video = streams.find((stream) => stream.codec_type === "video");
	const audio = streams.find((stream) => stream.codec_type === "audio");
	const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error("Could not determine the video duration (is this a valid media file?)");
	}
	return {
		duration,
		width: video?.width,
		height: video?.height,
		hasVideo: !!video,
		hasAudio: !!audio,
		format: data.format?.format_name,
	};
}

/**
 * Choose frame count/timestamps.
 *
 * Default: one frame per second for clips up to 12 s; longer videos get 12
 * evenly spaced frames. An explicit `frames` or `interval` overrides that.
 */
export function planFrames(duration: number, options: Pick<VideoAnalysisOptions, "frames" | "interval" | "maxFrames"> = {}): FramePlan {
	const safeDuration = Math.max(0.001, duration);
	const maxFrames = Math.max(1, Math.min(48, Math.round(options.maxFrames ?? DEFAULT_MAX_FRAMES)));
	let frames: number;
	let reason: string;
	if (options.interval !== undefined && options.interval > 0) {
		frames = Math.ceil(safeDuration / options.interval);
		reason = `explicit interval ${options.interval}s`;
	} else if (options.frames !== undefined && options.frames > 0) {
		frames = Math.round(options.frames);
		reason = "explicit frame count";
	} else {
		frames = Math.min(DEFAULT_FRAMES, Math.ceil(safeDuration));
		reason = safeDuration <= DEFAULT_FRAMES ? "1 fps" : `${DEFAULT_FRAMES} evenly spaced frames`;
	}
	frames = Math.max(1, Math.min(maxFrames, frames));
	const interval = safeDuration / frames;
	const timestamps = Array.from({ length: frames }, (_, index) =>
		Math.min(Math.max(0, safeDuration - 0.01), index * interval),
	);
	return { frames, interval, timestamps, reason };
}

async function extractFrames(
	video: string,
	plan: FramePlan,
	dir: string,
	duration: number,
	signal?: AbortSignal,
): Promise<ExtractedFrame[]> {
	const files: string[] = [];
	if (duration > 30) {
		// Long videos: seek to each timestamp instead of decoding the whole
		// timeline. Input seeking is fast and keeps memory/CPU bounded.
		for (let index = 0; index < plan.frames; index++) {
			const name = `frame-${String(index + 1).padStart(4, "0")}.jpg`;
			const target = join(dir, name);
			try {
				await command(
					"ffmpeg",
					[
						"-y",
						"-loglevel",
						"error",
						"-ss",
						String(plan.timestamps[index]),
						"-i",
						video,
						"-frames:v",
						"1",
						"-q:v",
						"2",
						target,
					],
					signal,
				);
				files.push(name);
			} catch {
				// Skip a frame that cannot be decoded; keep the rest.
			}
		}
	} else {
		const fps = 1 / Math.max(0.001, plan.interval);
		await command(
			"ffmpeg",
			[
				"-y",
				"-loglevel",
				"error",
				"-i",
				video,
				"-vf",
				`fps=${fps}`,
				"-frames:v",
				String(plan.frames),
				"-q:v",
				"2",
				join(dir, "frame-%04d.jpg"),
			],
			signal,
		);
		files.push(
			...(await readdir(dir)).filter((file) => /^frame-\d+\.jpg$/.test(file)).sort(),
		);
	}
	if (files.length === 0) throw new Error("ffmpeg produced no frames");
	// Use the planned timestamps for the frames we actually got.
	return files.map((file, index) => ({
		path: join(dir, file),
		time: plan.timestamps[Math.min(index, plan.timestamps.length - 1)],
	}));
}

async function extractAudio(video: string, dir: string, signal?: AbortSignal): Promise<string | undefined> {
	const path = join(dir, "audio.wav");
	try {
		await command(
			"ffmpeg",
			["-y", "-loglevel", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path],
			signal,
		);
		const info = await stat(path);
		return info.size > 44 ? path : undefined;
	} catch {
		return undefined;
	}
}

function stripBatchHeader(text: string): string {
	const index = text.indexOf("\n## ");
	return index >= 0 ? text.slice(index + 1).trim() : text.trim();
}

function buildTimeline(visionText: string, frames: ExtractedFrame[]): string {
	const byName = new Map(frames.map((frame, index) => [basename(frame.path), { frame, index }]));
	let text = visionText;
	const firstSection = text.indexOf("\n## ");
	if (firstSection >= 0) text = text.slice(firstSection + 1);
	text = text.replace(/^## (frame-\d+\.(?:jpg|jpeg|png))$/gm, (_match, file: string) => {
		const entry = byName.get(file);
		return entry ? `### Frame ${entry.index + 1} · t=${clock(entry.frame.time)}` : `### ${file}`;
	});
	if (!text.trim().startsWith("###")) {
		const first = frames[0];
		text = `### Frame 1 · t=${clock(first?.time ?? 0)}\n${text.trim()}`;
	}
	return text.trim();
}

/**
 * Run the full pipeline. Returns a markdown report and a path to the saved
 * report; vision/audio failures degrade to warnings when the other half works.
 */
export async function analyzeVideo(
	video: string,
	vision: Specialist | undefined,
	stt: Specialist | undefined,
	options: VideoAnalysisOptions = {},
): Promise<SpecialistRunResult> {
	if (!vision && !stt) throw new Error("Configure an image-to-text specialist, an ASR specialist, or both");
	const warnings: string[] = [];
	const dir = await mkdtemp(join(tmpdir(), "pi-specialists-video-"));
	const frames: ExtractedFrame[] = [];
	let visionText = "";
	let transcript = "";
	let language: string | undefined;
	let audioPath: string | undefined;
	let source = video;
	let downloaded = false;
	let title = displayName(video);

	try {
		if (/^https?:\/\//i.test(video) && !hasDirectMediaExtension(video)) {
			options.onProgress?.("downloading URL");
			const materialized = await materializeVideo(video, dir, options.signal);
			source = materialized.source;
			downloaded = materialized.downloaded;
			if (materialized.title) title = materialized.title;
		}
		const probe = await probeVideo(source, options.signal);
		if (!probe.hasVideo) throw new Error("The input has no video stream");
		const plan = planFrames(probe.duration, options);
		options.onProgress?.(`probe ${clock(probe.duration)} · ${probe.width ?? "?"}x${probe.height ?? "?"}`);

		if (vision) {
			try {
				options.onProgress?.(`frames 0/${plan.frames}`);
				frames.push(...(await extractFrames(source, plan, dir, probe.duration, options.signal)));
				options.onProgress?.(`frames ${frames.length}/${plan.frames} · analyzing`);
				const result = await executeSpecialist(
					vision,
					{
						prompt: options.prompt ?? DEFAULT_FRAME_PROMPT,
						input: frames.map((frame) => frame.path),
					},
					{
						outputDir: options.outputDir,
						signal: options.signal,
						onProgress: (message) => options.onProgress?.(`vision ${message}`),
					},
				);
				visionText = buildTimeline(result.text, frames);
			} catch (error) {
				warnings.push(`vision analysis failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (stt && probe.hasAudio) {
			options.onProgress?.("audio extracting");
			audioPath = await extractAudio(source, dir, options.signal);
			if (!audioPath) {
				warnings.push("no usable audio track");
			} else {
				options.onProgress?.("audio transcribing");
				try {
					const result = await executeSpecialist(
						stt,
						{ input: [audioPath] },
						{
							outputDir: options.outputDir,
							signal: options.signal,
							onProgress: (message) => options.onProgress?.(`audio ${message}`),
						},
					);
					transcript = stripBatchHeader(result.text);
					if (typeof result.details.language === "string") language = result.details.language;
				} catch (error) {
					warnings.push(`transcription failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} else if (stt && !probe.hasAudio) {
			warnings.push("no audio stream");
		}

		if (!visionText && !transcript) {
			throw new Error(`Video analysis produced no result.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
		}

		const lines: string[] = [
			`# Video analysis: ${title}`,
			"",
			`- Duration: ${clock(probe.duration)}`,
			...(probe.width && probe.height ? [`- Resolution: ${probe.width}x${probe.height}`] : []),
			`- Frames: ${frames.length}${frames.length > 1 ? ` (~${plan.interval.toFixed(1)}s apart, ${plan.reason})` : ""}`,
			...(vision ? [`- Vision: ${vision.name} (${vision.type})`] : ["- Vision: not configured"]),
			...(stt ? [`- Audio: ${stt.name} (${stt.type})${language ? ` · ${language}` : ""}`] : ["- Audio: not configured"]),
			...(warnings.length > 0 ? [`- Warnings: ${warnings.join(" | ")}`] : []),
			"",
		];
		if (visionText) lines.push("## Visual timeline", "", visionText, "");
		if (transcript) lines.push("## Audio transcript", "", transcript, "");
		const report = `${lines.join("\n").trim()}\n`;

		const outputDir = options.outputDir ?? join(tmpdir(), "pi-specialists");
		await mkdir(outputDir, { recursive: true });
		const outputFile = options.output ?? join(outputDir, `${stamp()}-${safeBase(title)}-video.md`);
		await writeFile(outputFile, report);

		return {
			text: report,
			images: [],
			outputs: [],
			details: {
				video,
				title,
				...(downloaded ? { source: "downloaded" } : {}),
				duration: probe.duration,
				width: probe.width,
				height: probe.height,
				frames: frames.length,
				interval: plan.interval,
				vision: vision?.name,
				stt: stt?.name,
				language,
				outputFile,
				warnings,
			},
		};
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
