import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearToken, configDir, configPath, readConfig, resolveConfig, writeConfig } from "./config.js";

const tmp = () => mkdtemp(join(tmpdir(), "rivtor-cfg-"));

describe("config", () => {
  it("defaults to ~/.config/rivtor and honours XDG_CONFIG_HOME / RIVTOR_CONFIG_DIR", () => {
    expect(configDir({})).toMatch(/\.config[/\\]rivtor$/);
    expect(configDir({ XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "rivtor"));
    expect(configDir({ RIVTOR_CONFIG_DIR: "/y", XDG_CONFIG_HOME: "/x" })).toBe("/y");
  });

  it("writes the config with mode 0600 in a 0700 dir", async () => {
    const env = { RIVTOR_CONFIG_DIR: join(await tmp(), "nested") };
    await writeConfig({ token: "rvt_abc" }, env);
    const st = await stat(configPath(env));
    if (process.platform !== "win32") {
      expect(st.mode & 0o777).toBe(0o600);
      expect((await stat(configDir(env))).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(await readFile(configPath(env), "utf8"))).toEqual({ token: "rvt_abc" });
  });

  it("tightens permissions of a pre-existing file", async () => {
    const env = { RIVTOR_CONFIG_DIR: await tmp() };
    await writeFile(configPath(env), "{}", { mode: 0o644 });
    await writeConfig({ token: "rvt_abc" }, env);
    if (process.platform !== "win32") expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
  });

  it("env vars override the saved config", async () => {
    const env: Record<string, string> = { RIVTOR_CONFIG_DIR: await tmp() };
    await writeConfig({ token: "rvt_saved", apiUrl: "https://saved.test/" }, env);
    expect(await resolveConfig(env)).toEqual({ token: "rvt_saved", apiUrl: "https://saved.test", tokenSource: "config" });
    env.RIVTOR_TOKEN = "rvt_env";
    env.RIVTOR_API_URL = "http://localhost:4000/";
    expect(await resolveConfig(env)).toEqual({ token: "rvt_env", apiUrl: "http://localhost:4000", tokenSource: "env" });
  });

  it("defaults the API URL and tolerates a corrupt file", async () => {
    const env = { RIVTOR_CONFIG_DIR: await tmp() };
    await writeFile(configPath(env), "not json");
    expect(await readConfig(env)).toEqual({});
    expect(await resolveConfig(env)).toEqual({ token: null, apiUrl: "https://api.rivtor.com", tokenSource: null });
  });

  it("logout removes the token", async () => {
    const env = { RIVTOR_CONFIG_DIR: await tmp() };
    expect(await clearToken(env)).toBe(false);
    await writeConfig({ token: "rvt_abc", apiUrl: "https://x.test" }, env);
    expect(await clearToken(env)).toBe(true);
    expect(await readConfig(env)).toEqual({ apiUrl: "https://x.test" });
  });
});
