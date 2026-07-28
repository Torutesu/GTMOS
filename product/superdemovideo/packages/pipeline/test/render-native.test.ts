import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@sdv/core";
import { createMockLlm } from "@sdv/llm";
import {
  collectUiSource,
  detect,
  readRendered,
  renderNative,
  serveNativeCommand,
  type StageContext,
} from "@sdv/pipeline";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

const TEAM_VIEW = `
import SwiftUI

struct TeamView: View {
  @State private var email = ""
  var body: some View {
    VStack {
      Text("Invite a teammate")
      TextField("Email address", text: $email)
      Button("Send invite") { invite() }
    }
    .navigationTitle("Team")
  }
}
`;

const SETTINGS_VIEW = `
import SwiftUI

struct SettingsView: View {
  var body: some View {
    Form {
      Text("Notifications")
      Toggle("Email me about mentions", isOn: $mentions)
      Button("Sign out") { signOut() }
    }
    .navigationTitle("Settings")
  }
}
`;

const NOT_A_VIEW = `
import Foundation
struct Invite: Codable { let id: UUID; let email: String }
`;

async function repo(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "sdv-native-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

/** Just enough context for the render stage, which touches nothing else. */
function context(): StageContext {
  return {
    llm: createMockLlm(),
    log: createLogger("test"),
    progress: () => {},
  } as unknown as StageContext;
}

describe("finding the interface in a native project", () => {
  it("takes the files that declare a view and leaves the rest", async () => {
    const root = await repo({
      "Sources/TeamView.swift": TEAM_VIEW,
      "Sources/SettingsView.swift": SETTINGS_VIEW,
      "Sources/Models/Invite.swift": NOT_A_VIEW,
      "README.md": "# app",
    });
    const files = await collectUiSource(root, "ios");
    expect(files.map((f) => f.path).sort()).toEqual([
      "Sources/SettingsView.swift",
      "Sources/TeamView.swift",
    ]);
  });

  it("looks at nothing for a platform that serves its own HTML", async () => {
    const root = await repo({ "src/App.tsx": "export default () => <div/>;" });
    expect(await collectUiSource(root, "web")).toEqual([]);
  });

  it("skips build output, which is where a stale copy of everything lives", async () => {
    const root = await repo({
      "Sources/TeamView.swift": TEAM_VIEW,
      "DerivedData/Sources/TeamView.swift": TEAM_VIEW,
      "Pods/Other/PodView.swift": TEAM_VIEW,
    });
    const files = await collectUiSource(root, "ios");
    expect(files.map((f) => f.path)).toEqual(["Sources/TeamView.swift"]);
  });
});

describe("rendering the screens into something servable", () => {
  it("writes a page per screen and a manifest of what it wrote", async () => {
    const root = await repo({
      "Sources/TeamView.swift": TEAM_VIEW,
      "Sources/SettingsView.swift": SETTINGS_VIEW,
    });
    const outDir = join(root, "out");

    const result = await renderNative(context(), {
      srcDir: root,
      platform: "ios",
      outDir,
      port: 4180,
    });

    expect(result.screens.map((s) => s.path).sort()).toEqual(["/", "/settings"]);

    // The paths a flow navigates to must be the files the static server finds.
    const index = await readFile(join(outDir, "index.html"), "utf8");
    const settings = await readFile(join(outDir, "settings.html"), "utf8");
    expect(index).toContain("Send invite");
    expect(settings).toContain("Sign out");
  });

  it("hands the production phase the same screens the candidates came from", async () => {
    // Rendering again there would cost a second model call and, on the live
    // path, would not come back the same — the demo would then be filmed
    // against pages nobody chose.
    const root = await repo({ "Sources/TeamView.swift": TEAM_VIEW });
    const outDir = join(root, "out");

    const rendered = await renderNative(context(), {
      srcDir: root,
      platform: "macos",
      outDir,
      port: 4180,
    });
    const reused = await readRendered(outDir);

    expect(reused).toEqual(rendered.screens);
  });

  it("has nothing to reuse before anything has been rendered", async () => {
    const root = await repo({ "Sources/TeamView.swift": TEAM_VIEW });
    expect(await readRendered(join(root, "out"))).toBeNull();
  });

  it("says so plainly when a project declares no interface it can read", async () => {
    const root = await repo({ "Sources/Models/Invite.swift": NOT_A_VIEW });
    await expect(
      renderNative(context(), { srcDir: root, platform: "ios", outDir: join(root, "out"), port: 4180 }),
    ).rejects.toMatchObject({ code: "SDV-E012" });
  });

  it("serves each screen as itself, with no fallback to the first one", async () => {
    // With a single-page rewrite a mistyped route would film the wrong screen
    // and look like it had worked.
    expect(serveNativeCommand("/tmp/screens", 4180)).not.toContain(" -s ");
    expect(serveNativeCommand("/tmp/screens", 4180)).toContain("4180");
  });
});

describe("a native project reaching the render stage at all", () => {
  it("is recognised without a package.json anywhere in it", async () => {
    const root = await repo({
      "App.xcodeproj/project.pbxproj": "// project",
      "Package.swift": "let package = Package(platforms: [.iOS(.v17)])",
      "Sources/TeamView.swift": TEAM_VIEW,
    });
    const profile = await detect(root);
    expect(profile.platform).toBe("ios");

    const files = await collectUiSource(root, profile.platform);
    expect(files).toHaveLength(1);
  });
});
