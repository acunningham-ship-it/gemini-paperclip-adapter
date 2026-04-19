/**
 * Discover Gemini models at adapter boot.
 *
 * Queries `GET /v1beta/models?key=…`, filters to chat-capable models
 * (`supportedGenerationMethods` contains `generateContent`), drops
 * vision / audio / embedding / TTS-only models, and returns them
 * ordered per `MODEL_PRIORITY`. Unknown but chat-capable models are
 * kept and appended after the priority list.
 *
 * If the endpoint is unreachable, returns `FALLBACK_MODELS`.
 */

import {
  FALLBACK_MODELS,
  GEMINI_MODELS_URL,
  MODEL_PRIORITY,
  type GeminiModelMeta,
} from "../shared/constants.js";

interface RawGeminiModel {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

/**
 * Sub-string filters — if a model id contains any of these we skip it.
 * Keeps us focused on general-purpose chat models.
 */
const EXCLUDE_SUBSTRINGS = [
  "embedding",
  "aqa",
  "tts",
  "text-to-speech",
  "image-generation",
  "imagen",
  "veo",
  "audio",
  "vision-only",
];

function isExcluded(id: string): boolean {
  const lower = id.toLowerCase();
  return EXCLUDE_SUBSTRINGS.some((frag) => lower.includes(frag));
}

function supportsThinkingHeuristic(id: string): boolean {
  // Gemini 2.5+ and 3.x ship with thinking on by default.
  return (
    /gemini-(2\.5|3(\.\d+)?)/.test(id) || id.includes("thinking")
  );
}

function toMeta(raw: RawGeminiModel): GeminiModelMeta | null {
  if (!raw.name) return null;
  const id = raw.name.replace(/^models\//, "");
  if (!id.startsWith("gemini")) return null;
  if (isExcluded(id)) return null;
  const methods = raw.supportedGenerationMethods ?? [];
  if (!methods.includes("generateContent")) return null;
  const label = raw.displayName ? `${id} — ${raw.displayName}` : id;
  return {
    id,
    label,
    contextWindow:
      typeof raw.inputTokenLimit === "number" ? raw.inputTokenLimit : 1_048_576,
    supportsThinking: supportsThinkingHeuristic(id),
  };
}

/** Order by MODEL_PRIORITY; anything not in the priority list goes last. */
export function orderModels(models: GeminiModelMeta[]): GeminiModelMeta[] {
  const rank = (id: string) => {
    const idx = MODEL_PRIORITY.indexOf(id);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  return [...models].sort((a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

function readApiKey(): string {
  return (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "").trim();
}

export async function loadModels(): Promise<GeminiModelMeta[]> {
  const apiKey = readApiKey();
  if (!apiKey) return FALLBACK_MODELS;
  try {
    const url = `${GEMINI_MODELS_URL}?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return FALLBACK_MODELS;
    const body = (await resp.json()) as { models?: RawGeminiModel[] };
    const rawList = Array.isArray(body.models) ? body.models : [];
    const metas: GeminiModelMeta[] = [];
    const seen = new Set<string>();
    for (const raw of rawList) {
      const meta = toMeta(raw);
      if (meta && !seen.has(meta.id)) {
        metas.push(meta);
        seen.add(meta.id);
      }
    }
    if (metas.length === 0) return FALLBACK_MODELS;
    return orderModels(metas);
  } catch {
    return FALLBACK_MODELS;
  }
}
