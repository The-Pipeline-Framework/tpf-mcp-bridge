import fs from "node:fs";
import path from "node:path";
import type { PlannerProviderMode } from "./types.js";

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
}

export type PlannerCredentialSource = "env" | "codex_auth_fallback";

export interface ResolvedPlannerCredential {
  token: string;
  source: PlannerCredentialSource;
}

export function resolvePlannerToken(
  env: NodeJS.ProcessEnv,
  providerMode: PlannerProviderMode,
  options: { authFilePath?: string } = {}
): string {
  return resolvePlannerCredential(env, providerMode, options).token;
}

export function resolvePlannerCredential(
  env: NodeJS.ProcessEnv,
  providerMode: PlannerProviderMode,
  options: { authFilePath?: string } = {}
): ResolvedPlannerCredential {
  const explicitToken = env.TPF_LLM_TOKEN?.trim();
  if (explicitToken) {
    return { token: explicitToken, source: "env" };
  }
  if (providerMode !== "openai-compatible") {
    throw new Error(
      "Missing required environment variable 'TPF_LLM_TOKEN'. " +
      "Set your planner token locally before starting the TPF MCP bridge."
    );
  }

  const fallbackToken = readCodexGeneratedApiKey(resolveAuthFilePath(env, options.authFilePath));
  if (fallbackToken) {
    return { token: fallbackToken, source: "codex_auth_fallback" };
  }

  throw new Error(
    "Missing required environment variable 'TPF_LLM_TOKEN'. " +
    "For OpenAI-compatible planning, either set TPF_LLM_TOKEN explicitly or sign in to Codex with ChatGPT so the bridge can reuse the generated local credential."
  );
}

function readCodexGeneratedApiKey(authFilePath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath, "utf8")) as CodexAuthFile;
    if (parsed.auth_mode !== "chatgpt") {
      return undefined;
    }
    const token = parsed.OPENAI_API_KEY?.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function resolveAuthFilePath(env: NodeJS.ProcessEnv, explicitPath?: string): string {
  if (explicitPath) {
    return explicitPath;
  }
  const homeDir = env.HOME || env.USERPROFILE;
  return path.join(homeDir || "", ".codex", "auth.json");
}
