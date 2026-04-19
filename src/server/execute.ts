/**
 * Execute a single Gemini run.
 *
 * Strategy: POST a generateContent request (streaming endpoint) directly
 * to `generativelanguage.googleapis.com`. Because Gemini has no native
 * session concept, we replay the conversation history we stored in the
 * session params on every call, then append the newly-rendered user
 * prompt.
 *
 * Key Gemini quirks:
 *   - Auth is a `?key=` URL param, NOT a Bearer header.
 *   - Request shape is `{ contents: [{ role, parts: [{text}] }] }`, not
 *     OpenAI-style `messages`.
 *   - Roles are `user` and `model` (no `assistant`, no `system` — system
 *     instructions go in a top-level `systemInstruction` field).
 *   - Streaming body is a JSON array of GenerateContentResponse chunks,
 *     not SSE with `data:` prefix.
 *
 * TODO(gemini):
 *   - Tool / function calling passthrough
 *   - True incremental streaming into onLog (currently we buffer)
 *   - Safety-setting pass-through
 *   - Automatic retry on 429 with Retry-After
 */

import {
  asString,
  asNumber,
  parseObject,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  BILLER_SLUG,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  GEMINI_BASE_URL,
  PROVIDER_SLUG,
} from "../shared/constants.js";
import {
  parseGeminiResponse,
  type GeminiContent,
} from "./parse.js";

function resolveApiKey(envConfig: Record<string, unknown>): string | null {
  const fromConfig =
    typeof envConfig.GEMINI_API_KEY === "string" ? envConfig.GEMINI_API_KEY.trim() : "";
  if (fromConfig) return fromConfig;
  const fromConfigGoogle =
    typeof envConfig.GOOGLE_API_KEY === "string" ? envConfig.GOOGLE_API_KEY.trim() : "";
  if (fromConfigGoogle) return fromConfigGoogle;
  const fromProc = (process.env.GEMINI_API_KEY ?? "").trim();
  if (fromProc) return fromProc;
  const fromProcGoogle = (process.env.GOOGLE_API_KEY ?? "").trim();
  if (fromProcGoogle) return fromProcGoogle;
  return null;
}

function sanitizeHistoryFromSession(raw: unknown): GeminiContent[] {
  if (!Array.isArray(raw)) return [];
  const out: GeminiContent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const role = rec.role === "model" ? "model" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    const partsRaw = Array.isArray(rec.parts) ? rec.parts : [];
    const parts: { text: string }[] = [];
    for (const p of partsRaw) {
      if (!p || typeof p !== "object") continue;
      const text = (p as Record<string, unknown>).text;
      if (typeof text === "string") parts.push({ text });
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;

  const model = asString(config.model, DEFAULT_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  const systemInstruction = asString(config.systemInstruction, "").trim();
  const envConfig = parseObject(config.env);

  const apiKey = resolveApiKey(envConfig);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "GEMINI_API_KEY not configured (checked agentConfig.env and process env).",
      errorCode: "gemini_no_api_key",
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model,
      billingType: "api",
    };
  }

  // Render the user-facing prompt from the template.
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData).trim();

  // Build `contents` from resumed history + this turn's user message.
  const sessionParams = parseObject(runtime.sessionParams);
  const sessionId =
    asString(sessionParams.sessionId, runtime.sessionId ?? "") || `gemini-${runId}`;
  const history = sanitizeHistoryFromSession(sessionParams.history);
  const contents: GeminiContent[] = [
    ...history,
    { role: "user", parts: [{ text: renderedPrompt || " " }] },
  ];

  const requestBody: Record<string, unknown> = { contents };
  if (systemInstruction) {
    requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const url =
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  // URL used in logs with the api key redacted.
  const loggedUrl =
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?key=REDACTED`;

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: "fetch",
      commandArgs: ["POST", loggedUrl],
      commandNotes: [
        `Gemini native API (no OpenAI compat).`,
        `Resumed history entries: ${history.length}`,
      ],
      prompt: renderedPrompt,
      promptMetrics: {
        promptChars: renderedPrompt.length,
        historyEntries: history.length,
      },
      context,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error).name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[gemini] request failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: aborted,
      errorMessage: aborted ? `Timed out after ${timeoutSec}s` : message,
      errorCode: aborted ? "timeout" : "gemini_fetch_failed",
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model,
      billingType: "api",
    };
  }

  const bodyText = await resp.text().catch(() => "");
  clearTimeout(timer);

  if (!resp.ok) {
    const snippet = bodyText.slice(0, 500);
    await onLog("stderr", `[gemini] HTTP ${resp.status}: ${snippet}\n`);
    const isAuth = resp.status === 401 || resp.status === 403;
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Gemini HTTP ${resp.status}: ${snippet}`,
      errorCode: isAuth ? "gemini_auth_failed" : `gemini_http_${resp.status}`,
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model,
      billingType: "api",
      resultJson: { status: resp.status, body: bodyText },
    };
  }

  const parsed = parseGeminiResponse(bodyText);
  await onLog("stdout", parsed.text);

  const updatedHistory: GeminiContent[] = [
    ...history,
    { role: "user", parts: [{ text: renderedPrompt || " " }] },
    ...(parsed.text.length > 0
      ? [{ role: "model" as const, parts: [{ text: parsed.text }] }]
      : []),
  ];

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: {
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    },
    sessionId,
    sessionParams: {
      sessionId,
      history: updatedHistory,
    },
    sessionDisplayId: sessionId,
    provider: PROVIDER_SLUG,
    biller: BILLER_SLUG,
    model: parsed.model ?? model,
    billingType: "api",
    costUsd: null,
    resultJson: parsed.raw as Record<string, unknown> | null,
    summary: parsed.text,
    clearSession: false,
  };
}
