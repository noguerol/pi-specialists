import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PROTOCOLS,
	SPECIALIST_TYPES,
	canonicalType,
	defaultPromptFor,
	emojiForType,
	findType,
	typeAccepts,
	typesByFamily,
} from "../src/catalog.ts";

test("catalog ids are canonical, unique and complete", () => {
	const ids = new Set<string>();
	for (const info of SPECIALIST_TYPES) {
		assert.ok(info.id, "type without id");
		assert.ok(!ids.has(info.id), `duplicate type ${info.id}`);
		ids.add(info.id);
		assert.equal(info.id, info.id.toLowerCase());
		assert.ok(info.emoji.length > 0, `${info.id} has no emoji`);
		assert.ok(PROTOCOLS.includes(info.protocol), `${info.id} has unknown protocol`);
		assert.ok(info.label.length > 0 && info.hint.length > 0, `${info.id} missing label/hint`);
		assert.ok(info.input.length > 0 || info.output === "image", `${info.id} has no input and no image output`);
	}
});

test("official Hugging Face pipeline tags are present", () => {
	for (const id of [
		"text-to-image",
		"image-to-text",
		"text-to-audio",
		"automatic-speech-recognition",
		"text-to-speech",
		"text-to-video",
		"image-to-video",
		"visual-question-answering",
		"document-question-answering",
		"feature-extraction",
		"image-segmentation",
		"object-detection",
		"image-classification",
		"summarization",
		"translation",
		"text-generation",
	]) {
		assert.ok(findType(id), `missing HF task ${id}`);
	}
});

test("aliases resolve to the canonical type", () => {
	const cases: Array<[string, string]> = [
		["ocr", "ocr"],
		["optical-character-recognition", "ocr"],
		["tts", "text-to-speech"],
		["asr", "automatic-speech-recognition"],
		["stt", "automatic-speech-recognition"],
		["vqa", "visual-question-answering"],
		["txt2img", "text-to-image"],
		["img2img", "image-to-image"],
		["embeddings", "feature-extraction"],
		["rerank", "reranking"],
		["system1", "system-1"],
		["decision-model", "system-1"],
	];
	for (const [alias, canonical] of cases) {
		assert.equal(canonicalType(alias), canonical, `${alias} -> ${canonical}`);
	}
	assert.equal(canonicalType("IMAGE-TO-TEXT"), "image-to-text");
	assert.equal(canonicalType("unknown-task"), "unknown-task");
});

test("toolbar emoji is stable per type family", () => {
	assert.equal(emojiForType("ocr"), "🔎");
	assert.equal(emojiForType("asr"), "👂");
	assert.equal(emojiForType("tts"), "🗣️");
	assert.equal(emojiForType("text-to-image"), "🎨");
	assert.equal(emojiForType("system-1"), "⚡");
	assert.equal(emojiForType("nope"), "🧩");
});

test("typesByFamily groups every type exactly once", () => {
	const groups = typesByFamily();
	assert.equal(groups.reduce((sum, group) => sum + group.types.length, 0), SPECIALIST_TYPES.length);
	const families = groups.map((group) => group.family);
	assert.equal(new Set(families).size, families.length);
	assert.ok(families.includes("Decision models"));
});

test("System-1 models live in their own Decision models family", () => {
	const system1 = findType("system-1");
	assert.ok(system1);
	assert.equal(system1.family, "Decision models");
	assert.equal(system1.emoji, "⚡");
	assert.deepEqual(system1.input, ["text"]);
	assert.equal(system1.protocol, "decision");
	assert.ok(system1.prompt?.includes("single pass"));
});

test("typeAccepts accepts declared media and arbitrary files", () => {
	const ocr = findType("ocr")!;
	assert.equal(typeAccepts(ocr, "image"), true);
	assert.equal(typeAccepts(ocr, "audio"), false);
	assert.equal(typeAccepts(ocr, "file"), true);
	assert.equal(typeAccepts(undefined, "audio"), true);
});

test("default prompts exist for instruction-heavy types", () => {
	assert.ok(defaultPromptFor("ocr")?.includes("text"));
	assert.ok(defaultPromptFor("translation")?.includes("Translate"));
	assert.equal(defaultPromptFor("text-to-image"), undefined);
});
