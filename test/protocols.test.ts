import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpecialist, type Specialist } from "../src/config.ts";
import {
	applyAuth,
	buildRequest,
	extForMime,
	extractTranscript,
	joinUrl,
	normalizeDecisionQuestions,
	withPort,
	mediaRefsFromJson,
	mediaKindForMime,
	parseResponse,
	type MediaInput,
} from "../src/protocols.ts";

function spec(overrides: Record<string, unknown> = {}): Specialist {
	return normalizeSpecialist({
		name: "test",
		type: "ocr",
		baseUrl: "http://localhost:1234/v1",
		model: "some-model",
		...overrides,
	});
}

const image: MediaInput = { kind: "image", mimeType: "image/png", data: "aGVsbG8=", path: "/tmp/x.png" };
const audio: MediaInput = { kind: "audio", mimeType: "audio/mpeg", data: "aGVsbG8=", filename: "x.mp3" };

function bodyJson(built: ReturnType<typeof buildRequest>): Record<string, any> {
	return JSON.parse(String(built.body));
}

test("joinUrl, withPort and mime helpers", () => {
	assert.equal(joinUrl("http://x/v1/", "/chat"), "http://x/v1/chat");
	assert.equal(joinUrl("http://x/v1", "chat"), "http://x/v1/chat");
	assert.equal(withPort("http://localhost", 8080), "http://localhost:8080");
	assert.equal(withPort("http://localhost:1234/v1", 8080), "http://localhost:8080/v1");
	assert.equal(withPort("https://api.example.com/v1", undefined), "https://api.example.com/v1");
	assert.equal(withPort("not a url", 1234), "not a url");
	assert.equal(extForMime("image/png"), "png");
	assert.equal(extForMime("audio/mpeg; charset=x"), "mp3");
	assert.equal(mediaKindForMime("image/webp"), "image");
	assert.equal(mediaKindForMime("audio/wav"), "audio");
	assert.equal(mediaKindForMime("video/mp4"), "video");
	assert.equal(mediaKindForMime("application/pdf"), "file");
});

test("applyAuth covers bearer, header, query, basic and none", () => {
	const headers: Record<string, string> = {};
	const query: Record<string, string> = {};
	applyAuth(spec({ apiKey: "k1" }), headers, query);
	assert.equal(headers.Authorization, "Bearer k1");

	const headerSpec = spec({ apiKey: "k2", auth: { type: "header", headerName: "X-Key" } });
	const h2: Record<string, string> = {};
	applyAuth(headerSpec, h2, {});
	assert.equal(h2["X-Key"], "k2");

	const querySpec = spec({ apiKey: "k3", auth: { type: "query", queryName: "token" } });
	const q3: Record<string, string> = {};
	applyAuth(querySpec, {}, q3);
	assert.equal(q3.token, "k3");

	const basicSpec = spec({ apiKey: "secret", auth: { type: "basic", username: "user" } });
	const h4: Record<string, string> = {};
	applyAuth(basicSpec, h4, {});
	assert.equal(h4.Authorization, `Basic ${Buffer.from("user:secret").toString("base64")}`);

	const none = spec({ apiKey: "ignored", auth: { type: "none" } });
	const h5: Record<string, string> = {};
	applyAuth(none, h5, {});
	assert.deepEqual(h5, {});
});

test("the optional port overrides the baseUrl port", () => {
	const built = buildRequest(spec({ baseUrl: "http://localhost/v1", port: 8080 }), { prompt: "hola" });
	assert.equal(built.url, "http://localhost:8080/v1/chat/completions");
});

test("openai-chat includes prompt, image and extra options", () => {
	const built = buildRequest(spec({ apiKey: "sk-x", body: { temperature: 0.2 } }), {
		prompt: "lee esto",
		input: [image],
		options: { max_tokens: 10 },
	});
	assert.equal(built.url, "http://localhost:1234/v1/chat/completions");
	assert.equal(built.headers.Authorization, "Bearer sk-x");
	assert.equal(built.headers["Content-Type"], "application/json");
	const body = bodyJson(built);
	assert.equal(body.model, "some-model");
	assert.equal(body.temperature, 0.2);
	assert.equal(body.max_tokens, 10);
	const content = body.messages[0].content;
	assert.equal(content[0].type, "text");
	assert.equal(content[0].text, "lee esto");
	assert.equal(content[1].type, "image_url");
	assert.equal(content[1].image_url.url, "data:image/png;base64,aGVsbG8=");
});

test("openai-chat without media sends a plain string content", () => {
	const built = buildRequest(spec({ type: "summarization" }), { prompt: "resume" });
	assert.equal(bodyJson(built).messages[0].content, "resume");
});

test("openai-chat rejects video input with a clear message", () => {
	assert.throws(
		() => buildRequest(spec(), { prompt: "x", input: [{ kind: "video", mimeType: "video/mp4", data: "aGVsbG8=" }] }),
		/openai-chat protocol does not accept video/,
	);
});

test("auth via query parameter lands in the URL", () => {
	const built = buildRequest(
		spec({ apiKey: "k", auth: { type: "query", queryName: "key" }, query: { tenant: "a" } }),
		{ prompt: "hola" },
	);
	assert.ok(built.url.includes("?key=k&tenant=a") || built.url.includes("?tenant=a&key=k"));
});

test("openai-images generation requests b64_json", () => {
	const built = buildRequest(spec({ type: "text-to-image", protocol: "openai-images" }), {
		prompt: "un gato",
		options: { size: "512x512" },
	});
	assert.equal(built.url, "http://localhost:1234/v1/images/generations");
	const body = bodyJson(built);
	assert.equal(body.prompt, "un gato");
	assert.equal(body.size, "512x512");
	assert.equal(body.response_format, "b64_json");
});

test("openai-images edit uses multipart /images/edits", () => {
	const built = buildRequest(spec({ type: "image-to-image", protocol: "openai-images" }), {
		prompt: "ponlo en blanco y negro",
		input: [image],
	});
	assert.equal(built.url, "http://localhost:1234/v1/images/edits");
	assert.ok(built.body instanceof FormData);
	assert.equal(built.headers["Content-Type"], undefined);
});

test("openai audio endpoints build multipart and JSON bodies", () => {
	const transcription = buildRequest(spec({ type: "asr", protocol: "openai-transcriptions" }), {
		prompt: "Spanish",
		input: [audio],
	});
	assert.equal(transcription.url, "http://localhost:1234/v1/audio/transcriptions");
	assert.ok(transcription.body instanceof FormData);

	const speech = buildRequest(spec({ type: "tts", protocol: "openai-speech" }), {
		prompt: "hola mundo",
		options: { voice: "nova" },
	});
	assert.equal(speech.url, "http://localhost:1234/v1/audio/speech");
	const body = bodyJson(speech);
	assert.equal(body.input, "hola mundo");
	assert.equal(body.voice, "nova");
	assert.equal(body.response_format, "mp3");
});

test("embeddings post to /embeddings", () => {
	const built = buildRequest(spec({ type: "feature-extraction", protocol: "openai-embeddings" }), { prompt: "texto" });
	assert.equal(built.url, "http://localhost:1234/v1/embeddings");
	assert.equal(bodyJson(built).input, "texto");
});

test("hf-inference uses /models/{id} and binary or JSON bodies", () => {
	const binary = buildRequest(spec({ protocol: "hf-inference", baseUrl: "https://api-inference.huggingface.co", model: "org/model", type: "asr" }), {
		input: [audio],
	});
	assert.equal(binary.url, "https://api-inference.huggingface.co/models/org/model");
	assert.ok(binary.body instanceof Blob);
	assert.equal(binary.headers["Content-Type"], "audio/mpeg");

	const json = buildRequest(spec({ protocol: "hf-inference", baseUrl: "https://api-inference.huggingface.co", model: "org/model", type: "text-classification" }), {
		prompt: "me encanta",
		options: { top_k: 2 },
	});
	const body = bodyJson(json);
	assert.equal(body.inputs, "me encanta");
	assert.deepEqual(body.parameters, { top_k: 2 });
});

test("replicate builds model or version predictions", () => {
	const model = buildRequest(
		spec({ protocol: "replicate", baseUrl: "https://api.replicate.com/v1", model: "owner/name", type: "text-to-video" }),
		{ prompt: "olas", options: { num_frames: 24 } },
	);
	assert.equal(model.url, "https://api.replicate.com/v1/models/owner/name/predictions");
	assert.equal(bodyJson(model).input.prompt, "olas");
	assert.equal(bodyJson(model).input.num_frames, 24);

	const version = buildRequest(
		spec({ protocol: "replicate", baseUrl: "https://api.replicate.com/v1", model: "a".repeat(64), type: "text-to-video" }),
		{ prompt: "x" },
	);
	assert.equal(version.url, "https://api.replicate.com/v1/predictions");
	assert.equal(bodyJson(version).version, "a".repeat(64));
});

test("decision sidecars take state + named questions and pass media as paths", () => {
	const built = buildRequest(
		spec({ type: "system-1", protocol: "decision", baseUrl: "http://127.0.0.1", port: 9000 }),
		{
			prompt: "default",
			input: [image],
			options: {
				state: "I want to cancel my subscription",
				questions: {
					intent: { type: "choice", instructions: "What do they want to do?", criteria: { cancel: "cancel", other: "other" } },
				},
			},
		},
	);
	assert.equal(built.url, "http://127.0.0.1:9000/decide");
	assert.equal(built.headers["Content-Type"], "application/json");
	const body = bodyJson(built);
	assert.equal(body.state, "I want to cancel my subscription");
	assert.equal(body.questions.intent.type, "choice");
	assert.deepEqual(body.media, [{ type: "path", path: "/tmp/x.png" }]);
});

test("decision sidecars get a default text question and URL media", () => {
	const built = buildRequest(
		spec({ type: "system-1", protocol: "decision", baseUrl: "http://127.0.0.1", port: 9000 }),
		{ prompt: "Is this a greeting?", input: [{ kind: "image", mimeType: "image/png", url: "https://x/y.png" }] },
	);
	const body = bodyJson(built);
	assert.equal(body.state, "Is this a greeting?");
	assert.deepEqual(body.questions, { answer: { type: "text", instructions: "Is this a greeting?" } });
	assert.deepEqual(body.media, [{ type: "url", url: "https://x/y.png" }]);
	assert.deepEqual(normalizeDecisionQuestions('{"q":{"type":"noul"}}', "x"), { q: { type: "noul" } });
});

test("ASR transcripts strip the language<asr_text> prefix", async () => {
	assert.deepEqual(extractTranscript("language Spanish<asr_text>Hola mundo"), {
		language: "Spanish",
		text: "Hola mundo",
	});
	const parsed = await parseResponse(
		new Response(
			JSON.stringify({ type: "transcript.text.done", text: "language Spanish<asr_text>Hola mundo" }),
			{ headers: { "content-type": "application/json" } },
		),
		spec({ type: "asr", protocol: "openai-transcriptions" }),
	);
	assert.equal(parsed.kind, "text");
	assert.equal(parsed.text, "Hola mundo");
	assert.equal(parsed.language, "Spanish");
});

test("custom-json substitutes template placeholders", () => {
	const built = buildRequest(
		spec({
			protocol: "custom-json",
			baseUrl: "http://localhost:9000/hook",
			body: { message: "{{prompt}}", image: "{{input}}", meta: { model: "{{model}}" } },
		}),
		{ prompt: "describe", input: [{ kind: "image", mimeType: "image/png", url: "https://x/y.png" }] },
	);
	assert.equal(built.url, "http://localhost:9000/hook");
	const body = bodyJson(built);
	assert.equal(body.message, "describe");
	assert.equal(body.image, "https://x/y.png");
	assert.equal(body.meta.model, "some-model");
});

test("parseResponse extracts text from chat and transcription JSON", async () => {
	const chat = await parseResponse(
		new Response(JSON.stringify({ choices: [{ message: { content: "hola" } }] }), {
			headers: { "content-type": "application/json" },
		}),
		spec({ type: "text-generation" }),
	);
	assert.equal(chat.kind, "text");
	assert.equal(chat.text, "hola");

	const asr = await parseResponse(
		new Response(JSON.stringify({ text: "transcript" }), { headers: { "content-type": "application/json" } }),
		spec({ type: "asr" }),
	);
	assert.equal(asr.kind, "text");
	assert.equal(asr.text, "transcript");
});

test("parseResponse detects binary media by content type", async () => {
	const response = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
		headers: { "content-type": "image/png" },
	});
	const parsed = await parseResponse(response, spec({ type: "text-to-image" }));
	assert.equal(parsed.kind, "binary");
	assert.equal(parsed.mimeType, "image/png");
	assert.equal(parsed.ext, "png");
});

test("mediaRefsFromJson handles OpenAI images and Replicate output", () => {
	const openai = mediaRefsFromJson({ data: [{ b64_json: "aGVsbG8=" }, { url: "https://x/2.png" }] });
	assert.equal(openai.length, 2);
	assert.equal(openai[0].base64, "aGVsbG8=");
	assert.equal(openai[1].url, "https://x/2.png");

	const replicate = mediaRefsFromJson({ output: ["https://x/a.mp4", "data:image/png;base64,aGVsbG8="] });
	assert.equal(replicate.length, 2);
	assert.equal(replicate[0].url, "https://x/a.mp4");
	assert.equal(replicate[1].base64, "aGVsbG8=");
});
