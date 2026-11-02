import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSpecialist } from "../src/config.ts";
import { aspectLabel, captionPrompt, ensureAspect, outputDimensions, recreateImage, sanitizeCaption } from "../src/image-recreate.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function has(command: string): boolean {
	try {
		execFileSync("which", [command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function json(res: ServerResponse, value: unknown): void {
	res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

test("aspect ratio and output dimensions preserve the source shape", () => {
	assert.equal(aspectLabel(4_032, 3_024), "4:3");
	assert.equal(aspectLabel(1_920, 1_080), "16:9");
	assert.deepEqual(outputDimensions(4_032, 3_024, 1_024), { width: 1_024, height: 768 });
	assert.deepEqual(outputDimensions(3_024, 4_032, 1_024), { width: 768, height: 1_024 });
	assert.deepEqual(outputDimensions(400, 300, 512), { width: 512, height: 384 });
	assert.deepEqual(outputDimensions(1_000, 1_000, 1_024), { width: 1_024, height: 1_024 });
});

test("ensureAspect corrects guessed ratios and adds missing ones", () => {
	assert.equal(ensureAspect("A 16:9 landscape", "4:3"), "A 4:3 landscape");
	assert.equal(ensureAspect("A landscape", "4:3"), "4:3 aspect ratio. A landscape");
	assert.equal(ensureAspect("A 4:3 landscape", "4:3"), "A 4:3 landscape");
});

test("sanitizeCaption removes square/source-dimension contradictions", () => {
	const caption = sanitizeCaption(
		"A 16:9 landscape in a square format with exact dimensions of 4032x3024 pixels.",
		{ width: 4032, height: 3024 },
		{ width: 1024, height: 768 },
	);
	assert.ok(caption.includes("4:3"));
	assert.ok(!caption.includes("16:9"));
	assert.ok(!caption.toLowerCase().includes("square format"));
	assert.ok(caption.includes("1024x768"));
	assert.ok(!caption.includes("4032x3024"));
});

test("captionPrompt includes exact dimensions, aspect ratio and extra instructions", () => {
	const prompt = captionPrompt({ width: 400, height: 300 }, "Focus on the cloud");
	assert.ok(prompt.includes("400x300"));
	assert.ok(prompt.includes("4:3"));
	assert.ok(prompt.includes("Focus on the cloud"));
	assert.ok(prompt.includes("do not invent"));
});

test("recreateImage captions then generates at the source aspect ratio", { skip: !has("convert") }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-recreate-"));
	const image = join(dir, "source.png");
	execFileSync("convert", ["-size", "400x300", "xc:white", image], { stdio: "ignore" });
	const seen: Array<{ path: string; body: string }> = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const path = (req.url ?? "").split("?")[0];
			seen.push({ path, body });
			if (path === "/v1/chat/completions") {
				json(res, { choices: [{ message: { content: "A 16:9 white landscape prompt" } }] });
				return;
			}
			if (path === "/v1/images/generations") {
				json(res, { data: [{ b64_json: PNG.toString("base64") }] });
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
			model: "v",
			budget: { contextTokens: 4_096, maxOutputTokens: 256 },
		});
		const generator = normalizeSpecialist({
			name: "Generator",
			type: "text-to-image",
			protocol: "openai-images",
			baseUrl: `${baseUrl}/v1`,
			model: "g",
			budget: { contextTokens: 4_096, maxOutputTokens: 256 },
		});
		const output = join(dir, "recreated.png");
		const result = await recreateImage(vision, generator, image, {
			maxSide: 512,
			output,
			outputDir: dir,
		});
		assert.equal(result.outputs.length, 1);
		assert.equal(result.outputs[0].path, output);
		assert.ok(existsSync(output));
		assert.equal(readFileSync(output).subarray(0, 8).toString("hex"), PNG.subarray(0, 8).toString("hex"));
		assert.ok(result.text.includes("- Source: 400x300 (4:3)"));
		assert.ok(result.text.includes("- Output: 512x384"));
		assert.ok(result.text.includes("A 4:3 white landscape prompt"));
		const caption = result.details.caption as string;
		assert.ok(caption.includes("4:3"));
		assert.ok(caption.includes("512x384"));
		assert.ok(caption.includes("white landscape prompt"));
		const visionRequest = seen.find((entry) => entry.path === "/v1/chat/completions")!;
		assert.ok(visionRequest.body.includes("400x300"));
		assert.ok(visionRequest.body.includes("4:3"));
		const generatorRequest = seen.find((entry) => entry.path === "/v1/images/generations")!;
		const generatorBody = JSON.parse(generatorRequest.body) as { prompt: string; size: string };
		assert.equal(generatorBody.prompt, caption);
		assert.equal(generatorBody.size, "512x384");
		const reportFile = result.details.reportFile as string;
		assert.ok(existsSync(reportFile));
		assert.ok(readFileSync(reportFile, "utf-8").includes("Caption prompt"));
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});
