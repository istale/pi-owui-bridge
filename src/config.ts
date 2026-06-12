/**
 * Process-level config. RPC-mode bridge needs many fewer knobs than the
 * old loop-driving bridge: we only point at things that the spawned Pi
 * process needs to know about.
 */
export interface BridgeConfig {
  readonly hubBaseUrl: string;
  readonly hubApiKey: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly owuiBaseUrl: string;
  readonly piSharedSecret: string;
  readonly observationDir: string | null;
  readonly skillsDir: string | null;
  readonly piCliPath: string;
  readonly extensionPath: string;
  readonly port: number;
  readonly idleEvictMs: number;
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
    hubBaseUrl: req("AOH_UPSTREAM_BASE_URL"),
    hubApiKey: req("AOH_UPSTREAM_API_KEY"),
    modelProvider: opt("AOH_UPSTREAM_PROVIDER", "aoh-hub"),
    modelId: opt("AOH_UPSTREAM_MODEL", "MiniMax-M2"),
    owuiBaseUrl: req("AOH_OWUI_BASE_URL"),
    piSharedSecret: req("AOH_PI_SHARED_SECRET"),
    observationDir: process.env.AOH_OBSERVATION_DIR?.trim() || null,
    skillsDir: process.env.AOH_SKILLS_DIR?.trim() || null,
    piCliPath: req("AOH_PI_CLI_PATH"),
    extensionPath: req("AOH_PI_EXTENSION_PATH"),
    port: Number(opt("AOH_BRIDGE_PORT", "19000")),
    idleEvictMs: Number(opt("AOH_PI_IDLE_EVICT_MS", "300000")), // 5 min default
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
