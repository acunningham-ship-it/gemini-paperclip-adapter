/**
 * Gemini tool-calling helpers.
 *
 * Paperclip exposes tools to an adapter via `ctx.tools` (list + invoke).
 * Gemini uses a distinct wire format from OpenAI:
 *
 *   request.tools = [{ functionDeclarations: [{ name, description, parameters }] }]
 *
 * and the model's response contains parts shaped like:
 *
 *   { functionCall: { name, args } }
 *
 * When the model emits functionCall parts, we execute them via
 * `ctx.tools.invoke(name, args)` and append a `function` role turn with
 * `{ functionResponse: { name, response } }` parts.
 *
 * The SDK's AdapterExecutionContext type (as of adapter-utils
 * ^2026.416.0) does not statically expose a `tools` field. We read it
 * via a structural cast so the adapter keeps working on older hosts and
 * lights up tool calling on newer ones without a hard dependency bump.
 */

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface PaperclipToolDecl {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  parametersSchema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}

export interface PaperclipToolsClient {
  list?: () => PaperclipToolDecl[] | Promise<PaperclipToolDecl[]>;
  invoke: (name: string, args: unknown) => Promise<unknown> | unknown;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiFunctionCallPart {
  functionCall: { name: string; args?: Record<string, unknown> };
}

export interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}

/**
 * Pull the tools client off AdapterExecutionContext. The SDK type does
 * not declare it yet, so this uses a structural cast that falls back
 * gracefully to undefined on older hosts.
 */
export function readToolsClient(
  ctx: AdapterExecutionContext,
): PaperclipToolsClient | null {
  const maybe = (ctx as unknown as { tools?: unknown }).tools;
  if (!maybe || typeof maybe !== "object") return null;
  const client = maybe as { invoke?: unknown; list?: unknown };
  if (typeof client.invoke !== "function") return null;
  return client as PaperclipToolsClient;
}

/**
 * Also fall back to reading a `tools` array off `config`/`context` when
 * the host hasn't wired the tools client through (e.g. when Paperclip
 * passes the declarations inline in `adapterConfig`).
 */
export function readInlineToolDecls(
  ctx: AdapterExecutionContext,
): PaperclipToolDecl[] {
  const out: PaperclipToolDecl[] = [];
  const fromConfig = (ctx.config as Record<string, unknown>).tools;
  if (Array.isArray(fromConfig)) {
    for (const t of fromConfig) {
      if (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string") {
        out.push(t as PaperclipToolDecl);
      }
    }
  }
  const fromContext = (ctx.context as Record<string, unknown>).tools;
  if (Array.isArray(fromContext)) {
    for (const t of fromContext) {
      if (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string") {
        out.push(t as PaperclipToolDecl);
      }
    }
  }
  return out;
}

/**
 * Translate Paperclip tool declarations to Gemini's `functionDeclarations`
 * shape. Gemini requires JSON-Schema-ish `parameters` (type: "object",
 * properties, required). We pass through whatever schema-like object the
 * host provides under `parametersSchema` / `inputSchema` / `parameters`.
 */
export function toGeminiFunctionDeclarations(
  decls: PaperclipToolDecl[],
): GeminiFunctionDeclaration[] {
  return decls.map((d) => {
    const parameters =
      (d.parametersSchema as Record<string, unknown> | undefined) ??
      (d.inputSchema as Record<string, unknown> | undefined) ??
      (d.parameters as Record<string, unknown> | undefined) ??
      { type: "object", properties: {} };
    const out: GeminiFunctionDeclaration = { name: d.name, parameters };
    if (d.description) out.description = d.description;
    return out;
  });
}

/**
 * Coerce the result of `ctx.tools.invoke` into the shape Gemini wants
 * inside a `functionResponse.response` object.
 */
export function toFunctionResponsePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") return { result: raw };
  if (raw === undefined || raw === null) return { result: null };
  return { result: raw };
}
