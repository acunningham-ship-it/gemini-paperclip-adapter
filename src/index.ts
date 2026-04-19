/**
 * Google Gemini Paperclip adapter — main entry.
 *
 * Talks directly to Google's Generative Language API
 * (`generativelanguage.googleapis.com/v1beta`) using the NATIVE request
 * shape (`{contents:[{role,parts:[{text}]}]}`), NOT the OpenAI-compat
 * surface. Auth is an API key passed as a URL query parameter.
 *
 * v0.7: full model listing (queries /v1beta/models at boot) +
 * Gemini-native tool / function calling with a 10-iteration cap.
 */

import type {
  AdapterConfigSchema,
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  FALLBACK_MODELS,
  type GeminiModelMeta,
} from "./shared/constants.js";
import {
  detectModel,
  execute,
  sessionCodec,
  testEnvironment,
} from "./server/index.js";
import { loadModels } from "./server/load-models.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Discover models at boot. Falls back to FALLBACK_MODELS if the call
 * fails (no API key at load time, network down, etc.).
 */
const discoveredModels: GeminiModelMeta[] = await (async () => {
  try {
    return await loadModels();
  } catch {
    return FALLBACK_MODELS;
  }
})();

export const models: AdapterModel[] = discoveredModels.map((m) => ({
  id: m.id,
  label: m.label,
  // Extra metadata is not part of AdapterModel yet; attached loosely so
  // Paperclip UIs that introspect the object can surface it.
  ...({ contextWindow: m.contextWindow, supportsThinking: m.supportsThinking } as Record<
    string,
    unknown
  >),
}));

export const agentConfigurationDoc = `# Google Gemini Adapter

Direct-to-Google Gemini adapter. Uses the native Generative Language API
(not the OpenAI-compat endpoint) so we can take advantage of Gemini's
free-tier quota without any wrapper.

## Prerequisites

- A Gemini API key from https://aistudio.google.com/app/apikey
- Export it as \`GEMINI_API_KEY\` in the Paperclip process or the agent's
  adapter env.

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | \`${DEFAULT_MODEL}\` | Gemini model id (e.g. \`gemini-2.5-flash\`, \`gemini-2.5-pro\`, \`gemini-2.0-flash\`). |
| timeoutSec | number | ${DEFAULT_TIMEOUT_SEC} | Hard timeout for a single run. |
| systemInstruction | string | _(none)_ | Optional system instruction, sent as top-level \`systemInstruction\`. |
| promptTemplate | string | _(default)_ | Mustache-style template. |
| env | object | \`{}\` | Extra env vars. \`GEMINI_API_KEY\` here takes precedence over process env. |

## Models

Models are discovered at boot from \`GET /v1beta/models\`. Current list
(this boot): ${discoveredModels.length} model(s).

${discoveredModels.map((m) => `- \`${m.id}\` (ctx ${m.contextWindow}${m.supportsThinking ? ", thinking" : ""})`).join("\n")}

## Tool Calling

If the host wires a tools client onto the execution context (or declares
tools inline under \`config.tools\` / \`context.tools\`), the adapter
translates them to Gemini's \`functionDeclarations\` format and loops
(max 10 iterations) on \`functionCall\` parts, executing them via
\`ctx.tools.invoke(name, args)\`.

## Notes

- Gemini has no native server-side sessions; this adapter persists the
  conversation history in \`sessionParams.history\` and replays it on
  every call. The history now also carries \`functionCall\` and
  \`functionResponse\` parts so tool state survives resumes.
- Streaming is buffered; tokens are flushed to the runner in one chunk
  after each HTTP response completes. Incremental streaming is on the
  roadmap.
`;

const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "model",
      label: "Model",
      type: "select",
      default: DEFAULT_MODEL,
      required: false,
      options: discoveredModels.map((m) => ({ label: m.label, value: m.id })),
    },
    {
      key: "timeoutSec",
      label: "Timeout (seconds)",
      type: "number",
      default: DEFAULT_TIMEOUT_SEC,
      required: false,
    },
    {
      key: "systemInstruction",
      label: "System instruction",
      type: "textarea",
      default: "",
      required: false,
    },
    {
      key: "promptTemplate",
      label: "Prompt template",
      type: "textarea",
      default: DEFAULT_PROMPT_TEMPLATE,
      required: false,
    },
  ],
};

/**
 * Factory invoked by the Paperclip plugin loader.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    models,
    agentConfigurationDoc,
    detectModel,
    getConfigSchema: () => configSchema,
  };
}

export default createServerAdapter;
