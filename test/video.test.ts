import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSpecialist } from "../src/config.ts";
import { analyzeVideo, planFrames, probeVideo } from "../src/video.ts";

function has(command: string): boolean {
	try {
		execFileSync("which", [command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function makeVideo(path: string): Promise<boolean> {
	try {
		execFileSync(
			"ffmpeg",
			[
				"-y",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc=size=160x120:rate=10",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:sample_rate=16000",
				"-t",
				"2",
				"-c:v",
				"mpeg4",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				path,
			],
			{ stdio: "ignore", timeout: 60_000 },
		);
		return true;
	} catch {
		return false;
	}
}

test("planFrames samples 1 fps up to 12, then evenly spaced", () => {
	const short = planFrames(2);
	assert.equal(short.frames, 2);
	assert.equal(short.interval, 1);
	assert.deepEqual(short.timestamps, [0, 1]);

	const ten = planFrames(10);
	assert.equal(ten.frames, 10);
	assert.equal(ten.interval, 1);

	const long = planFrames(60);
	assert.equal(long.frames, 12);
	assert.equal(long.interval, 5);
	assert.equal(long.timestamps.length, 12);
	assert.ok(long.timestamps.every((time) => time >= 0 && time <= 60));

	const explicit = planFrames(60, { frames: 5 });
	assert.equal(explicit.frames, 5);
	assert.equal(explicit.interval, 12);

	const interval = planFrames(60, { interval: 5 });
	assert.equal(interval.frames, 12);

	const capped = planFrames(600, { frames: 48, maxFrames: 8 });
	assert.equal(capped.frames, 8);
});

test("probeVideo reads duration, resolution and audio", { skip: !has("ffmpeg") }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-video-probe-"));
	const video = join(dir, "clip.mp4");
	try {
		if (!(await makeVideo(video))) {
			t.skip("ffmpeg cannot create the test video");
			return;
		}
		const probe = await probeVideo(video);
		assert.equal(Math.round(probe.duration), 2);
		assert.equal(probe.width, 160);
		assert.equal(probe.height, 120);
		assert.equal(probe.hasVideo, true);
		assert.equal(probe.hasAudio, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("analyzeVideo builds a timeline and transcript", { skip: !has("ffmpeg") }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-video-test-"));
	const video = join(dir, "clip.mp4");
	if (!(await makeVideo(video))) {
		t.skip("ffmpeg cannot create the test video");
		await rm(dir, { recursive: true, force: true });
		return;
	}

	const requests: string[] = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const url = (req.url ?? "").split("?")[0];
			requests.push(url);
			if (url === "/v1/chat/completions") {
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({ choices: [{ message: { content: "a frame description" } }] }),
				);
				return;
			}
			if (url === "/audio/transcriptions") {
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({ type: "transcript.text.done", text: "language Spanish<asr_text>hello from the clip" }),
				);
				return;
			}
			res.writeHead(404).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		const vision = normalizeSpecialist({
			name: "Vision",
			type: "image-to-text",
			baseUrl: `${baseUrl}/v1`,
			model: "m",
			budget: { contextTokens: 4096, maxOutputTokens: 256 },
		});
		const stt = normalizeSpecialist({
			name: "ASR",
			type: "automatic-speech-recognition",
			baseUrl,
			model: "m",
			budget: { contextTokens: 16000, maxAudioSeconds: 30, maxOutputTokens: 256 },
		});
		const result = await analyzeVideo(video, vision, stt, {
			frames: 2,
			outputDir: dir,
			prompt: "Describe the frame",
			onProgress: () => {},
		});
		assert.equal(result.details.frames, 2);
		assert.equal(result.details.language, "Spanish");
		assert.equal(result.details.vision, "Vision");
		assert.equal(result.details.stt, "ASR");
		assert.ok(result.text.includes("## Visual timeline"));
		assert.match(result.text, /### Frame 1 · t=00:00/);
		assert.match(result.text, /### Frame 2 · t=00:01/);
		assert.ok(result.text.includes("a frame description"));
		assert.ok(result.text.includes("## Audio transcript"));
		assert.ok(result.text.includes("hello from the clip"));
		const outputFile = result.details.outputFile as string;
		assert.ok(existsSync(outputFile));
		assert.ok((await readFile(outputFile, "utf-8")).includes("hello from the clip"));
		assert.equal(requests.filter((url) => url === "/v1/chat/completions").length, 2);
		assert.equal(requests.filter((url) => url === "/audio/transcriptions").length, 1);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

test("analyzeVideo requires at least one specialist", async () => {
	await assert.rejects(() => analyzeVideo("/does/not/exist.mp4", undefined, undefined), /Configure an image-to-text/);
});
