import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET, type Budget } from "../src/budget-types.ts";
import { normalizeSpecialist } from "../src/config.ts";
import { prepareInputs, splitText, wantsPreprocessing } from "../src/preprocess.ts";

function has(command: string): boolean {
	try {
		execFileSync("which", [command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function budget(overrides: Partial<Budget> = {}): Budget {
	return { ...DEFAULT_BUDGET, source: "config", ...overrides };
}

function run(command: string, args: string[], cwd?: string): void {
	execFileSync(command, args, { cwd, stdio: "ignore", timeout: 60_000 });
}

function dimensions(path: string): { width: number; height: number } {
	const output = execFileSync("identify", ["-format", "%w %h", `${path}[0]`]).toString().trim();
	const [width, height] = output.split(/\s+/).map(Number);
	return { width, height };
}

test("splitText honours paragraph boundaries", () => {
	const paragraph = "a".repeat(2_000);
	const chunks = splitText(`${paragraph}\n\n${paragraph}`, 3_000);
	assert.equal(chunks.length, 2);
	assert.ok(chunks.every((chunk) => chunk.length <= 3_000));
});

test("directories expand into budget-sized items and clean up", { skip: !has("convert") }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-preprocess-dir-"));
	try {
		run("convert", ["-size", "2000x1500", "xc:red", join(dir, "big.png")]);
		run("convert", ["-size", "100x100", "xc:blue", join(dir, "small.png")]);
		await writeFile(join(dir, "notes.txt"), "hola");
		const spec = normalizeSpecialist({ name: "dir", type: "image-to-text", baseUrl: "http://127.0.0.1" });
		assert.equal(await wantsPreprocessing([dir], spec), true);
		const prepared = await prepareInputs([dir], spec, budget({ maxImageSide: 1_000, maxImagePixels: 1_000_000 }));
		assert.equal(prepared.items.length, 2);
		const big = prepared.items.find((item) => item.label === "big.png")!;
		const small = prepared.items.find((item) => item.label === "small.png")!;
		assert.ok(big && small);
		assert.notEqual(big.path, join(dir, "big.png"));
		assert.equal(small.path, join(dir, "small.png"));
		const size = dimensions(big.path!);
		assert.ok(size.width <= 1_000 && size.height <= 1_000, JSON.stringify(size));
		assert.ok(prepared.warnings.some((warning) => warning.includes("big.png") && warning.includes("→")));
		assert.ok(prepared.warnings.some((warning) => warning.includes("notes.txt")));
		const preparedPath = big.path!;
		await prepared.cleanup();
		assert.equal(existsSync(preparedPath), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("splits long audio into budget-sized chunks", { skip: !has("ffmpeg") }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-preprocess-audio-"));
	try {
		const audio = join(dir, "long.wav");
		run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=65", "-ar", "16000", "-ac", "1", audio]);
		const spec = normalizeSpecialist({ name: "asr", type: "automatic-speech-recognition", baseUrl: "http://127.0.0.1" });
		const prepared = await prepareInputs([audio], spec, budget({ maxAudioSeconds: 30 }));
		assert.equal(prepared.items.length, 3);
		assert.match(prepared.items[0].label, /\[0:00–0:30\]/);
		assert.match(prepared.items[2].label, /\[1:00–1:05\]/);
		assert.ok(prepared.items.every((item) => item.kind === "audio"));
		await prepared.cleanup();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("PDFs become page images", { skip: !has("convert") || !has("pdftoppm") }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-preprocess-pdf-"));
	try {
		run("convert", ["-size", "600x400", "xc:white", join(dir, "p1.png")]);
		run("convert", ["-size", "600x400", "xc:white", join(dir, "p2.png")]);
		const pdf = join(dir, "doc.pdf");
		run("convert", [join(dir, "p1.png"), join(dir, "p2.png"), pdf]);
		const spec = normalizeSpecialist({ name: "ocr", type: "ocr", baseUrl: "http://127.0.0.1" });
		const prepared = await prepareInputs([pdf], spec, budget({ pdfDpi: 72 }));
		assert.equal(prepared.items.length, 2);
		assert.deepEqual(prepared.items.map((item) => item.label), ["doc.pdf p.1", "doc.pdf p.2"]);
		assert.ok(prepared.items.every((item) => item.kind === "image" && item.path));
		await prepared.cleanup();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("text files are chunked to fit the context budget", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-preprocess-text-"));
	try {
		const path = join(dir, "book.txt");
		await writeFile(path, `${"Frase de prueba. ".repeat(1_500)}\n\n${"Otra frase. ".repeat(1_500)}`);
		const spec = normalizeSpecialist({ name: "summary", type: "summarization", baseUrl: "http://127.0.0.1" });
		const prepared = await prepareInputs(
			[path],
			spec,
			budget({ contextTokens: 1_024, maxOutputTokens: 128 }),
		);
		assert.ok(prepared.items.length > 1);
		assert.ok(prepared.items.every((item) => item.kind === "text" && item.text));
		assert.match(prepared.items[0].label, /\[1\/\d+\]/);
		await prepared.cleanup();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("wantsPreprocessing ignores data URIs but handles directories", async () => {
	const spec = normalizeSpecialist({ name: "x", type: "image-to-text", baseUrl: "http://127.0.0.1" });
	assert.equal(await wantsPreprocessing(["data:image/png;base64,aGVsbG8="], spec), false);
	assert.equal(await wantsPreprocessing(["/tmp"], spec), true);
});
