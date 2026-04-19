/**
 * Model detection / validation for the Gemini adapter.
 *
 * Calls Google's `/v1beta/models?key=KEY` catalog endpoint and confirms
 * the configured model (or the default) is present. Used by the server
 * to surface a "configured model" badge and to warn operators when the
 * model they set is not visible to the API key in use.
 */

import { DEFAULT_MODEL, GEMINI_MODELS_URL, PROVIDER_SLUG } from "../shared/constants.js";

export interface DetectModelResult {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
}

function readApiKey(): string {
  return (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "").trim();
}

export async function detectModel(): Promise<DetectModelResult | null> {
  const apiKey = readApiKey();
  if (!apiKey) {
    return {
      model: DEFAULT_MODEL,
      provider: PROVIDER_SLUG,
      source: "default_no_key",
    };
  }
  try {
    const url = `${GEMINI_MODELS_URL}?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return {
        model: DEFAULT_MODEL,
        provider: PROVIDER_SLUG,
        source: `http_${resp.status}`,
      };
    }
    const body = (await resp.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const candidates = (body.models ?? [])
      .filter(
        (m) =>
          m &&
          typeof m.name === "string" &&
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("generateContent"),
      )
      .map((m) => (m.name as string).replace(/^models\//, ""));

    const target = DEFAULT_MODEL;
    const matched = candidates.find((id) => id === target) ?? null;
    return {
      model: matched ?? target,
      provider: PROVIDER_SLUG,
      source: matched ? "gemini_catalog" : "default_not_in_catalog",
      candidates,
    };
  } catch {
    return {
      model: DEFAULT_MODEL,
      provider: PROVIDER_SLUG,
      source: "unreachable",
    };
  }
}
