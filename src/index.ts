/**
 * Google Gemini Paperclip adapter — main entry.
 *
 * v0.0.1: scaffold. Implementation TBD.
 */

import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  DEFAULT_MODEL,
  AUTH_ENV_VAR,
} from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

export const models = [];

export const agentConfigurationDoc = `# Google Gemini Adapter Configuration

Free LLM access via Google Gemini. Requires \`GEMINI_API_KEY\` env var.

## Core configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | gemini-2.5-flash | Model id |
| timeoutSec | number | 300 | Execution timeout |

See FREE_MODELS in src/shared/constants.ts for available free models.
`;

// TODO(Dev Team): implement createServerAdapter() factory
