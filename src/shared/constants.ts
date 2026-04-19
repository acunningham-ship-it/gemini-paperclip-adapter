/**
 * Google Gemini adapter — shared constants.
 */

export const ADAPTER_TYPE = "gemini_local";
export const ADAPTER_LABEL = "gemini_local";
export const PROVIDER_SLUG = "gemini";
export const BILLER_SLUG = "gemini";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_MODEL = "gemini-2.5-flash";
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_GRACE_SEC = 10;

export const DEFAULT_PROMPT_TEMPLATE = `{{instructions}}

{{paperclipContext}}

{{taskBody}}`;

/**
 * Free models known to work on Google Gemini.
 */
export const FREE_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash"
] as const;

export const AUTH_ENV_VAR = "GEMINI_API_KEY";
