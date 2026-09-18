import { describe, it, expect, vi } from "vitest";
import { resolveSslOptions } from "./db.js";
import * as core from "@actions/core";
import { parseConfig, parseEnv, sanitizeLogs } from "./config.js";

vi.mock("@actions/core", () => ({
  setSecret: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn()
}));

describe("config", () => {
  describe("parseConfig", () => {
    it("should parse valid Git and Web sources", () => {
      const json = JSON.stringify([
        {
          name: "notes",
          type: "git",
          url: "https://github.com/example/notes.git",
          branch: "main",
          include: ["**/*.md"],
          exclude: ["private/**"]
        },
        {
          name: "blog",
          type: "web",
          url: "https://example.com",
          maxDepth: 2,
          urlPattern: "https://example.com/posts/.*"
        }
      ]);

      const config = parseConfig(json);
      expect(config).toHaveLength(2);
      expect(config[0].name).toBe("notes");
      expect(config[0].type).toBe("git");
      expect(config[1].name).toBe("blog");
      expect(config[1].type).toBe("web");
    });

    it("should throw error on invalid JSON", () => {
      expect(() => parseConfig("invalid json")).toThrow("Failed to parse CONFIG_JSON");
    });

    it("should throw error on empty config array", () => {
      expect(() => parseConfig("[]")).toThrow();
    });
  });

  describe("parseEnv", () => {
    it("should parse env with TIDB_DATABASE_URL", () => {
      const rawEnv = {
        TIDB_DATABASE_URL: "mysql://user:pass@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/test"
      };

      const env = parseEnv(rawEnv);
      expect(env.TIDB_DATABASE_URL).toBe(rawEnv.TIDB_DATABASE_URL);
    });

    it("should parse env with host and user", () => {
      const rawEnv = {
        TIDB_HOST: "127.0.0.1",
        TIDB_PORT: "4000",
        TIDB_USER: "root",
        TIDB_PASSWORD: "secretpassword",
        TIDB_DATABASE: "my_kb",
      };

      const env = parseEnv(rawEnv);
      expect(env.TIDB_HOST).toBe("127.0.0.1");
      expect(env.TIDB_PORT).toBe(4000);
      expect(env.TIDB_USER).toBe("root");
      expect(env.TIDB_PASSWORD).toBe("secretpassword");
      expect(env.TIDB_DATABASE).toBe("my_kb");
    });

    it("should throw error when database settings are missing", () => {
      expect(() => parseEnv({})).toThrow("Missing database connection settings");
    });

    it("should parse Cloudflare embedding environment variables", () => {
      const rawEnv = {
        TIDB_DATABASE_URL: "mysql://user:pass@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/test",
        EMBEDDING_PROVIDER: "cloudflare",
        CLOUDFLARE_API_TOKEN: "cf-token-12345",
        CLOUDFLARE_ACCOUNT_ID: "cf-account-67890",
        CLOUDFLARE_MODEL: "@cf/baai/bge-m3",
        EMBEDDING_DIMENSION: "1024"
      };

      const env = parseEnv(rawEnv);
      expect(env.EMBEDDING_PROVIDER).toBe("cloudflare");
      expect(env.CLOUDFLARE_API_TOKEN).toBe("cf-token-12345");
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("cf-account-67890");
      expect(env.CLOUDFLARE_MODEL).toBe("@cf/baai/bge-m3");
      expect(env.EMBEDDING_DIMENSION).toBe(1024);
    });
  });

    it("should configure TLS with minimum TLSv1.2 by default", () => {
      const env = parseEnv({
        TIDB_DATABASE_URL: "mysql://localhost/test"
      });
      expect(env.TIDB_SSL).toBe(true);
      expect(env.TIDB_SSL_REJECT_UNAUTHORIZED).toBe(true);

      const ssl = resolveSslOptions(env);
      expect(ssl).toEqual({
        minVersion: "TLSv1.2",
        rejectUnauthorized: true
      });
    });

    it("should support custom CA and disabling TLS if explicitly requested", () => {
      const envWithCa = parseEnv({
        TIDB_DATABASE_URL: "mysql://localhost/test",
        TIDB_CA: "-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----",
        TIDB_SSL_REJECT_UNAUTHORIZED: "false"
      });
      const sslWithCa = resolveSslOptions(envWithCa);
      expect(sslWithCa?.ca).toContain("BEGIN CERTIFICATE");
      expect(sslWithCa?.rejectUnauthorized).toBe(false);

      const envDisabled = parseEnv({
        TIDB_DATABASE_URL: "mysql://localhost/test",
        TIDB_SSL: "false"
      });
      expect(resolveSslOptions(envDisabled)).toBeUndefined();
    });

  describe("sanitizeLogs", () => {
    it("should register secrets to core.setSecret", () => {
      const setSecretSpy = vi.spyOn(core, "setSecret");

      const config = parseConfig(
        JSON.stringify([
          {
            name: "private-repo",
            type: "git",
            url: "https://github.com/example/repo.git",
            token: "ghp_secret_token_value_123"
          }
        ])
      );

      const env = parseEnv({
        TIDB_DATABASE_URL: "mysql://user:pass12345@gateway.tidbcloud.com:4000/test",
        TIDB_PASSWORD: "secret_db_password",
        GH_PAT: "ghp_pat_secret_987",
        CLOUDFLARE_API_TOKEN: "cf-token-secret-value",
        CLOUDFLARE_ACCOUNT_ID: "cf-acc-secret-value"
      });

      sanitizeLogs(config, env);

      expect(setSecretSpy).toHaveBeenCalledWith("mysql://user:pass12345@gateway.tidbcloud.com:4000/test");
      expect(setSecretSpy).toHaveBeenCalledWith("secret_db_password");
      expect(setSecretSpy).toHaveBeenCalledWith("ghp_pat_secret_987");
      expect(setSecretSpy).toHaveBeenCalledWith("ghp_secret_token_value_123");
      expect(setSecretSpy).toHaveBeenCalledWith("cf-token-secret-value");
      expect(setSecretSpy).toHaveBeenCalledWith("cf-acc-secret-value");
    });
  });
});
