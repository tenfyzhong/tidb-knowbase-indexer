import * as core from "@actions/core";
import { z } from "zod";

export const GitSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal("git"),
  url: z.string().min(1),
  branch: z.string().default("main"),
  include: z.array(z.string()).default(["**/*.md", "**/*.txt"]),
  exclude: z.array(z.string()).default([]),
  token: z.string().optional()
});

export type GitSource = z.infer<typeof GitSourceSchema>;

export const WebSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal("web"),
  url: z.string().url(),
  maxDepth: z.number().int().min(1).default(2),
  urlPattern: z.string().optional(),
  headers: z.record(z.string()).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional()
});

export type WebSource = z.infer<typeof WebSourceSchema>;

export const SourceSchema = z.discriminatedUnion("type", [
  GitSourceSchema,
  WebSourceSchema
]);

export type Source = z.infer<typeof SourceSchema>;

export const ConfigSchema = z.array(SourceSchema).min(1);
export type Config = z.infer<typeof ConfigSchema>;

export const EnvSchema = z.object({
  // TiDB connection settings
  TIDB_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  TIDB_HOST: z.string().optional(),
  TIDB_PORT: z.coerce.number().int().default(4000),
  TIDB_USER: z.string().optional(),
  TIDB_PASSWORD: z.string().optional(),
  TIDB_DATABASE: z.string().default("test"),
  TIDB_SSL: z.preprocess((val) => {
    if (typeof val === "string") return val.toLowerCase() !== "false";
    return val ?? true;
  }, z.boolean()).default(true),

  // Embedding provider configuration
  EMBEDDING_PROVIDER: z.enum(["openai", "huggingface", "gemini", "mock"]).default("openai"),
  EMBEDDING_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  HF_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().default("https://api.siliconflow.cn/v1"),
  EMBEDDING_MODEL: z.string().default("BAAI/bge-m3"),
  EMBEDDING_DIMENSION: z.coerce.number().int().default(1024),

  // Git authentication
  GH_PAT: z.string().optional(),
  GH_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional()
});

export type Env = z.infer<typeof EnvSchema>;

export function parseConfig(rawJson: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Failed to parse CONFIG_JSON as valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ConfigSchema.parse(parsed);
}

export function parseEnv(rawEnv: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }

  const env = result.data;
  const hasDbUrl = Boolean(env.TIDB_DATABASE_URL || env.DATABASE_URL);
  const hasDbHost = Boolean(env.TIDB_HOST && env.TIDB_USER);

  if (!hasDbUrl && !hasDbHost) {
    throw new Error(
      "Missing database connection settings. Please provide TIDB_DATABASE_URL (or DATABASE_URL), or TIDB_HOST and TIDB_USER."
    );
  }

  return env;
}

export function sanitizeLogs(config: Config, env: Env): void {
  const secretsToMask: string[] = [];

  if (env.TIDB_DATABASE_URL) secretsToMask.push(env.TIDB_DATABASE_URL);
  if (env.DATABASE_URL) secretsToMask.push(env.DATABASE_URL);
  if (env.TIDB_PASSWORD) secretsToMask.push(env.TIDB_PASSWORD);
  if (env.EMBEDDING_API_KEY) secretsToMask.push(env.EMBEDDING_API_KEY);
  if (env.OPENAI_API_KEY) secretsToMask.push(env.OPENAI_API_KEY);
  if (env.HF_TOKEN) secretsToMask.push(env.HF_TOKEN);
  if (env.GEMINI_API_KEY) secretsToMask.push(env.GEMINI_API_KEY);
  if (env.GH_PAT) secretsToMask.push(env.GH_PAT);
  if (env.GH_TOKEN) secretsToMask.push(env.GH_TOKEN);
  if (env.GITHUB_TOKEN) secretsToMask.push(env.GITHUB_TOKEN);

  for (const source of config) {
    if (source.type === "git" && source.token) {
      secretsToMask.push(source.token);
    }
    if (source.url && source.url.length > 3) {
      try {
        const parsedUrl = new URL(source.url);
        if (parsedUrl.password && parsedUrl.password.length > 3) {
          secretsToMask.push(parsedUrl.password);
        }
      } catch {
        // Not a standard HTTP URL
      }
    }
  }

  for (const secret of secretsToMask) {
    if (secret && secret.length >= 4) {
      core.setSecret(secret);
    }
  }
}
