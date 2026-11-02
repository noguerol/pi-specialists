import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, runningLine, summarizeTask, truncate, type RunningInfo } from "../src/status.ts";

test("formatElapsed shows wallclock with useful precision", () => {
	assert.equal(formatElapsed(0), "0.0s");
	assert.equal(formatElapsed(250), "0.3s");
	assert.equal(formatElapsed(1_500), "1.5s");
	assert.equal(formatElapsed(9_900), "9.9s");
	assert.equal(formatElapsed(9_999), "10s");
	assert.equal(formatElapsed(12_400), "12s");
	assert.equal(formatElapsed(65_000), "1m05s");
	assert.equal(formatElapsed(125_000), "2m05s");
});

test("summarizeTask combines prompt and input file", () => {
	assert.equal(summarizeTask("Describe the image", ["/data/images/sample.jpg"]), "Describe the image · sample.jpg");
	assert.equal(summarizeTask("clasifica", ["https://x.test/a.png?token=1"]), "clasifica · a.png");
	assert.equal(summarizeTask(undefined, ["data:image/png;base64,xxx"]), "inline");
	assert.equal(summarizeTask("  several   lines\n", []), "several lines");
	assert.equal(summarizeTask(undefined, [], "ocr"), "task ocr");
	assert.equal(summarizeTask(undefined, []), "running");
});

test("truncate respects the budget and adds an ellipsis", () => {
	assert.equal(truncate("short", 10), "short");
	assert.equal(truncate("0123456789abcdef", 8), "0123456…");
	assert.equal(truncate("anything", 1), "…");
});

const job = (name: string, type: string, summary: string, startedAt: number): RunningInfo => ({
	name,
	type,
	summary,
	startedAt,
});

test("runningLine is empty when there are no jobs", () => {
	assert.equal(runningLine([]), "");
});

test("runningLine shows specialist, task and wallclock", () => {
	const line = runningLine([job("vision", "image-to-text", "Describe the image · sample.jpg", 1_000)], 2_500);
	assert.equal(line, "⏳ 👁️ vision: Describe the image · sample.jpg 1.5s");
	assert.ok(line.startsWith("⏳"));
});

test("runningLine aggregates several specialists in one line", () => {
	const line = runningLine(
		[
			job("vision", "image-to-text", "Describe the image", 0),
			job("Decider", "system-1", "Clasifica el prompt", 500),
		],
		2_000,
	);
	assert.ok(line.includes("👁️ vision: Describe the image 2.0s"));
	assert.ok(line.includes("⚡ Decider: Clasifica el prompt 1.5s"));
	assert.equal(line.split(" · ").length, 2);
});

test("runningLine keeps at most three entries and summarises the rest", () => {
	const line = runningLine(
		[
			job("a", "ocr", "uno", 0),
			job("b", "system-1", "dos", 0),
			job("c", "text-to-image", "tres", 0),
			job("d", "tts", "cuatro", 0),
			job("e", "asr", "cinco", 0),
		],
		1_000,
	);
	assert.ok(line.endsWith("+2"), line);
	assert.ok(!line.includes("cinco"), line);
});

test("runningLine truncates long names, tasks and updates the elapsed time", () => {
	const line = runningLine(
		[job("un-nombre-de-especialista-muy-largo", "system-1", "x".repeat(200), 0)],
		12_000,
	);
	assert.ok(line.includes("…"), line);
	assert.ok(line.endsWith("12s"), line);
	assert.ok(line.length < 130, `line too long: ${line.length}`);
});
