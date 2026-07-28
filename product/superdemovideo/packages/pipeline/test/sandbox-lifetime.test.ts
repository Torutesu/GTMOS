import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox } from "@sdv/pipeline";

const exec = promisify(execFile);
let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

/**
 * Repository commands must not outlive the run that started them.
 *
 * An orphaned `npm install` survived half an hour here, kept holding the
 * shared package cache, and made a later field test fail inside npm with an
 * error that looked like the repository's fault. A command that spawns
 * children — which every package manager does — has to be killed as a group.
 */
describe("timing out a command", () => {
  it("kills the grandchildren too, not just the shell", async () => {
    dir = await mkdtemp(join(tmpdir(), "sdv-sbx-"));
    const marker = join(dir, "marker");
    const sandbox = createSandbox("local");

    // The outer shell starts a background sleep and waits on it. Killing only
    // the shell would leave the sleep running, and it would touch the marker.
    const result = await sandbox.exec(
      `bash -c '(sleep 6; touch ${JSON.stringify(marker)}) & wait'`,
      { cwd: dir, timeoutMs: 1200 },
    );
    expect(result.timedOut).toBe(true);

    await new Promise((r) => setTimeout(r, 6500));
    const { stdout } = await exec("bash", ["-c", `test -e ${JSON.stringify(marker)} && echo yes || echo no`]);
    expect(stdout.trim()).toBe("no");
  }, 20_000);

  it("still reports output collected before the timeout", async () => {
    dir = await mkdtemp(join(tmpdir(), "sdv-sbx-"));
    const result = await createSandbox("local").exec("echo hello; sleep 30", {
      cwd: dir,
      timeoutMs: 1000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.combined).toContain("hello");
  }, 15_000);
});
