import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSpecialist } from "../src/config.ts";
import { discoverBudget, estimateTokens, truncateToTokens } from "../src/budget.ts";

async function withBudgetServer(
	ctx: number,
	run: (port: number) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) => {
		if (req.url === "/props") {
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					modalities: { vision: true, audio: false },
					default_generation_settings: { params: { n_ctx: ctx } },
				}),
			);
			return;
		}
		if ((req.url ?? "").startsWith("/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({ data: [{ id: "test", meta: { n_ctx: ctx } }] }),
			);
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	try {
		await run(port);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("discoverBudget reads n_ctx and modalities from a local server", async () => {
	await withBudgetServer(4_096, async (port) => {
		const spec = normalizeSpecialist({
			name: "probe",
			type: "image-to-text",
			baseUrl: "http://127.0.0.1/v1",
			port,
		});
		const budget = await discoverBudget(spec);
		assert.equal(budget.contextTokens, 4_096);
		assert.equal(budget.maxOutputTokens, 1_024);
		assert.equal(budget.source, "probe");
		assert.deepEqual(budget.modalities, { vision: true, audio: false });
	});
});

test("discoverBudget probes via the local hostname using loopback", async () => {
	await withBudgetServer(8_192, async (port) => {
		const spec = normalizeSpecialist({
			name: "probe-host",
			type: "image-to-text",
			baseUrl: `http://${hostname()}/v1`,
			port,
		});
		const budget = await discoverBudget(spec);
		assert.equal(budget.contextTokens, 8_192);
		assert.equal(budget.source, "probe");
	});
});

test("configured budget wins over the probe", async () => {
	await withBudgetServer(4_096, async (port) => {
		const spec = normalizeSpecialist({
			name: "probe-config",
			type: "image-to-text",
			baseUrl: "http://127.0.0.1/v1",
			port,
			budget: { contextTokens: 2_000, maxOutputTokens: 200, maxImageSide: 800, maxAudioSeconds: 10 },
		});
		const budget = await discoverBudget(spec);
		assert.equal(budget.contextTokens, 2_000);
		assert.equal(budget.maxOutputTokens, 200);
		assert.equal(budget.maxImageSide, 800);
		assert.equal(budget.maxAudioSeconds, 10);
		assert.equal(budget.source, "config");
	});
});

test("discoverBudget reads a local transformers model config via /info", async () => {
	const modelDir = await mkdtemp(join(tmpdir(), "pi-budget-model-"));
	await writeFile(
		join(modelDir, "config.json"),
		JSON.stringify({ model_type: "generic_vl", text_config: { max_position_embeddings: 32_768 } }),
	);
	const server = createServer((req, res) => {
		if (req.url === "/info") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: modelDir }));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	try {
		const spec = normalizeSpecialist({
			name: "decision-model",
			type: "system-1",
			protocol: "decision",
			baseUrl: "http://127.0.0.1",
			port,
		});
		const budget = await discoverBudget(spec);
		assert.equal(budget.contextTokens, 32_768);
		assert.equal(budget.source, "probe");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("estimateTokens and truncateToTokens keep prompts within budget", () => {
	assert.equal(estimateTokens("12345678"), 2);
	const long = "palabra ".repeat(2_000);
	const fitted = truncateToTokens(long, 100);
	assert.equal(fitted.truncated, true);
	assert.ok(estimateTokens(fitted.text) <= 102);
	assert.ok(fitted.text.includes("truncated to budget"));
	const short = truncateToTokens("hello", 100);
	assert.deepEqual(short, { text: "hello", truncated: false });
});
