/**
 * Session codec + streaming-response parser for the Gemini adapter.
 *
 * Gemini has no native server-side sessions; we resume conversations by
 * replaying the message history on every call. We persist that history
 * (an array of `{ role, parts }` records in Gemini's native shape — now
 * also including `functionCall` / `functionResponse` parts) plus
 * metadata (cwd, workspace ids) so the next heartbeat can continue the
 * conversation.
 */

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface GeminiTextPart {
  text: string;
}
export interface GeminiFunctionCallPart {
  functionCall: { name: string; args?: Record<string, unknown> };
}
export interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}
export type GeminiPart =
  | GeminiTextPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | Record<string, unknown>;

export interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

export interface GeminiSessionParams {
  sessionId: string;
  history: GeminiContent[];
  cwd?: string;
  workspaceId?: string;
  repoUrl?: string;
  repoRef?: string;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizePart(p: unknown): GeminiPart | null {
  if (!p || typeof p !== "object") return null;
  const rec = p as Record<string, unknown>;
  if (typeof rec.text === "string") return { text: rec.text };
  if (rec.functionCall && typeof rec.functionCall === "object") {
    const fc = rec.functionCall as Record<string, unknown>;
    if (typeof fc.name === "string") {
      return {
        functionCall: {
          name: fc.name,
          args: (fc.args && typeof fc.args === "object"
            ? (fc.args as Record<string, unknown>)
            : {}) as Record<string, unknown>,
        },
      };
    }
  }
  if (rec.functionResponse && typeof rec.functionResponse === "object") {
    const fr = rec.functionResponse as Record<string, unknown>;
    if (typeof fr.name === "string") {
      return {
        functionResponse: {
          name: fr.name,
          response: (fr.response && typeof fr.response === "object"
            ? (fr.response as Record<string, unknown>)
            : {}) as Record<string, unknown>,
        },
      };
    }
  }
  return null;
}

function sanitizeHistory(raw: unknown): GeminiContent[] {
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
      const clean = sanitizePart(p);
      if (clean) parts.push(clean);
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const out: Record<string, unknown> = { sessionId };
    out.history = sanitizeHistory(record.history);
    const cwd = readNonEmptyString(record.cwd);
    if (cwd) out.cwd = cwd;
    const workspaceId = readNonEmptyString(record.workspaceId);
    if (workspaceId) out.workspaceId = workspaceId;
    const repoUrl = readNonEmptyString(record.repoUrl);
    if (repoUrl) out.repoUrl = repoUrl;
    const repoRef = readNonEmptyString(record.repoRef);
    if (repoRef) out.repoRef = repoRef;
    return out;
  },
  serialize(params) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const out: Record<string, unknown> = {
      sessionId,
      history: sanitizeHistory(params.history),
    };
    const cwd = readNonEmptyString(params.cwd);
    if (cwd) out.cwd = cwd;
    const workspaceId = readNonEmptyString(params.workspaceId);
    if (workspaceId) out.workspaceId = workspaceId;
    const repoUrl = readNonEmptyString(params.repoUrl);
    if (repoUrl) out.repoUrl = repoUrl;
    const repoRef = readNonEmptyString(params.repoRef);
    if (repoRef) out.repoRef = repoRef;
    return out;
  },
  getDisplayId(params) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

/**
 * Parsed view of a streamGenerateContent response.
 *
 * `functionCalls` lists every `functionCall` part the model emitted in
 * this turn; the caller dispatches them, appends a `function`-role turn
 * with the results, and loops.
 */
export interface GeminiParsedResult {
  text: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  /** Raw parts (text + functionCall) from the assistant turn, in order. */
  modelParts: GeminiPart[];
  /** Just the functionCall entries, for convenience. */
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
  raw: unknown;
}

/**
 * Parse a streamGenerateContent response body.
 *
 * Gemini streams a JSON array where each element is a `GenerateContentResponse`.
 * Chunks may arrive as `[`, `,\n{...}`, `\n]`, etc. The simplest robust
 * approach is: buffer the whole body, then JSON.parse the array. For true
 * incremental SSE-style streaming we would read deltas — leave that for a
 * later pass. This helper extracts the concatenated text, any functionCall
 * parts, and the final usage metadata.
 */
export function parseGeminiResponse(body: string): GeminiParsedResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const chunks: unknown[] = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^data:\s*/, "").replace(/^[,\[\]]+|[,\[\]]+$/g, "");
      if (!trimmed) continue;
      try {
        chunks.push(JSON.parse(trimmed));
      } catch {
        // skip malformed chunk
      }
    }
    parsed = chunks;
  }

  const chunks: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : parsed && typeof parsed === "object"
      ? [parsed as Record<string, unknown>]
      : [];

  let text = "";
  let finishReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | null = null;
  const modelParts: GeminiPart[] = [];
  const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    for (const cand of candidates) {
      if (!cand || typeof cand !== "object") continue;
      const candRec = cand as Record<string, unknown>;
      const content = candRec.content as Record<string, unknown> | undefined;
      if (content && Array.isArray(content.parts)) {
        for (const p of content.parts) {
          if (!p || typeof p !== "object") continue;
          const rec = p as Record<string, unknown>;
          if (typeof rec.text === "string") {
            text += rec.text;
            modelParts.push({ text: rec.text });
          } else if (rec.functionCall && typeof rec.functionCall === "object") {
            const fc = rec.functionCall as Record<string, unknown>;
            if (typeof fc.name === "string") {
              const args =
                fc.args && typeof fc.args === "object"
                  ? (fc.args as Record<string, unknown>)
                  : {};
              functionCalls.push({ name: fc.name, args });
              modelParts.push({ functionCall: { name: fc.name, args } });
            }
          }
        }
      }
      if (typeof candRec.finishReason === "string") finishReason = candRec.finishReason;
    }
    const usage = chunk.usageMetadata as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
      if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
    }
    if (typeof chunk.modelVersion === "string") model = chunk.modelVersion;
  }

  return {
    text,
    finishReason,
    inputTokens,
    outputTokens,
    model,
    modelParts,
    functionCalls,
    raw: parsed,
  };
}
