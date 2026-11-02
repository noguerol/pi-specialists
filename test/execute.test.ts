import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSpecialist } from "../src/config.ts";
import { executeSpecialist, resolveInputs } from "../src/execute.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

interface Seen {
	path: string;
	auth?: string;
	contentType?: string;
	body: string;
}

async function withServer(
	routes: Record<string, (req: IncomingMessage, res: ServerResponse, seen: Seen[]) => void>,
	run: (baseUrl: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const entry: Seen = {
				path: req.url ?? "",
				auth: req.headers.authorization,
				contentType: req.headers["content-type"],
				body: Buffer.concat(chunks).toString("utf-8"),
			};
			seen.push(entry);
			const path = (req.url ?? "").split("?")[0];
			const handler = routes[path];
			if (!handler) {
				res.writeHead(404).end("not found");
				return;
			}
			handler(req, res, seen);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	try {
		await run(`http://127.0.0.1:${port}`, seen);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

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

test("openai-chat specialist: auth, prompt+image and text output", async () => {
	const outDir = mkdtempSync(join(tmpdir(), "pi-specialists-exec-"));
	await withServer(
		{
			"/v1/chat/completions": (_req, res) => json(res, { choices: [{ message: { content: "there is a cat" } }] }),
		},
		async (baseUrl, seen) => {
			const spec = normalizeSpecialist({
				name: "vision",
				type: "image-to-text",
				baseUrl: `${baseUrl}/v1`,
				model: "vl",
				apiKey: "sk-test",
			});
			const result = await executeSpecialist(
				spec,
				{ prompt: "what is there?", input: ["data:image/png;base64,aGVsbG8="] },
				{ outputDir: outDir },
			);
			assert.equal(result.text, "there is a cat");
			assert.equal(seen.length, 1);
			assert.equal(seen[0].auth, "Bearer sk-test");
			assert.ok(seen[0].body.includes("what is there?"));
			assert.ok(seen[0].body.includes("data:image/png;base64,aGVsbG8="));
			assert.equal(result.outputs.length, 0);
		},
	);
});

test("openai-images specialist persists b64 image and attaches it", async () => {
	const outDir = mkdtempSync(join(tmpdir(), "pi-specialists-exec-"));
	await withServer(
		{
			"/v1/images/generations": (_req, res) => json(res, { data: [{ b64_json: PNG.toString("base64") }] }),
		},
		async (baseUrl) => {
			const spec = normalizeSpecialist({
				name: "painter",
				type: "text-to-image",
				baseUrl: `${baseUrl}/v1`,
				model: "img",
			});
			const result = await executeSpecialist(spec, { prompt: "un gato" }, { outputDir: outDir });
			assert.equal(result.images.length, 1);
			assert.equal(result.images[0].mimeType, "image/png");
			assert.ok(result.images[0].base64);
			const saved = readdirSync(outDir);
			assert.equal(saved.length, 1);
			assert.ok(saved[0].endsWith(".png"));
			assert.deepEqual(readFileSync(join(outDir, saved[0])), PNG);
			assert.ok(result.text.includes(join(outDir, saved[0])));
		},
	);
});

test("tts specialist saves binary audio with the right extension", async () => {
	const outDir = mkdtempSync(join(tmpdir(), "pi-specialists-exec-"));
	const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
	await withServer(
		{
			"/v1/audio/speech": (_req, res) => {
				res.writeHead(200, { "content-type": "audio/mpeg" }).end(mp3);
			},
		},
		async (baseUrl) => {
			const spec = normalizeSpecialist({ name: "voice", type: "tts", baseUrl: `${baseUrl}/v1`, model: "tts-1" });
			const result = await executeSpecialist(spec, { prompt: "hello" }, { outputDir: outDir });
			assert.equal(result.outputs.length, 1);
			assert.equal(result.outputs[0].mimeType, "audio/mpeg");
			assert.ok(result.outputs[0].path.endsWith(".mp3"));
			assert.equal(result.images.length, 0);
		},
	);
});

test("custom output path is honoured", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-specialists-exec-"));
	await withServer(
		{
			"/v1/images/generations": (_req, res) => json(res, { data: [{ b64_json: PNG.toString("base64") }] }),
		},
		async (baseUrl) => {
			const spec = normalizeSpecialist({ name: "painter", type: "text-to-image", baseUrl: `${baseUrl}/v1` });
			const target = join(dir, "nested", "cat.png");
			const result = await executeSpecialist(spec, { prompt: "gato" }, { output: target });
			assert.equal(result.outputs[0].path, target);
			assert.deepEqual(readFileSync(target), PNG);
		},
	);
});

test("replicate polling follows urls.get until the job succeeds", async () => {
	const outDir = mkdtempSync(join(tmpdir(), "pi-specialists-exec-"));
	await withServer(
		{
			"/v1/models/owner/name/predictions": (_req, res, seen) => {
				json(res, {
					status: "starting",
					urls: { get: `http://127.0.0.1:${(res.socket?.localPort ?? 0)}/v1/get` },
					_id: seen.length,
				});
			},
			"/v1/get": (_req, res) => json(res, { status: "succeeded", output: ["data:image/png;base64," + PNG.toString("base64")] }),
		},
		async (baseUrl) => {
			const spec = normalizeSpecialist({
				name: "video",
				type: "image-to-video",
				protocol: "replicate",
				baseUrl: `${baseUrl}/v1`,
				model: "owner/name",
				timeoutMs: 30_000,
			});
			// /predictions lives under /v1, so advertise the same prefix
			const result = await executeSpecialist(spec, { prompt: "mueve" }, { outputDir: outDir });
			assert.equal(result.outputs.length, 1);
			assert.equal(result.outputs[0].mimeType, "image/png");
		},
	);
});

test("local hostname falls back to loopback when the service binds 127.0.0.1", async () => {
	await withServer(
		{ "/v1/chat/completions": (_req, res) => json(res, { choices: [{ message: { content: "there is a cat" } }] }) },
		async (baseUrl) => {
			const port = Number(new URL(baseUrl).port);
			const local = normalizeSpecialist({
				name: "local-hostname",
				type: "image-to-text",
				baseUrl: `http://${hostname()}/v1`,
				port,
				model: "fast",
				timeoutMs: 5_000,
			});
			const result = await executeSpecialist(
				local,
				{ prompt: "describe", input: ["data:image/png;base64,aGVsbG8="] },
				{},
			);
			assert.equal(result.text, "there is a cat");
			assert.equal(result.details.fallback, "loopback");
			assert.equal(result.details.url, `http://127.0.0.1:${port}/v1/chat/completions`);
			assert.equal(result.details.configuredUrl, `http://${hostname()}:${port}/v1/chat/completions`);
		},
	);
});

test("keepPaths avoids reading local files for the decision sidecar", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-specialists-inputs-"));
	const path = join(dir, "frame.png");
	const bytes = Buffer.from("89504e470d0a1a0a", "hex");
	await import("node:fs/promises").then((fs) => fs.writeFile(path, bytes));

	const kept = await resolveInputs([path], { keepPaths: true });
	assert.equal(kept[0].path, path);
	assert.equal(kept[0].data, undefined);
	assert.equal(kept[0].mimeType, "image/png");

	const read = await resolveInputs([path]);
	assert.equal(read[0].data, bytes.toString("base64"));
});

test("a directory of images is batched and aggregated", { skip: !has("convert") }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-specialists-batch-img-"));
	execFileSync("convert", ["-size", "120x80", "xc:red", join(dir, "a.png")], { stdio: "ignore" });
	execFileSync("convert", ["-size", "120x80", "xc:blue", join(dir, "b.png")], { stdio: "ignore" });
	try {
		await withServer(
			{ "/v1/chat/completions": (_req, res) => json(res, { choices: [{ message: { content: "description ok" } }] }) },
			async (baseUrl, seen) => {
				const spec = normalizeSpecialist({
					name: "dir-batch",
					type: "image-to-text",
					baseUrl: `${baseUrl}/v1`,
					model: "vision",
					budget: { contextTokens: 4_096, maxOutputTokens: 256 },
				});
				const result = await executeSpecialist(spec, { prompt: "describe", input: [dir] }, {});
				assert.equal(result.details.batch, true);
				assert.equal(result.details.items, 2);
				assert.equal(result.details.errors, 0);
				assert.match(result.text, /## a\.png/);
				assert.match(result.text, /## b\.png/);
				const chats = seen.filter((entry) => entry.path === "/v1/chat/completions");
				assert.equal(chats.length, 2);
				assert.ok(chats.every((entry) => entry.body.includes('"max_tokens":256')));
				assert.ok(existsSync(result.details.outputFile as string), "aggregate file written");
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a directory of audio is split and transcribed in one batch", { skip: !has("ffmpeg") }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-specialists-batch-audio-"));
	execFileSync(
		"ffmpeg",
		["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=65", "-ar", "16000", "-ac", "1", join(dir, "long.wav")],
		{ stdio: "ignore" },
	);
	execFileSync(
		"ffmpeg",
		["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-ar", "16000", "-ac", "1", join(dir, "short.wav")],
		{ stdio: "ignore" },
	);
	try {
		await withServer(
			{
				"/audio/transcriptions": (_req, res) =>
					json(res, { type: "transcript.text.done", text: "language Spanish<asr_text>Hello" }),
			},
			async (baseUrl, seen) => {
				const spec = normalizeSpecialist({
					name: "audio-batch",
					type: "automatic-speech-recognition",
					protocol: "openai-transcriptions",
					baseUrl,
					budget: { contextTokens: 16_000, maxAudioSeconds: 30, maxOutputTokens: 256 },
				});
				const result = await executeSpecialist(spec, { input: [dir] }, {});
				assert.equal(result.details.batch, true);
				assert.equal(result.details.items, 4);
				assert.equal(result.details.language, "Spanish");
				assert.equal(seen.filter((entry) => entry.path === "/audio/transcriptions").length, 4);
				assert.match(result.text, /long\.wav \[0:00–0:30\]/);
				assert.match(result.text, /long\.wav \[1:00–1:05\]/);
				assert.match(result.text, /short\.wav/);
				assert.ok(existsSync(result.details.outputFile as string), "aggregate file written");
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("long prompts are truncated and max_tokens set from the discovered budget", async () => {
	await withServer(
		{
			"/v1/models": (_req, res) => json(res, { data: [{ id: "m", meta: { n_ctx: 2_048 } }] }),
			"/v1/chat/completions": (_req, res) => json(res, { choices: [{ message: { content: "ok" } }] }),
		},
		async (baseUrl, seen) => {
			const spec = normalizeSpecialist({
				name: "long-prompt",
				type: "text-generation",
				baseUrl: `${baseUrl}/v1`,
				model: "m",
			});
			const prompt = "palabra ".repeat(5_000);
			const result = await executeSpecialist(spec, { prompt }, {});
			assert.equal(result.text, "ok");
			const chat = seen.find((entry) => entry.path === "/v1/chat/completions")!;
			const body = JSON.parse(chat.body) as { max_tokens?: number; messages: Array<{ content: string }> };
			assert.equal(body.max_tokens, 512);
			assert.ok(body.messages[0].content.length < prompt.length);
			assert.ok(body.messages[0].content.includes("truncated to budget"));
		},
	);
});

test("comfyui polls history and downloads the generated image", async () => {
	const outDir = mkdtempSync(join(tmpdir(), "pi-specialists-comfy-"));
	let historyCalls = 0;
	await withServer(
		{
			"/prompt": (_req, res) => json(res, { prompt_id: "p1" }),
			"/history/p1": (_req, res) => {
				historyCalls += 1;
				if (historyCalls === 1) {
					json(res, {});
					return;
				}
				json(res, {
					p1: {
						outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
						status: { status_str: "success", completed: true },
					},
				});
			},
			"/view": (_req, res) => {
				res.writeHead(200, { "content-type": "image/png" }).end(PNG);
			},
		},
		async (baseUrl, seen) => {
			const spec = normalizeSpecialist({
				name: "comfy",
				type: "text-to-image",
				protocol: "comfyui",
				baseUrl,
				body: {
					pollMs: 20,
					width: 64,
					height: 64,
					seed: 7,
					workflow: {
						"5": { class_type: "TextEncode", inputs: { prompt: "{{prompt}}", seed: "{{seed}}", width: "{{width}}" } },
					},
				},
				timeoutMs: 5_000,
			});
			const result = await executeSpecialist(spec, { prompt: "a cat" }, { outputDir: outDir });
			assert.equal(result.outputs.length, 1);
			assert.ok(result.outputs[0].path.endsWith(".png"));
			assert.equal(readFileSync(result.outputs[0].path).subarray(0, 8).toString("hex"), PNG.subarray(0, 8).toString("hex"));
			assert.ok(historyCalls >= 2);
			const promptRequest = seen.find((entry) => entry.path === "/prompt")!;
			const body = JSON.parse(promptRequest.body) as {
				prompt: { "5": { inputs: { prompt: string; seed: number; width: number } } };
			};
			assert.equal(body.prompt["5"].inputs.prompt, "a cat");
			assert.equal(body.prompt["5"].inputs.seed, 7);
			assert.equal(body.prompt["5"].inputs.width, 64);
			assert.ok(seen.some((entry) => entry.path.startsWith("/view")));
		},
	);
});

test("HTTP errors surface status and body, and never leak the key", async () => {
	await withServer(
		{
			"/v1/chat/completions": (_req, res) => {
				res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}');
			},
		},
		async (baseUrl) => {
			const spec = normalizeSpecialist({
				name: "vision",
				type: "ocr",
				baseUrl: `${baseUrl}/v1`,
				apiKey: "sk-super-secret",
			});
			await assert.rejects(
				() => executeSpecialist(spec, { prompt: "x", input: ["data:image/png;base64,aGVsbG8="] }),
				(error: Error) => {
					assert.ok(error.message.includes("401"));
					assert.ok(error.message.includes("bad key"));
					assert.ok(!error.message.includes("sk-super-secret"));
					return true;
				},
			);
		},
	);
});
