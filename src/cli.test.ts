import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";

describe("caffeinate keep-awake", () => {
  const pids: number[] = [];

  afterEach(() => {
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    pids.length = 0;
  });

  it("spawns caffeinate and it is actually a caffeinate process", () => {
    const dummy = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    dummy.unref();
    pids.push(dummy.pid!);

    const caff = spawn("caffeinate", ["-i", "-w", String(dummy.pid)], {
      detached: true,
      stdio: "ignore",
    });
    caff.unref();
    pids.push(caff.pid!);

    const psOutput = execSync(`ps -p ${caff.pid} -o comm=`).toString().trim();
    expect(psOutput).toContain("caffeinate");
  });

  it("caffeinate stays alive while target process is alive", async () => {
    const dummy = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    dummy.unref();
    pids.push(dummy.pid!);

    const caff = spawn("caffeinate", ["-i", "-w", String(dummy.pid)], {
      detached: true,
      stdio: "ignore",
    });
    caff.unref();
    pids.push(caff.pid!);

    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(caff.pid!, 0)).not.toThrow();
  }, 10_000);

  it("caffeinate auto-exits when target process dies (-w flag)", async () => {
    const dummy = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    dummy.unref();
    pids.push(dummy.pid!);

    const caff = spawn("caffeinate", ["-i", "-w", String(dummy.pid)], {
      detached: true,
      stdio: "ignore",
    });
    caff.unref();
    pids.push(caff.pid!);

    // Verify caffeinate is alive
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(caff.pid!, 0)).not.toThrow();

    // Kill target — caffeinate should auto-exit
    process.kill(dummy.pid!, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));

    expect(() => process.kill(caff.pid!, 0)).toThrow();
  }, 10_000);

  it("caffeinate PID file round-trip works correctly", () => {
    const dummy = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    dummy.unref();
    pids.push(dummy.pid!);

    const caff = spawn("caffeinate", ["-i", "-w", String(dummy.pid)], {
      detached: true,
      stdio: "ignore",
    });
    caff.unref();
    pids.push(caff.pid!);

    // Write PID file like cmdStart does
    const tmpPidFile = path.join("/tmp", `test-caffeinate-${Date.now()}.pid`);
    fs.writeFileSync(tmpPidFile, String(caff.pid));

    // Read back and verify
    const savedPid = parseInt(fs.readFileSync(tmpPidFile, "utf-8").trim(), 10);
    expect(savedPid).toBe(caff.pid);

    // Verify it's actually alive via the saved PID
    expect(() => process.kill(savedPid, 0)).not.toThrow();

    fs.unlinkSync(tmpPidFile);
  });
});
