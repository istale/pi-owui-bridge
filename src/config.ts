/**
 * Process-level config read once from the environment. Mirrors the env
 * surface of the (now superseded) Python pi-adapter so the same .env
 * keeps working.
 */
export interface BridgeConfig {
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
  readonly upstreamModel: string;
  readonly upstreamProvider: string;
  readonly owuiBaseUrl: string;
  readonly piSharedSecret: string;
  readonly maxToolIterations: number;
  readonly requestTimeoutMs: number;
  readonly observationDir: string | null;
  readonly skillsDir: string | null;
  readonly port: number;
}

function req(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`environment variable ${name} is required`);
  return v;
}

function opt(name: string, def: string): string {
  return (process.env[name] ?? def).trim();
}

let cached: BridgeConfig | null = null;

export function getConfig(): BridgeConfig {
  if (cached) return cached;
  cached = {
    upstreamBaseUrl: req("AOH_UPSTREAM_BASE_URL"),
    upstreamApiKey: req("AOH_UPSTREAM_API_KEY"),
    upstreamModel: opt("AOH_UPSTREAM_MODEL", "MiniMax-M2"),
    upstreamProvider: opt("AOH_UPSTREAM_PROVIDER", "openai-completions"),
    owuiBaseUrl: req("AOH_OWUI_BASE_URL"),
    piSharedSecret: req("AOH_PI_SHARED_SECRET"),
    maxToolIterations: Number(opt("AOH_MAX_TOOL_ITERATIONS", "8")),
    requestTimeoutMs: Number(opt("AOH_REQUEST_TIMEOUT_S", "120")) * 1000,
    observationDir: process.env.AOH_OBSERVATION_DIR?.trim() || null,
    skillsDir: process.env.AOH_SKILLS_DIR?.trim() || null,
    port: Number(opt("AOH_BRIDGE_PORT", "19000")),
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
