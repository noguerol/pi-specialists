/**
 * Specialist type catalog.
 *
 * The type of a specialist is a Hugging Face pipeline tag (the `pipeline_tag`
 * values shown on model cards): `text-to-image`, `image-to-text`,
 * `automatic-speech-recognition`, ... plus a few practical aliases (`ocr`,
 * `tts`, `asr`, `vqa`) because that is how people name the capability.
 *
 * Each entry carries what the router needs to expose the capability:
 *   - emoji        toolbar marker (`👁️🟢`, `👂🟢`, ...)
 *   - family       grouping used by the config menu
 *   - input/output media kinds used for validation and UI prompts
 *   - protocol     HTTP adapter used when the specialist does not override it
 *   - hint         one-line description injected into the system prompt
 *   - prompt       default instruction when the tool call has no prompt
 *
 * This module is pure data + lookups: no pi imports, so it is unit-testable
 * with plain `node --test`.
 */

export type MediaKind = "text" | "image" | "audio" | "video" | "file";

export type OutputKind = "text" | "image" | "audio" | "video" | "json" | "vectors";

export type ProtocolId =
	| "openai-chat"
	| "openai-images"
	| "openai-speech"
	| "openai-transcriptions"
	| "openai-embeddings"
	| "decision"
	| "hf-inference"
	| "replicate"
	| "custom-json";

export interface SpecialistTypeInfo {
	/** Canonical Hugging Face pipeline tag. */
	id: string;
	label: string;
	family: string;
	emoji: string;
	input: MediaKind[];
	output: OutputKind;
	protocol: ProtocolId;
	hint: string;
	prompt?: string;
	aliases?: string[];
}

export const PROTOCOLS: ProtocolId[] = [
	"openai-chat",
	"openai-images",
	"openai-speech",
	"openai-transcriptions",
	"openai-embeddings",
	"decision",
	"hf-inference",
	"replicate",
	"custom-json",
];

export const PROTOCOL_LABELS: Record<ProtocolId, string> = {
	"openai-chat": "OpenAI chat/completions (vision, OCR, VQA, text)",
	"openai-images": "OpenAI images (generation / editing)",
	"openai-speech": "OpenAI audio/speech (TTS)",
	"openai-transcriptions": "OpenAI audio/transcriptions (STT)",
	"openai-embeddings": "OpenAI embeddings",
	decision: "Decision sidecar /decide (System-1: transformers + torch)",
	"hf-inference": "Hugging Face Inference API",
	replicate: "Replicate predictions",
	"custom-json": "JSON personalizado (plantilla)",
};

export const PROTOCOL_DEFAULT_BASE_URL: Record<ProtocolId, string> = {
	"openai-chat": "https://api.openai.com/v1",
	"openai-images": "https://api.openai.com/v1",
	"openai-speech": "https://api.openai.com/v1",
	"openai-transcriptions": "https://api.openai.com/v1",
	"openai-embeddings": "https://api.openai.com/v1",
	decision: "http://127.0.0.1:9000",
	"hf-inference": "https://api-inference.huggingface.co",
	replicate: "https://api.replicate.com/v1",
	"custom-json": "http://localhost:8000",
};

/** Official / commonly used pipeline tags, grouped by capability family. */
export const SPECIALIST_TYPES: SpecialistTypeInfo[] = [
	// ── Vision: understanding images ───────────────────────────────────────
	{
		id: "image-to-text",
		label: "Describe images",
		family: "Vision",
		emoji: "👁️",
		input: ["image"],
		output: "text",
		protocol: "openai-chat",
		hint: "describe what is in an image",
		prompt: "Describe the image in detail.",
		aliases: ["captioning", "image-captioning", "caption", "describe-image"],
	},
	{
		id: "ocr",
		label: "OCR / read text",
		family: "Vision",
		emoji: "🔎",
		input: ["image"],
		output: "text",
		protocol: "openai-chat",
		hint: "extract text from an image, screenshot or scanned PDF",
		prompt: "Extract all visible text from the image, preserving reading order and line breaks. Return only the text.",
		aliases: ["optical-character-recognition", "text-recognition", "read-text"],
	},
	{
		id: "visual-question-answering",
		label: "Ask about an image",
		family: "Vision",
		emoji: "👁️",
		input: ["image", "text"],
		output: "text",
		protocol: "openai-chat",
		hint: "answer questions about an image",
		prompt: "Answer the question using only the image.",
		aliases: ["vqa", "image-question-answering"],
	},
	{
		id: "document-question-answering",
		label: "Ask about a document",
		family: "Vision",
		emoji: "📄",
		input: ["image", "text"],
		output: "text",
		protocol: "openai-chat",
		hint: "answer questions about a scanned document",
		prompt: "Answer the question using the attached document.",
		aliases: ["docqa", "document-qa"],
	},
	{
		id: "image-text-to-text",
		label: "Multimodal image + text",
		family: "Vision",
		emoji: "🧠",
		input: ["image", "text"],
		output: "text",
		protocol: "openai-chat",
		hint: "reason over one or more images and text",
		aliases: ["multimodal", "image-chat"],
	},
	{
		id: "video-text-to-text",
		label: "Multimodal video + text",
		family: "Vision",
		emoji: "🎥",
		input: ["video", "text"],
		output: "text",
		protocol: "openai-chat",
		hint: "reason over a video and text",
	},

	// ── Image: generation / editing ────────────────────────────────────────
	{
		id: "text-to-image",
		label: "Text → image",
		family: "Image",
		emoji: "🎨",
		input: ["text"],
		output: "image",
		protocol: "openai-images",
		hint: "generate an image from a description",
		aliases: ["txt2img", "image-generation", "text2image"],
	},
	{
		id: "image-to-image",
		label: "Image → image / edit",
		family: "Image",
		emoji: "🖌️",
		input: ["image", "text"],
		output: "image",
		protocol: "openai-images",
		hint: "edit, transform or restyle an image",
		aliases: ["img2img", "image-editing", "edit-image", "inpainting", "upscaling", "image-upscaling"],
	},
	{
		id: "unconditional-image-generation",
		label: "Unconditional image",
		family: "Image",
		emoji: "🎲",
		input: [],
		output: "image",
		protocol: "openai-images",
		hint: "generate images without a text condition",
	},
	{
		id: "image-feature-extraction",
		label: "Image embeddings",
		family: "Image",
		emoji: "🧬",
		input: ["image"],
		output: "vectors",
		protocol: "hf-inference",
		hint: "compute an image embedding",
	},

	// ── Image: analysis ────────────────────────────────────────────────────
	{
		id: "image-classification",
		label: "Classify images",
		family: "Vision",
		emoji: "🏷️",
		input: ["image"],
		output: "json",
		protocol: "hf-inference",
		hint: "classify an image into labels",
	},
	{
		id: "object-detection",
		label: "Detect objects",
		family: "Vision",
		emoji: "📦",
		input: ["image"],
		output: "json",
		protocol: "hf-inference",
		hint: "detect objects and boxes in an image",
	},
	{
		id: "image-segmentation",
		label: "Segment images",
		family: "Vision",
		emoji: "✂️",
		input: ["image"],
		output: "json",
		protocol: "hf-inference",
		hint: "segment an image into regions or classes",
	},
	{
		id: "depth-estimation",
		label: "Estimate depth",
		family: "Vision",
		emoji: "🧭",
		input: ["image"],
		output: "image",
		protocol: "hf-inference",
		hint: "estimate an image depth map",
	},
	{
		id: "keypoint-detection",
		label: "Detect keypoints",
		family: "Vision",
		emoji: "📍",
		input: ["image"],
		output: "json",
		protocol: "hf-inference",
		hint: "detect keypoints/pose in an image",
	},
	{
		id: "mask-generation",
		label: "Generate masks",
		family: "Vision",
		emoji: "🎭",
		input: ["image"],
		output: "json",
		protocol: "hf-inference",
		hint: "generate object masks for an image",
	},

	// ── Video ──────────────────────────────────────────────────────────────
	{
		id: "text-to-video",
		label: "Text → video",
		family: "Video",
		emoji: "🎬",
		input: ["text"],
		output: "video",
		protocol: "replicate",
		hint: "generate a video from a description",
		aliases: ["txt2vid", "text2video"],
	},
	{
		id: "image-to-video",
		label: "Image → video",
		family: "Video",
		emoji: "🎞️",
		input: ["image", "text"],
		output: "video",
		protocol: "replicate",
		hint: "animate an image into a video",
		aliases: ["img2vid", "animate-image"],
	},
	{
		id: "video-to-video",
		label: "Video → video",
		family: "Video",
		emoji: "🎥",
		input: ["video", "text"],
		output: "video",
		protocol: "replicate",
		hint: "transform or restyle a video",
	},
	{
		id: "video-classification",
		label: "Classify videos",
		family: "Video",
		emoji: "🔬",
		input: ["video"],
		output: "json",
		protocol: "hf-inference",
		hint: "classify a video into labels",
	},

	// ── Audio ──────────────────────────────────────────────────────────────
	{
		id: "automatic-speech-recognition",
		label: "Transcribe audio (STT)",
		family: "Audio",
		emoji: "👂",
		input: ["audio"],
		output: "text",
		protocol: "openai-transcriptions",
		hint: "transcribe audio to text",
		prompt: "Transcribe the audio faithfully without adding commentary.",
		aliases: ["asr", "stt", "transcription", "transcribe", "speech-to-text"],
	},
	{
		id: "text-to-speech",
		label: "Text → speech (TTS)",
		family: "Audio",
		emoji: "🗣️",
		input: ["text"],
		output: "audio",
		protocol: "openai-speech",
		hint: "convert text to speech",
		aliases: ["tts", "speech", "speech-generation", "text2speech"],
	},
	{
		id: "text-to-audio",
		label: "Text → audio / music",
		family: "Audio",
		emoji: "🎵",
		input: ["text"],
		output: "audio",
		protocol: "replicate",
		hint: "generate music, effects or audio from text",
		aliases: ["musicgen", "sound-generation", "text2audio", "music"],
	},
	{
		id: "audio-classification",
		label: "Classify audio",
		family: "Audio",
		emoji: "🔊",
		input: ["audio"],
		output: "json",
		protocol: "hf-inference",
		hint: "classify audio into labels",
	},
	{
		id: "audio-to-audio",
		label: "Transform audio",
		family: "Audio",
		emoji: "🎧",
		input: ["audio", "text"],
		output: "audio",
		protocol: "replicate",
		hint: "convert voice, separate sources or transform audio",
		aliases: ["voice-conversion", "source-separation"],
	},
	{
		id: "voice-activity-detection",
		label: "Detect voice activity",
		family: "Audio",
		emoji: "🎙️",
		input: ["audio"],
		output: "json",
		protocol: "hf-inference",
		hint: "detect speech segments in audio",
		aliases: ["vad"],
	},

	// ── Text ───────────────────────────────────────────────────────────────
	{
		id: "text-generation",
		label: "Generate text",
		family: "Text",
		emoji: "💬",
		input: ["text"],
		output: "text",
		protocol: "openai-chat",
		hint: "generate or complete text",
		aliases: ["llm", "chat", "text2text-generation"],
	},
	{
		id: "summarization",
		label: "Summarize",
		family: "Text",
		emoji: "📝",
		input: ["text"],
		output: "text",
		protocol: "openai-chat",
		hint: "summarize text",
		prompt: "Summarize the text concisely while preserving key facts.",
	},
	{
		id: "translation",
		label: "Translate",
		family: "Text",
		emoji: "🌐",
		input: ["text"],
		output: "text",
		protocol: "openai-chat",
		hint: "translate text between languages",
		prompt: "Translate the text to English.",
		aliases: ["translate", "translation_xx_to_yy"],
	},
	{
		id: "question-answering",
		label: "Answer questions",
		family: "Text",
		emoji: "❓",
		input: ["text"],
		output: "text",
		protocol: "openai-chat",
		hint: "answer questions about a context",
		aliases: ["qa"],
	},
	{
		id: "text-classification",
		label: "Classify text",
		family: "Text",
		emoji: "🏷️",
		input: ["text"],
		output: "json",
		protocol: "hf-inference",
		hint: "classify text (sentiment, topic, spam, ...)",
	},
	{
		id: "zero-shot-classification",
		label: "Zero-shot classify",
		family: "Text",
		emoji: "🎯",
		input: ["text"],
		output: "json",
		protocol: "hf-inference",
		hint: "classify text against given labels",
	},
	{
		id: "token-classification",
		label: "Token classification (NER)",
		family: "Text",
		emoji: "🧩",
		input: ["text"],
		output: "json",
		protocol: "hf-inference",
		hint: "extract entities or label tokens",
		aliases: ["ner", "named-entity-recognition"],
	},
	{
		id: "feature-extraction",
		label: "Text embeddings",
		family: "Text",
		emoji: "🧬",
		input: ["text"],
		output: "vectors",
		protocol: "openai-embeddings",
		hint: "compute a text embedding",
		aliases: ["embeddings", "embedding", "sentence-embeddings"],
	},
	{
		id: "sentence-similarity",
		label: "Sentence similarity",
		family: "Text",
		emoji: "🔗",
		input: ["text"],
		output: "json",
		protocol: "hf-inference",
		hint: "compare similarity between texts",
	},
	{
		id: "reranking",
		label: "Rerank results",
		family: "Text",
		emoji: "📊",
		input: ["text"],
		output: "json",
		protocol: "hf-inference",
		hint: "rerank documents by relevance",
		aliases: ["rerank"],
	},

	// ── Decision (System-1) ────────────────────────────────────────────────
	{
		id: "system-1",
		label: "System-1 (fast decision)",
		family: "Decision models",
		emoji: "⚡",
		input: ["text"],
		output: "text",
		protocol: "decision",
		hint: "make fast decisions (yes/no, classify, route) in a single pass",
		prompt:
			"Make the requested decision in a single pass. Reply only with the label, yes/no or requested result, without explanations.",
		aliases: ["system1", "system-1-model", "system1-model", "decision", "decision-model", "fast-decision", "instant-decision", "router-model"],
	},
];

const BY_ID = new Map<string, SpecialistTypeInfo>();
for (const info of SPECIALIST_TYPES) {
	BY_ID.set(info.id.toLowerCase(), info);
	for (const alias of info.aliases ?? []) BY_ID.set(alias.toLowerCase(), info);
}

/** Resolve a canonical type or alias. Returns undefined for unknown types. */
export function findType(idOrAlias: string | undefined | null): SpecialistTypeInfo | undefined {
	if (!idOrAlias) return undefined;
	return BY_ID.get(String(idOrAlias).trim().toLowerCase());
}

/** Canonical type id for an alias, or the trimmed input when unknown. */
export function canonicalType(idOrAlias: string): string {
	return findType(idOrAlias)?.id ?? String(idOrAlias).trim().toLowerCase();
}

/** Toolbar emoji for a type; falls back to a generic marker. */
export function emojiForType(idOrAlias: string): string {
	return findType(idOrAlias)?.emoji ?? "🧩";
}

/** Types grouped by family, in catalog order, for the config menu. */
export function typesByFamily(): Array<{ family: string; types: SpecialistTypeInfo[] }> {
	const groups: Array<{ family: string; types: SpecialistTypeInfo[] }> = [];
	for (const info of SPECIALIST_TYPES) {
		const group = groups.find((g) => g.family === info.family);
		if (group) group.types.push(info);
		else groups.push({ family: info.family, types: [info] });
	}
	return groups;
}

/** Whether the type can consume a given media kind. */
export function typeAccepts(info: SpecialistTypeInfo | undefined, kind: MediaKind): boolean {
	if (!info) return true;
	return info.input.includes(kind) || kind === "file";
}

/** Default prompt for a type, if it has one. */
export function defaultPromptFor(idOrAlias: string): string | undefined {
	return findType(idOrAlias)?.prompt;
}
