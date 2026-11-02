/**
 * Budget discovery.
 *
 * Tries to learn the server's context window and modalities without failing the
 * call:
 *   - llama.cpp: GET /props (n_ctx, modalities) and GET /v1/models (meta.n_ctx)
 *   - OpenAI-compatible: GET /v1/models (context_window when exposed)
 *   - everything else: configured/default budget
 *
 * Results are cached per endpoint for a few minutes. The probe is only used
 * when a call needs preprocessing (directory, PDF, long audio, text, batch);
 * ordinary single-request calls keep their previous zero-probe fast path.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findType } from "./catalog.ts";
import type { Specialist } from "./config.ts";
import { localFallbackUrl } from "./local.ts";
import { withPort } from "./protocols.ts";
import {
	DEFAULT_BUDGET,
	budgetSummary,
	type Budget,
	type BudgetOverrides,
} from "./budget-types.ts";

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 1_200;
const cache = new Map<string, { budget: Budget; at: number }>();

export { budgetSummary };
export type { Budget, BudgetOverrides };

function cacheKey(spec: Specialist): string {
	return `${spec.baseUrl}|${spec.port ?? ""}|${spec.model ?? ""}|${spec.protocol}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function modelsUrl(spec: Specialist): URL {
	const url = new URL(withPort(spec.baseUrl, spec.port));
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
	url.search = "";
	return url;
}

function propsUrl(spec: Specialist): URL {
	const url = new URL(withPort(spec.baseUrl, spec.port));
	url.pathname = "/props";
	url.search = "";
	return url;
}

async function getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	// Local services bind 127.0.0.1; use the same loopback preference as calls.
	const target = localFallbackUrl(url.toString()) ?? url.toString();
	const response = await fetch(target, { signal: combined, headers: { Accept: "application/json" } });
	if (!response.ok) return undefined;
	return (await response.json()) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function numberField(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
	}
	return undefined;
}

/** Build the effective budget from defaults, config overrides and the probe. */
export async function discoverBudget(spec: Specialist, signal?: AbortSignal): Promise<Budget> {
	const overrides: BudgetOverrides = spec.budget ?? {};
	const key = cacheKey(spec);
	const cached = cache.get(key);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		// Config can change between sessions; apply overrides on top of the probe.
		return applyOverrides(cached.budget, overrides, cached.budget.contextTokens);
	}

	let contextTokens: number | undefined = overrides.contextTokens;
	let modalities: Budget["modalities"];
	if (!contextTokens) {
		try {
			const [propsResult, modelsResult] = await Promise.allSettled([
				getJson(propsUrl(spec), signal),
				getJson(modelsUrl(spec), signal),
			]);
			const props = propsResult.status === "fulfilled" ? asRecord(propsResult.value) : undefined;
			const defaults = asRecord(props?.default_generation_settings);
			const params = asRecord(defaults?.params);
			contextTokens =
				numberField(params, "n_ctx") ??
				numberField(defaults, "n_ctx") ??
				numberField(props, "n_ctx");
			const mods = asRecord(props?.modalities);
			if (mods) {
				modalities = {
					vision: mods.vision === true,
					audio: mods.audio === true,
				};
			}
			if (!contextTokens && modelsResult.status === "fulfilled") {
				const models = asRecord(modelsResult.value);
				const list = Array.isArray(models?.data) ? (models.data as unknown[]) : [];
				const items = list.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => !!item);
				const match = items.find((item) => item.id === spec.model) ?? items[0];
				const meta = asRecord(match?.meta);
				contextTokens =
					numberField(meta, "n_ctx") ??
					numberField(match, "context_window") ??
					numberField(match, "context_length") ??
					numberField(meta, "context_window");
			}
		} catch {
			// Probe is best effort; defaults are always usable.
		}

		// Transformers sidecars (e.g. the D1 decision server) expose the local
		// model path in /info; read its config.json for the real context.
		if (!contextTokens) {
			try {
				const infoUrl = propsUrl(spec);
				infoUrl.pathname = "/info";
				const info = asRecord(await getJson(infoUrl, signal));
				const modelPath = typeof info?.model === "string" ? info.model : undefined;
				if (modelPath && modelPath.startsWith("/")) {
					const config = asRecord(JSON.parse(await readFile(join(modelPath, "config.json"), "utf-8")));
					const textConfig = asRecord(config?.text_config);
					contextTokens =
						numberField(textConfig, "max_position_embeddings") ??
						numberField(config, "max_position_embeddings") ??
						numberField(config, "max_seq_len");
				}
			} catch {
				// not a local transformers model or unreadable config
			}
		}
	}

	const base: Budget = {
		...DEFAULT_BUDGET,
		contextTokens,
		maxOutputTokens: contextTokens
			? clamp(Math.floor(contextTokens * 0.25), 256, 4_096)
			: DEFAULT_BUDGET.maxOutputTokens,
		source: contextTokens ? "probe" : "default",
		...(modalities ? { modalities } : {}),
	};
	const budget = applyOverrides(base, overrides, contextTokens);
	// Do not cache a failed probe: the server may simply be starting or busy.
	if (contextTokens || Object.keys(overrides).length > 0) cache.set(key, { budget, at: Date.now() });
	return budget;
}

function applyOverrides(base: Budget, overrides: BudgetOverrides, contextTokens?: number): Budget {
	const budget: Budget = {
		...base,
		...overrides,
		contextTokens: overrides.contextTokens ?? contextTokens,
		source: Object.keys(overrides).length > 0 ? "config" : base.source,
	};
	if (!overrides.maxOutputTokens && budget.contextTokens) {
		budget.maxOutputTokens = clamp(Math.floor(budget.contextTokens * 0.25), 256, 4_096);
	}
	return budget;
}

export function estimateTokens(text: string | undefined): number {
	return Math.ceil((text ?? "").length / 4);
}

/** Truncate text to a token budget, preferring line/space boundaries. */
export function truncateToTokens(
	text: string,
	maxTokens: number,
): { text: string; truncated: boolean } {
	const marker = "\n… (truncated to budget)";
	const maxChars = Math.max(16, Math.floor(maxTokens * 4) - marker.length);
	if (text.length <= maxChars) return { text, truncated: false };
	let cut = text.lastIndexOf("\n", maxChars);
	if (cut < maxChars * 0.6) cut = text.lastIndexOf(" ", maxChars);
	if (cut < maxChars * 0.6) cut = maxChars;
	return {
		text: `${text.slice(0, cut).trimEnd()}${marker}`,
		truncated: true,
	};
}

/** Whether a type can consume a media kind (helper for the preprocessor). */
export function typeAcceptsMedia(type: string, kind: "image" | "audio" | "text"): boolean {
	const info = findType(type);
	return !!info?.input.includes(kind);
}
