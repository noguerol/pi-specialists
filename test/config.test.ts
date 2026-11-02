import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_TIMEOUT_MS,
	DEFAULT_WAIT_MS,
	defaultConfig,
	loadConfigFile,
	maskApiKey,
	normalizeBaseUrl,
	normalizeConfig,
	normalizeSpecialist,
	resolveApiKey,
	resolveSpecialist,
	saveConfigFile,
	validateConfig,
	validateSpecialist,
	type Specialist,
} from "../src/config.ts";

function spec(overrides: Partial<Specialist> = {}): Specialist {
	return normalizeSpecialist({
		name: "Local OCR",
		type: "ocr",
		baseUrl: "http://localhost",
		port: 8080,
		model: "vl",
		...overrides,
	});
}

test("normalizeSpecialist fills protocol, port, wait and auth defaults", () => {
	const s = spec({ apiKey: "sk-test-123456" });
	assert.equal(s.name, "Local OCR");
	assert.equal(s.type, "ocr");
	assert.equal(s.protocol, "openai-chat");
	assert.equal(s.port, 8080);
	assert.equal(s.enabled, true);
	assert.equal(s.timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(s.waitMs, DEFAULT_WAIT_MS);
	assert.deepEqual(s.auth, { type: "bearer" });
	assert.equal(s.baseUrl, "http://localhost");
	assert.deepEqual(s.headers, {});
	assert.deepEqual(s.body, {});
});

test("normalizeBaseUrl infers http and accepts bare hosts", () => {
	assert.equal(normalizeBaseUrl("my-host"), "http://my-host");
	assert.equal(normalizeBaseUrl("  my-host  "), "http://my-host");
	assert.equal(normalizeBaseUrl("my-host:8080"), "http://my-host:8080");
	assert.equal(normalizeBaseUrl("my-host:8080/v1"), "http://my-host:8080/v1");
	assert.equal(normalizeBaseUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
	assert.equal(normalizeBaseUrl("[::1]:8080"), "http://[::1]:8080");
	assert.equal(normalizeBaseUrl("https://api.example.com/v1"), "https://api.example.com/v1");
	assert.equal(normalizeBaseUrl("ftp://x"), "ftp://x");
	assert.equal(normalizeBaseUrl(""), "");
});

test("normalizeSpecialist applies normalizeBaseUrl", () => {
	const spec = normalizeSpecialist({ name: "x", type: "ocr", baseUrl: "my-host:8080" });
	assert.equal(spec.baseUrl, "http://my-host:8080");
});

test("normalizeSpecialist migrates a legacy id into name/alias", () => {
	const onlyId = normalizeSpecialist({ id: "mi-ocr", type: "ocr" });
	assert.equal(onlyId.name, "mi-ocr");
	assert.equal(onlyId.aliases, undefined);

	const both = normalizeSpecialist({ id: "legacy-vl", name: "My Vision Model", type: "image-to-text" });
	assert.equal(both.name, "My Vision Model");
	assert.deepEqual(both.aliases, ["legacy-vl"]);
	assert.equal("id" in both, false);

	const same = normalizeSpecialist({ id: "mi-ocr", name: "Mi OCR", type: "ocr" });
	assert.equal(same.name, "Mi OCR");
	// "mi-ocr" is the slug of "Mi OCR", so it already resolves without an alias.
	assert.equal(same.aliases, undefined);
	const aliasOnly = normalizeSpecialist({ id: "legacy-name", name: "Mi OCR", type: "ocr" });
	assert.deepEqual(aliasOnly.aliases, ["legacy-name"]);
});

test("normalizeConfig keeps a stable order and coerces the master switch", () => {
	const config = normalizeConfig({ enabled: false, specialists: [{ name: "a", type: "tts" }, { name: "b", type: "asr" }] });
	assert.equal(config.enabled, false);
	assert.deepEqual(config.specialists.map((s) => s.name), ["a", "b"]);
	assert.equal(config.specialists[0].protocol, "openai-speech");
	assert.equal(config.specialists[1].protocol, "openai-transcriptions");
});

test("validateSpecialist rejects unknown types, bad urls, bad ports and missing models", () => {
	const bad = normalizeSpecialist({
		name: "x",
		type: "not-a-task",
		baseUrl: "http://[",
		port: 70000,
		protocol: "hf-inference",
	});
	const errors = validateSpecialist(bad);
	assert.ok(errors.some((e) => e.includes("unknown type")));
	assert.ok(errors.some((e) => e.includes("baseUrl is not a valid URL")));
	assert.ok(errors.some((e) => e.includes("port must be")));
	assert.ok(errors.some((e) => e.includes("requires \"model\"")));

	const badWait = validateSpecialist(spec({ waitMs: -1 }));
	assert.ok(badWait.some((e) => e.includes("waitMs")));
});

test("validateConfig catches duplicate names and alias clashes", () => {
	const config = normalizeConfig({
		specialists: [
			{ name: "dup", type: "ocr", baseUrl: "http://a" },
			{ name: "DUP", type: "tts", baseUrl: "http://b" },
		],
	});
	const errors = validateConfig(config);
	assert.equal(errors.filter((e) => e.includes("duplicate name")).length, 2);

	const clash = normalizeConfig({
		specialists: [
			{ name: "one", type: "ocr", baseUrl: "http://a" },
			{ name: "two", type: "tts", baseUrl: "http://b", aliases: ["one"] },
		],
	});
	assert.ok(validateConfig(clash).some((e) => e.includes('alias "one" is already used by')));
});

test("resolveApiKey supports literal, env: and file:", () => {
	process.env.PI_SPECIALISTS_TEST_KEY = "from-env";
	assert.equal(resolveApiKey("literal-key"), "literal-key");
	assert.equal(resolveApiKey("env:PI_SPECIALISTS_TEST_KEY"), "from-env");
	assert.equal(resolveApiKey("env:PI_SPECIALISTS_MISSING_KEY"), undefined);
	const dir = mkdtempSync(join(tmpdir(), "pi-specialists-"));
	saveConfigFile(defaultConfig(), join(dir, "specialists.json"));
	assert.equal(resolveApiKey(`file:${join(dir, "specialists.json")}`)?.startsWith("{"), true);
	assert.equal(resolveApiKey("file:/does/not/exist"), undefined);
});

test("maskApiKey never returns the full secret", () => {
	assert.equal(maskApiKey(undefined), "(no API key)");
	assert.equal(maskApiKey("env:OPENAI_API_KEY"), "env:OPENAI_API_KEY");
	assert.equal(maskApiKey("short"), "••••••••");
	const masked = maskApiKey("sk-abcdefghijklmnop");
	assert.ok(!masked.includes("abcdefghijkl"));
	assert.ok(masked.startsWith("sk-"));
});

test("resolveSpecialist matches name, slug, alias, type and reports ambiguity", () => {
	const config = normalizeConfig({
		specialists: [
			{ name: "My Vision Model", aliases: ["legacy-vl"], type: "image-to-text", baseUrl: "http://a" },
			{ name: "Home voice", type: "tts", baseUrl: "http://b" },
			{ name: "Cloud OCR", type: "ocr", baseUrl: "http://c", enabled: false },
		],
	});
	assert.equal(resolveSpecialist(config, "legacy-vl").specialist?.name, "My Vision Model");
	assert.equal(resolveSpecialist(config, "my-vision-model").specialist?.name, "My Vision Model");
	assert.equal(resolveSpecialist(config, "Home voice").specialist?.name, "Home voice");
	assert.equal(resolveSpecialist(config, "tts").specialist?.name, "Home voice");
	assert.equal(resolveSpecialist(config, "auto").specialist?.name, "My Vision Model");
	assert.equal(resolveSpecialist(config, "missing").error?.includes("does not exist"), true);

	const ambiguous = normalizeConfig({
		specialists: [
			{ name: "ocr-a", type: "ocr", baseUrl: "http://a" },
			{ name: "ocr-b", type: "ocr", baseUrl: "http://b" },
		],
	});
	assert.ok(resolveSpecialist(ambiguous, "ocr").error?.includes("several"));
});

test("saveConfigFile drops legacy ids, writes 0600 and loadConfigFile round-trips", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-specialists-"));
	const path = join(dir, "nested", "specialists.json");
	const config = normalizeConfig({
		enabled: false,
		outputDir: "/tmp/out",
		specialists: [
			{ id: "vision", name: "Vision Model", type: "image-to-text", baseUrl: "http://127.0.0.1", port: 1234, model: "vision-model" },
		],
	});
	saveConfigFile(config, path);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const raw = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(raw.version, 1);
	assert.equal(raw.specialists[0].id, undefined, "saved config must not contain id");
	assert.equal(raw.specialists[0].port, 1234);
	const loaded = loadConfigFile(path);
	assert.deepEqual(loaded.warnings, []);
	assert.deepEqual(loaded.config, config);
});

test("loadConfigFile survives a corrupt file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-specialists-"));
	const path = join(dir, "specialists.json");
	writeFileSync(path, "{not json");
	const loaded = loadConfigFile(path);
	assert.equal(loaded.config.enabled, true);
	assert.deepEqual(loaded.config.specialists, []);
	assert.equal(loaded.warnings.length, 1);
});
