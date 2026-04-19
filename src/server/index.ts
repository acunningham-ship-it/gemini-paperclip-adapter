/**
 * Server-side barrel for the Gemini adapter.
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  DEFAULT_MODEL,
  GEMINI_MODELS_URL,
} from "../shared/constants.js";

export { execute } from "./execute.js";
export { detectModel } from "./detect-model.js";
export { sessionCodec } from "./parse.js";

function makeCheck(
  level: AdapterEnvironmentCheckLevel,
  code: string,
  message: string,
  extras: { detail?: string | null; hint?: string | null } = {},
): AdapterEnvironmentCheck {
  return {
    code,
    level,
    message,
    detail: extras.detail ?? null,
    hint: extras.hint ?? null,
  };
}

function resolveApiKey(config: Record<string, unknown>): { key: string; source: string } | null {
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const fromConfig =
    typeof envConfig.GEMINI_API_KEY === "string" ? envConfig.GEMINI_API_KEY.trim() : "";
  if (fromConfig) return { key: fromConfig, source: "agent.env.GEMINI_API_KEY" };
  const fromProc = (process.env.GEMINI_API_KEY ?? "").trim();
  if (fromProc) return { key: fromProc, source: "process.env.GEMINI_API_KEY" };
  const fromProcGoogle = (process.env.GOOGLE_API_KEY ?? "").trim();
  if (fromProcGoogle) return { key: fromProcGoogle, source: "process.env.GOOGLE_API_KEY" };
  return null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const checks: AdapterEnvironmentCheck[] = [];

  const keyInfo = resolveApiKey(config);
  if (!keyInfo) {
    checks.push(
      makeCheck("error", "gemini_no_api_key", `${AUTH_ENV_VAR} not configured`, {
        hint: `Set ${AUTH_ENV_VAR} in the agent's adapter env or the Paperclip process environment.`,
      }),
    );
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push(
    makeCheck("info", "gemini_api_key_found", `Gemini API key resolved from: ${keyInfo.source}`),
  );

  const model =
    typeof config.model === "string" && config.model.trim().length > 0
      ? config.model.trim()
      : DEFAULT_MODEL;
  checks.push(makeCheck("info", "gemini_model_configured", `Model: ${model}`));

  // Try the models endpoint. Gemini auth is `?key=`.
  try {
    const url = `${GEMINI_MODELS_URL}?key=${encodeURIComponent(keyInfo.key)}`;
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      const level: AdapterEnvironmentCheckLevel =
        resp.status === 401 || resp.status === 403 ? "error" : "warn";
      checks.push(
        makeCheck(level, "gemini_models_http_error", `Gemini /models returned HTTP ${resp.status}`, {
          hint:
            level === "error"
              ? "Verify the key at https://aistudio.google.com/app/apikey"
              : null,
        }),
      );
    } else {
      checks.push(makeCheck("info", "gemini_reachable", "Gemini /models endpoint reachable"));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push(
      makeCheck("warn", "gemini_unreachable", "Could not reach Gemini /models endpoint", {
        detail: message,
      }),
    );
  }

  const status: AdapterEnvironmentTestResult["status"] = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: ADAPTER_TYPE,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
