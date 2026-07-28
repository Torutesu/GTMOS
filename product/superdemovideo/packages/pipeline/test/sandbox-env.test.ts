import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox } from "@sdv/pipeline";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function envOf(): Promise<Record<string, string>> {
  dir = await mkdtemp(join(tmpdir(), "sdv-env-"));
  const res = await createSandbox("local").exec("env", { cwd: dir, timeoutMs: 15_000 });
  const out: Record<string, string> = {};
  for (const line of res.combined.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * What a repository's own commands are allowed to see.
 *
 * Two failures pull in opposite directions and both are real. Leaking an API
 * key into an install script is the obvious one. The other cost us a day:
 * stripping the proxy and CA settings left corepack unable to fetch the
 * pinned package manager, failing with a certificate error that reads as a
 * broken repository. Network configuration describes the machine, not the
 * account.
 */
describe("the environment handed to repository commands", () => {
  it("carries no credentials or product configuration", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-should-not-leak";
    process.env["SDV_TOKEN"] = "token-should-not-leak";
    try {
      const env = await envOf();
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(env["SDV_TOKEN"]).toBeUndefined();
      expect(Object.keys(env).some((k) => k.startsWith("SDV_"))).toBe(false);
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
      delete process.env["SDV_TOKEN"];
    }
  }, 30_000);

  it("carries the network configuration, or nothing can be installed", async () => {
    process.env["HTTPS_PROXY"] = "http://proxy.test:8080";
    process.env["NODE_EXTRA_CA_CERTS"] = "/etc/ssl/test-bundle.crt";
    try {
      const env = await envOf();
      expect(env["HTTPS_PROXY"]).toBe("http://proxy.test:8080");
      expect(env["NODE_EXTRA_CA_CERTS"]).toBe("/etc/ssl/test-bundle.crt");
    } finally {
      delete process.env["HTTPS_PROXY"];
      delete process.env["NODE_EXTRA_CA_CERTS"];
    }
  }, 30_000);

  it("never lets a package manager download a browser", async () => {
    const env = await envOf();
    expect(env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"]).toBe("1");
    expect(env["PUPPETEER_SKIP_DOWNLOAD"]).toBe("1");
  }, 30_000);
});

describe("install scripts that assume a git checkout", () => {
  it("tells git hook installers to stand down", async () => {
    // ingest drops .git on purpose, so a `prepare: husky install` aborts and
    // takes the whole install with it. tldraw failed there after resolving
    // and fetching every dependency successfully.
    const env = await envOf();
    expect(env["HUSKY"]).toBe("0");
  }, 30_000);
});
