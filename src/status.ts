/**
 * Running-specialist status line.
 *
 * Pure formatting helpers for the footer segment shown while one or more
 * specialists are executing. Kept free of pi imports so it is unit-testable.
 *
 * Examples:
 *   ⏳ 👁️ vision-model: Describe the image · sample.jpg 1.5s
 *   ⏳ 👁️ vision-model: Describe the image 1.5s · ⚡ Decider: classify the prompt 0.3s
 *   ⏳ 👁️ a: … 3s · ⚡ b: … 2s · 🎨 c: … 1s · +2
 */

import { emojiForType } from "./catalog.ts";

export interface RunningInfo {
	name: string;
	type: string;
	/** Short task description (prompt + input, already human-readable). */
	summary: string;
	/** Epoch ms when the request started. */
	startedAt: number;
}

const MAX_ENTRIES = 3;

function clean(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

export function truncate(value: string, max: number): string {
	const text = clean(value);
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Human-readable wallclock: 0.4s, 9.9s, 12s, 1m05s. */
export function formatElapsed(ms: number): string {
	const value = Math.max(0, ms);
	const seconds = value / 1000;
	if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
	if (value < 59_500) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(value / 60_000);
	const rest = Math.round((value % 60_000) / 1000);
	return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

function inputLabel(input: string): string {
	const value = clean(input);
	if (!value) return "";
	if (value.startsWith("data:")) return "inline";
	if (/^https?:\/\//i.test(value)) {
		const withoutQuery = value.split("?")[0];
		return withoutQuery.split("/").pop() || withoutQuery;
	}
	return value.split("/").pop() || value;
}

/**
 * Summarise what the specialist was asked to do: the prompt, plus the input
 * file name when both exist. Falls back to the file, then to the type.
 */
export function summarizeTask(prompt: string | undefined, inputs: string[] = [], type?: string): string {
	const text = clean(prompt);
	const files = inputs.map(inputLabel).filter(Boolean);
	const file = files[0] ? truncate(files[0], 32) : "";
	if (text && file) return `${text} · ${file}`;
	if (text) return text;
	if (file) return file;
	return type ? `task ${type}` : "running";
}

/** Footer line for the running jobs; empty string when nothing is running. */
export function runningLine(jobs: RunningInfo[], now = Date.now()): string {
	if (jobs.length === 0) return "";
	const ordered = [...jobs].sort((a, b) => a.startedAt - b.startedAt);
	const shown = ordered.slice(0, MAX_ENTRIES);
	const summaryBudget = shown.length === 1 ? 64 : shown.length === 2 ? 30 : 18;
	const parts = shown.map((job) => {
		const emoji = emojiForType(job.type);
		const name = truncate(job.name, 20);
		const summary = truncate(job.summary, summaryBudget);
		const elapsed = formatElapsed(now - job.startedAt);
		return `${emoji} ${name}: ${summary} ${elapsed}`.trim();
	});
	const hidden = ordered.length - shown.length;
	return `⏳ ${parts.join(" · ")}${hidden > 0 ? ` · +${hidden}` : ""}`;
}
