/**
 * Execute a single Gemini run.
 *
 * Strategy: POST a generateContent request (streaming endpoint) directly
 * to `generativelanguage.googleapis.com`. Because Gemini has no native
 * session concept, we replay the conversation history we stored in the
 * session params on every call, then append the newly-rendered user
 * prompt.
 *
 * v0.7: added Gemini-native tool / function calling. If the host
 * exposes a tools client on AdapterExecutionContext (or declares tools
 * inline under config/context), we translate them to
 * `tools: [{functionDeclarations: [...]}]` on the request, loop on
 * `functionCall` parts in the response (max MAX_TOOL_ITERATIONS),
 * invoke via `ctx.tools.invoke`, and feed the results back as a
 * `function`-role turn.
 *
 * Key Gemini quirks:
 *   - Auth is a `?key=` URL param, NOT a Bearer header.
 *   - Request shape is `{ contents: [{ role, parts: [{text}] }] }`, not
 *     OpenAI-style `messages`.
 *   - Roles are `user`, `model`, and `function` (no `assistant`, no
 *     `system` — system instructions go in a top-level
 *     `systemInstruction` field).
 *   - Tool-call parts are `{ functionCall: { name, args } }`, NOT
 *     OpenAI's `tool_calls[].function`.
 *   - Streaming body is a JSON array of GenerateContentResponse chunks,
 *     not SSE with `data:` prefix.
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
  MAX_TOOL_ITERATIONS,
  PROVIDER_SLUG,
} from "../shared/constants.js";
import {
  parseGeminiResponse,
  type GeminiContent,
  type GeminiPart,
} from "./parse.js";
import {
  readInlineToolDecls,
  readToolsClient,
  toFunctionResponsePayload,
  toGeminiFunctionDeclarations,
  type PaperclipToolDecl,
} from "./tools.js";

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
    const role =
      rec.role === "model"
        ? "model"
        : rec.role === "user"
          ? "user"
          : rec.role === "function"
            ? "function"
            : null;
    if (!role) continue;
    const partsRaw = Array.isArray(rec.parts) ? rec.parts : [];
    const parts: GeminiPart[] = [];
    for (const p of partsRaw) {
      if (!p || typeof p !== "object") continue;
      const pr = p as Record<string, unknown>;
      if (typeof pr.text === "string") {
        parts.push({ text: pr.text });
      } else if (pr.functionCall && typeof pr.functionCall === "object") {
        const fc = pr.functionCall as Record<string, unknown>;
        if (typeof fc.name === "string") {
          parts.push({
            functionCall: {
              name: fc.name,
              args: (fc.args && typeof fc.args === "object"
                ? (fc.args as Record<string, unknown>)
                : {}) as Record<string, unknown>,
            },
          });
        }
      } else if (pr.functionResponse && typeof pr.functionResponse === "object") {
        const fr = pr.functionResponse as Record<string, unknown>;
        if (typeof fr.name === "string") {
          parts.push({
            functionResponse: {
              name: fr.name,
              response: (fr.response && typeof fr.response === "object"
                ? (fr.response as Record<string, unknown>)
                : {}) as Record<string, unknown>,
            },
          });
        }
      }
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

  // Resolve tools (optional). The SDK does not statically expose
  // `ctx.tools`; we read it structurally and fall back to inline
  // declarations on config/context.
  const toolsClient = readToolsClient(ctx);
  const inlineDecls = readInlineToolDecls(ctx);
  const toolDecls: PaperclipToolDecl[] = [];
  if (toolsClient?.list) {
    try {
      const listed = await toolsClient.list();
      if (Array.isArray(listed)) toolDecls.push(...listed);
    } catch (err) {
      await onLog(
        "stderr",
        `[gemini] tools.list failed: ${(err as Error).message}\n`,
      );
    }
  }
  toolDecls.push(...inlineDecls);

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
  const initialHistory = sanitizeHistoryFromSession(sessionParams.history);
  const contents: GeminiContent[] = [
    ...initialHistory,
    { role: "user", parts: [{ text: renderedPrompt || " " }] },
  ];

  const baseRequest: Record<string, unknown> = {};
  if (systemInstruction) {
    baseRequest.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  if (toolDecls.length > 0) {
    baseRequest.tools = [
      { functionDeclarations: toGeminiFunctionDeclarations(toolDecls) },
    ];
  }

  const url =
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const loggedUrl =
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?key=REDACTED`;

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: "fetch",
      commandArgs: ["POST", loggedUrl],
      commandNotes: [
        `Gemini native API (no OpenAI compat).`,
        `Resumed history entries: ${initialHistory.length}`,
        `Tools declared: ${toolDecls.length}`,
      ],
      prompt: renderedPrompt,
      promptMetrics: {
        promptChars: renderedPrompt.length,
        historyEntries: initialHistory.length,
        toolCount: toolDecls.length,
      },
      context,
    });
  }

  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let accumulatedText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel: string | null = null;
  let lastRaw: unknown = null;
  let iterations = 0;
  let hitIterationCap = false;

  try {
    // Tool-calling loop. Each iteration is one streamGenerateContent
    // round-trip; we append modelParts + (optional) function-role
    // results, then loop if the model asked for more tool calls. Caps
    // at MAX_TOOL_ITERATIONS to avoid runaway tool storms.
    while (true) {
      iterations += 1;
      const requestBody = { ...baseRequest, contents };

      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const bodyText = await resp.text().catch(() => "");
      if (!resp.ok) {
        const snippet = bodyText.slice(0, 500);
        await onLog("stderr", `[gemini] HTTP ${resp.status}: ${snippet}\n`);
        clearTimeout(overallTimer);
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
      lastRaw = parsed.raw;
      if (parsed.text) {
        await onLog("stdout", parsed.text);
        accumulatedText += parsed.text;
      }
      totalInputTokens += parsed.inputTokens;
      totalOutputTokens += parsed.outputTokens;
      if (parsed.model) lastModel = parsed.model;

      // Append the assistant turn (including functionCall parts) to
      // contents so Gemini sees its own prior tool-call on the next
      // round — this is required by the Gemini spec.
      if (parsed.modelParts.length > 0) {
        contents.push({ role: "model", parts: parsed.modelParts });
      }

      // Terminate if no tool calls in this turn.
      if (parsed.functionCalls.length === 0) break;

      // Iteration cap — stop before invoking another round.
      if (iterations >= MAX_TOOL_ITERATIONS) {
        hitIterationCap = true;
        await onLog(
          "stderr",
          `[gemini] hit tool-iteration cap (${MAX_TOOL_ITERATIONS}); stopping.\n`,
        );
        break;
      }

      if (!toolsClient) {
        await onLog(
          "stderr",
          `[gemini] model requested ${parsed.functionCalls.length} tool call(s) ` +
            `but no tools client is available; stopping.\n`,
        );
        break;
      }

      // Dispatch each functionCall and collect function-role parts.
      const fnParts: GeminiPart[] = [];
      for (const call of parsed.functionCalls) {
        await onLog(
          "stdout",
          `\n[gemini] tool_call: ${call.name} ${JSON.stringify(call.args)}\n`,
        );
        let result: unknown;
        try {
          result = await toolsClient.invoke(call.name, call.args);
        } catch (err) {
          result = { error: (err as Error).message ?? String(err) };
          await onLog(
            "stderr",
            `[gemini] tool ${call.name} threw: ${(err as Error).message}\n`,
          );
        }
        fnParts.push({
          functionResponse: {
            name: call.name,
            response: toFunctionResponsePayload(result),
          },
        });
      }
      contents.push({ role: "function", parts: fnParts });
      // Loop: next request includes the function responses, and Gemini
      // will either emit more tool calls or a final text answer.
    }
  } catch (err) {
    clearTimeout(overallTimer);
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
  clearTimeout(overallTimer);

  // Build updated history for session persistence: everything in
  // `contents` past the initial resumed history.
  const updatedHistory: GeminiContent[] = contents;

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
    sessionId,
    sessionParams: {
      sessionId,
      history: updatedHistory,
    },
    sessionDisplayId: sessionId,
    provider: PROVIDER_SLUG,
    biller: BILLER_SLUG,
    model: lastModel ?? model,
    billingType: "api",
    costUsd: null,
    resultJson: (lastRaw as Record<string, unknown> | null) ?? null,
    summary: accumulatedText,
    clearSession: false,
    errorMeta: hitIterationCap
      ? { toolIterationCapHit: true, maxToolIterations: MAX_TOOL_ITERATIONS }
      : undefined,
  };
}
