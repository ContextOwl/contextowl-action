// Loads and validates .contextowl.yml and merges action inputs over it.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ConfigSchema = z
  .object({
    server: z.string().url().optional(),
    workspace: z.string().min(1).optional(),
    docs: z
      .object({ dir: z.string().min(1) })
      .strict()
      .optional(),
    changelog: z
      .object({ file: z.string().min(1) })
      .strict()
      .optional(),
    openapi: z
      .object({ spec: z.string().min(1) })
      .strict()
      .optional(),
    prune: z.boolean().optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface ActionInputs {
  token: string;
  serverUrl: string;
  configPath: string;
  workspace: string;
  prune: boolean;
  dryRun: boolean;
}

/** Fully resolved settings the sync engine runs against. */
export interface ResolvedConfig {
  apiUrl: string;
  token: string;
  workspace: string | undefined;
  prune: boolean;
  dryRun: boolean;
  docs?: { dir: string };
  changelog?: { file: string };
  openapi?: { spec: string };
}

/** Parse and validate raw YAML text into a RawConfig. Throws on invalid shape. */
export function parseConfig(text: string): RawConfig {
  const data = parseYaml(text) ?? {};
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }
  return result.data;
}

/** Join a base server URL with the REST API path, tolerating trailing slashes. */
export function apiUrlFrom(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("server-url is empty");
  return `${trimmed}/api/v1`;
}

/**
 * Resolve inputs + config file into the effective settings. `server-url` and
 * `workspace` inputs override the config file; prune is enabled if either the
 * input or the config file asks for it. At least one of docs/changelog/openapi
 * must be configured.
 */
export function resolveConfig(inputs: ActionInputs): ResolvedConfig {
  let raw: RawConfig;
  try {
    raw = parseConfig(readFileSync(inputs.configPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Config file not found: ${inputs.configPath}`);
    }
    throw err;
  }

  const serverUrl = inputs.serverUrl || raw.server || "";
  const workspace = inputs.workspace || raw.workspace || undefined;

  if (!raw.docs && !raw.changelog && !raw.openapi) {
    throw new Error("Config must define at least one of: docs, changelog, openapi.");
  }

  return {
    apiUrl: apiUrlFrom(serverUrl),
    token: inputs.token,
    workspace,
    prune: inputs.prune || raw.prune === true,
    dryRun: inputs.dryRun,
    docs: raw.docs,
    changelog: raw.changelog,
    openapi: raw.openapi,
  };
}
