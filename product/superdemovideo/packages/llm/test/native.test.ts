import { describe, expect, it } from "vitest";
import { Flow } from "@sdv/core";
import {
  createMockLlm,
  extractControls,
  renderScreensDeterministically,
  screenControls,
  screenToSteps,
  screensToUseCases,
  type NativeScreen,
  type RepoDigest,
} from "../src/index.ts";

const SWIFT = `
import SwiftUI

struct TeamView: View {
  @State private var email = ""
  var body: some View {
    VStack {
      Text("Invite a teammate")
      TextField("Email address", text: $email)
      Toggle("Can edit", isOn: $canEdit)
      Button("Send invite") { invite() }
    }
    .navigationTitle("Team")
  }
}
`;

const SWIFT_SETTINGS = `
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

const COMPOSE = `
@Composable
fun HomeScreen() {
  Column {
    Text("Today")
    OutlinedTextField(value = q, onValueChange = {}, label = { Text("Search") })
    Button(onClick = { open() }) { Text("New entry") }
  }
}
`;

describe("reading a declared interface", () => {
  it("takes the labels in the order the source declares them", () => {
    const controls = extractControls(SWIFT, "ios");
    expect(controls.map((c) => c.label)).toEqual([
      "Invite a teammate",
      "Email address",
      "Can edit",
      "Send invite",
      "Team",
    ]);
    expect(controls.find((c) => c.label === "Send invite")?.kind).toBe("button");
    expect(controls.find((c) => c.label === "Email address")?.kind).toBe("field");
  });

  it("reads Compose the same way", () => {
    const controls = extractControls(COMPOSE, "android");
    expect(controls.map((c) => c.kind)).toContain("field");
    expect(controls.find((c) => c.label === "New entry")?.kind).toBe("button");
  });

  it("says nothing about a file that declares nothing", () => {
    expect(extractControls("struct Model: Codable { let id: Int }", "ios")).toEqual([]);
  });
});

describe("rendering screens", () => {
  const screens = renderScreensDeterministically({
    platform: "ios",
    files: [
      { path: "Sources/TeamView.swift", text: SWIFT },
      { path: "Sources/SettingsView.swift", text: SWIFT_SETTINGS },
    ],
  });

  it("gives the first screen the root path and names the rest after themselves", () => {
    expect(screens.map((s) => s.path)).toEqual(["/", "/settings"]);
    expect(screens.map((s) => s.title)).toEqual(["Team", "Settings"]);
  });

  it("keeps the source file so a person can check the rendition", () => {
    expect(screens[0]!.source).toBe("Sources/TeamView.swift");
  });

  it("uses real elements, because capture resolves targets by role", () => {
    const html = screens[0]!.html;
    expect(html).toContain("<button type=\"button\">Send invite</button>");
    expect(html).toMatch(/<input type="text"/);
    expect(html).toContain("<!doctype html>");
  });

  it("links the screens to each other so a demo can move between them", () => {
    expect(screens[0]!.html).toContain('<a href="/settings"');
    expect(screens[1]!.html).toContain('<a href="/"');
    expect(screens[1]!.html).toMatch(/aria-current="page"[^>]*>Settings|Settings<\/a>/);
  });

  it("puts the screen's own name at the top, wherever the source mentions it", () => {
    // `.navigationTitle("Settings")` is written last in SwiftUI. Rendered in
    // source order it lands under the sign-out button.
    const body = screens[1]!.html;
    expect(body.indexOf("<h1>Settings</h1>")).toBeLessThan(body.indexOf("Sign out"));
  });

  it("puts no words on the page that the source did not have", () => {
    const body = screens[0]!.html.split("<body>")[1]!;
    for (const label of ["Invite a teammate", "Send invite", "Email address"]) {
      expect(body).toContain(label);
    }
    expect(body).not.toMatch(/Lorem|example\.com|Acme/);
  });
});

describe("reading a rendered screen back", () => {
  const [team] = renderScreensDeterministically({
    platform: "ios",
    files: [
      { path: "Sources/TeamView.swift", text: SWIFT },
      { path: "Sources/SettingsView.swift", text: SWIFT_SETTINGS },
    ],
  });

  it("finds the controls the page actually has", () => {
    const controls = screenControls(team!.html);
    expect(controls.some((c) => c.kind === "button" && c.label === "Send invite")).toBe(true);
    expect(controls.some((c) => c.kind === "field" && c.label === "Email address")).toBe(true);
    expect(controls.some((c) => c.kind === "link" && c.label === "Settings")).toBe(true);
  });

  it("skips the link to the page it is already on", () => {
    const here = screenControls(team!.html).filter((c) => c.kind === "link");
    expect(here.map((c) => c.label)).not.toContain("Team");
  });
});

describe("screens as candidates", () => {
  const screens = renderScreensDeterministically({
    platform: "ios",
    files: [
      { path: "Sources/TeamView.swift", text: SWIFT },
      { path: "Sources/SettingsView.swift", text: SWIFT_SETTINGS },
    ],
  });

  it("offers one candidate per screen, entered at that screen's path", () => {
    const cases = screensToUseCases(screens);
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.entryRoute)).toEqual(["/", "/settings"]);
    expect(cases[0]!.signals).toEqual(["screen"]);
    expect(cases[0]!.origin).toBe("Sources/TeamView.swift");
  });

  it("outlines only controls that are on the page", () => {
    const [first] = screensToUseCases(screens);
    expect(first!.outline.join(" ")).toContain("Send invite");
  });

  it("walks the screen and moves on, without typing anything invented", () => {
    const steps = screenToSteps(screens[0]!);
    const flow = Flow.parse({
      schemaVersion: 1,
      useCaseId: "uc_1",
      title: { en: "Team", ja: "Team" },
      steps,
    });

    expect(flow.steps[0]).toMatchObject({ do: "goto", path: "/" });
    expect(flow.steps.some((s) => s.do === "click")).toBe(true);
    // Nothing is filled: the source says a field exists, not what to put in it.
    expect(flow.steps.some((s) => s.do === "fill")).toBe(false);
    expect(flow.steps.at(-1)).toMatchObject({ do: "click" });
  });
});

describe("the mock client on a native repository", () => {
  const screens: NativeScreen[] = renderScreensDeterministically({
    platform: "macos",
    files: [{ path: "Sources/TeamView.swift", text: SWIFT }],
  });

  const digest = (over: Partial<RepoDigest> = {}): RepoDigest => ({
    projectName: "app",
    description: null,
    framework: "unknown",
    readme: "",
    routes: [],
    specs: [],
    analyticsEvents: [],
    changelog: null,
    packageScripts: {},
    screens: [],
    approxTokens: 0,
    ...over,
  });

  it("proposes from the screens when there are any", async () => {
    const llm = createMockLlm();
    const cases = await llm.extractUseCases(digest({ screens }));
    expect(cases.map((c) => c.title.en)).toEqual(["Team"]);
  });

  it("still refuses to invent candidates when there is neither screen nor spec", async () => {
    const llm = createMockLlm();
    const cases = await llm.extractUseCases(
      digest({ routes: [{ path: "/pricing", file: "app/pricing/page.tsx", label: "pricing" }] }),
    );
    expect(cases).toEqual([]);
  });

  it("builds the flow from the screen the candidate entered on", async () => {
    const llm = createMockLlm();
    const [draft] = await llm.extractUseCases(digest({ screens }));
    const flow = await llm.generateFlow(digest({ screens }), { ...draft!, id: "uc_1" });
    expect(flow.steps[0]).toMatchObject({ do: "goto", path: "/" });
    expect(
      flow.steps.some(
        (s) => s.do === "click" && "role" in s.target && s.target.role?.name === "Send invite",
      ),
    ).toBe(true);
  });
});
