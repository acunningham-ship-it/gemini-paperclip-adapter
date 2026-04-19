/**
 * Google Gemini adapter — shared constants.
 */

export const ADAPTER_TYPE = "gemini_direct_local";
export const ADAPTER_LABEL = "gemini_direct_local";
export const PROVIDER_SLUG = "gemini";
export const BILLER_SLUG = "gemini";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_MODELS_URL = `${GEMINI_BASE_URL}/models`;

export const DEFAULT_MODEL = "gemini-2.5-flash";
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_GRACE_SEC = 10;

/** Cap on tool-calling iterations per run. */
export const MAX_TOOL_ITERATIONS = 10;

export const DEFAULT_PROMPT_TEMPLATE = `{{instructions}}

{{paperclipContext}}

{{taskBody}}`;

export interface GeminiModelMeta {
  id: string;
  label: string;
  contextWindow: number;
  supportsThinking: boolean;
}

/**
 * Priority order used to sort discovered + fallback models.
 * Lower index = higher priority in the dropdown.
 */
export const MODEL_PRIORITY: string[] = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

/**
 * Hardcoded fallback list used when the /models endpoint is unreachable
 * at boot. Keep this in priority order.
 */
export const FALLBACK_MODELS: GeminiModelMeta[] = [
  { id: "gemini-2.5-flash",        label: "Gemini 2.5 Flash (free)",           contextWindow: 1_048_576, supportsThinking: true },
  { id: "gemini-2.5-pro",          label: "Gemini 2.5 Pro (free, smarter)",    contextWindow: 2_097_152, supportsThinking: true },
  { id: "gemini-2.5-flash-lite",   label: "Gemini 2.5 Flash Lite (free)",      contextWindow: 1_048_576, supportsThinking: false },
  { id: "gemini-2.0-flash",        label: "Gemini 2.0 Flash (free, stable)",   contextWindow: 1_048_576, supportsThinking: false },
  { id: "gemini-3-pro-preview",    label: "Gemini 3 Pro Preview (free)",       contextWindow: 2_097_152, supportsThinking: true },
  { id: "gemini-3.1-pro-preview",  label: "Gemini 3.1 Pro Preview (free)",     contextWindow: 2_097_152, supportsThinking: true },
];

/**
 * Legacy export kept for back-compat; some callers still import FREE_MODELS.
 * Prefer MODEL_PRIORITY / FALLBACK_MODELS going forward.
 */
export const FREE_MODELS = FALLBACK_MODELS.map((m) => m.id);

export const AUTH_ENV_VAR = "GEMINI_API_KEY";
