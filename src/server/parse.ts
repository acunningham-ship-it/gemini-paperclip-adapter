/**
 * Session codec for the Gemini adapter.
 *
 * Gemini has no native server-side sessions; we resume conversations by
 * replaying the message history on every call. We persist that history
 * (an array of `{ role, parts }` records in Gemini's native shape) plus
 * metadata (cwd, workspace ids) so the next heartbeat can continue the
 * conversation.
 */

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface GeminiPart {
  text?: string;
}

export interface GeminiContent {
  role: "user" | "model";
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

function sanitizeHistory(raw: unknown): GeminiContent[] {
  if (!Array.isArray(raw)) return [];
  const out: GeminiContent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const role = rec.role === "model" ? "model" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    const partsRaw = Array.isArray(rec.parts) ? rec.parts : [];
    const parts: GeminiPart[] = [];
    for (const p of partsRaw) {
      if (!p || typeof p !== "object") continue;
      const text = (p as Record<string, unknown>).text;
      if (typeof text === "string") parts.push({ text });
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
 * Parse a streamGenerateContent response body.
 *
 * Gemini streams a JSON array where each element is a `GenerateContentResponse`.
 * Chunks may arrive as `[`, `,\n{...}`, `\n]`, etc. The simplest robust
 * approach is: buffer the whole body, then JSON.parse the array. For true
 * incremental SSE-style streaming we would read deltas — leave that for a
 * later pass. This helper extracts the concatenated text and the final
 * usage metadata.
 */
export interface GeminiParsedResult {
  text: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  raw: unknown;
}

export function parseGeminiResponse(body: string): GeminiParsedResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Sometimes the stream is newline-delimited JSON rather than a single
    // array. Fall back to parsing line-by-line and stitching.
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

  for (const chunk of chunks) {
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    for (const cand of candidates) {
      if (!cand || typeof cand !== "object") continue;
      const candRec = cand as Record<string, unknown>;
      const content = candRec.content as Record<string, unknown> | undefined;
      if (content && Array.isArray(content.parts)) {
        for (const p of content.parts) {
          if (p && typeof p === "object") {
            const t = (p as Record<string, unknown>).text;
            if (typeof t === "string") text += t;
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

  return { text, finishReason, inputTokens, outputTokens, model, raw: parsed };
}
