import { describe, it, expect, afterEach } from "vitest";
import { startSession, waitForUrl, killSession, sessions, parseNewArgs, resolveMcpConfig } from "./index.js";
import path from "path";
import os from "os";

// Use the project's own directory for tests
const TEST_CWD = path.resolve(__dirname, "..");
const TEST_TIMEOUT = 60_000;

describe("startSession → waitForUrl", () => {
  afterEach(async () => {
    for (const [, s] of sessions) {
      await killSession(s);
    }
  });

  it("spawns remote-control and captures URL", async () => {
    const name = `test-${Date.now()}`;
    const session = await startSession(name, TEST_CWD);

    expect(session.pid).toBeGreaterThan(0);
    expect(sessions.has(name)).toBe(true);

    const url = await waitForUrl(session, 20_000);
    expect(url).not.toBeNull();
    expect(url).toMatch(/^https:\/\/claude\.ai\/code/);
  }, TEST_TIMEOUT);

  it("rejects non-existent cwd", async () => {
    await expect(startSession("bad-cwd", "/nonexistent/path/xyz"))
      .rejects.toThrow("Directory not found");
  });

  it("cleans up session on kill", async () => {
    const name = `kill-${Date.now()}`;
    const session = await startSession(name, TEST_CWD);
    await waitForUrl(session, 20_000);
    await killSession(session);
    expect(sessions.has(name)).toBe(false);
  }, TEST_TIMEOUT);
});

describe("resolveMcpConfig", () => {
  const configPath = path.join(os.homedir(), ".claude.json");

  it("returns null for dir with no MCP config", () => {
    expect(resolveMcpConfig("/tmp", configPath)).toBeNull();
  });
});

describe("parseNewArgs", () => {
  const defaultCwd = "/home/user/projects";

  it("no args — default cwd, generated name", () => {
    const result = parseNewArgs("", defaultCwd);
    expect(result.cwd).toBe(defaultCwd);
    expect(result.name).toMatch(/^[0-9a-f]{6}$/);
  });

  it("dir + name", () => {
    expect(parseNewArgs("my-app bugfix", defaultCwd)).toEqual({
      name: "bugfix",
      cwd: "/home/user/projects/my-app",
    });
  });
});
