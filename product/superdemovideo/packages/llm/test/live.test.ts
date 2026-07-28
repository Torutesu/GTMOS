import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Flow, Step } from "@sdv/core";
import { priceUsage, ScriptDraft, UseCaseList } from "../src/index.ts";
import { FLOW_SCHEMA, SCRIPT_SCHEMA, USE_CASE_LIST_SCHEMA } from "../src/json-schema.ts";

const TEMPLATES = fileURLToPath(new URL("../../../templates/launch", import.meta.url));

/**
 * The live driver without the network.
 *
 * What can actually go wrong on the live path is not the HTTP call — the SDK
 * handles that — it is the seam either side of it: does a well-formed model
 * response survive parsing, does a malformed one get rejected rather than
 * reaching the pipeline, and is the token arithmetic right. Those are all
 * testable with a recorded payload and no key.
 */

const USE_CASE_RESPONSE = {
  useCases: [
    {
      title: { en: "Invite a team member", ja: "メンバーを招待する" },
      hypothesis: {
        en: "Show a visitor how to invite a team member without a walkthrough.",
        ja: "説明なしでメンバー招待の流れを見せる。",
      },
      entryRoute: "/settings/team",
      outline: ["Open the team page", "Enter an email", "Choose a role", "Send the invite"],
      signals: ["e2e-test", "route"],
      origin: "e2e/invite-team-member.spec.ts",
    },
  ],
};

const FLOW_RESPONSE = {
  title: { en: "Invite a team member", ja: "メンバーを招待する" },
  steps: [
    { do: "goto", path: "/settings/team", caption: { en: "Open your team", ja: "チームを開く" } },
    {
      do: "fill",
      target: { label: "Email" },
      value: "sam@example.com",
      caption: { en: "Add their email", ja: "メールアドレスを入力" },
    },
    {
      do: "click",
      target: { role: { role: "button", name: "Send invite" } },
      caption: { en: "Send it", ja: "送信する" },
    },
  ],
};

describe("parsing a model response", () => {
  it("accepts a well-formed list of use cases", () => {
    const parsed = UseCaseList.parse(USE_CASE_RESPONSE);
    expect(parsed.useCases).toHaveLength(1);
    expect(parsed.useCases[0]!.signals).toContain("e2e-test");
  });

  it("rejects a use case with no supporting signal", () => {
    const bad = {
      useCases: [{ ...USE_CASE_RESPONSE.useCases[0], signals: [] }],
    };
    expect(() => UseCaseList.parse(bad)).toThrow();
  });

  it("accepts a well-formed flow once the run's ids are attached", () => {
    const flow = Flow.parse({ ...FLOW_RESPONSE, schemaVersion: 1, useCaseId: "uc_1" });
    expect(flow.steps).toHaveLength(3);
    expect(flow.steps[0]!.do).toBe("goto");
  });

  it("rejects a flow that does not start by navigating somewhere", () => {
    const bad = {
      ...FLOW_RESPONSE,
      schemaVersion: 1,
      useCaseId: "uc_1",
      steps: FLOW_RESPONSE.steps.slice(1),
    };
    expect(() => Flow.parse(bad)).toThrow(/start with a goto/);
  });

  it("rejects a step whose target selects nothing", () => {
    expect(() => Step.parse({ do: "click", target: {} })).toThrow();
  });

  it("accepts a caption set in both languages", () => {
    const parsed = ScriptDraft.parse({
      title: { en: "Invite a team member", ja: "メンバーを招待する" },
      intro: { en: "Invite your team in one screen", ja: "1 画面でチームを招待" },
      outro: { en: "Try it free", ja: "無料で試す" },
      captions: [
        { en: "Open your team", ja: "チームを開く" },
        { en: "Send it", ja: "送信する" },
      ],
    });
    expect(parsed.captions).toHaveLength(2);
  });

  it("rejects a caption written in only one language", () => {
    expect(() =>
      ScriptDraft.parse({
        title: { en: "x", ja: "x" },
        intro: { en: "x", ja: "x" },
        outro: { en: "x", ja: "x" },
        captions: [{ en: "Send it" }],
      }),
    ).toThrow();
  });
});

describe("the schemas we send the model", () => {
  it("constrain the response to an object with the field we read", () => {
    for (const [name, schema, key] of [
      ["use cases", USE_CASE_LIST_SCHEMA, "useCases"],
      ["flow", FLOW_SCHEMA, "steps"],
      ["script", SCRIPT_SCHEMA, "captions"],
    ] as const) {
      expect(schema["type"], name).toBe("object");
      expect(Object.keys(schema["properties"] as object), name).toContain(key);
    }
  });
});

describe("cost accounting", () => {
  it("charges cached input at a fraction of fresh input", () => {
    const fresh = priceUsage("understand", { input_tokens: 100_000, output_tokens: 1000 });
    const cached = priceUsage("flowgen", {
      input_tokens: 0,
      output_tokens: 1000,
      cache_read_input_tokens: 100_000,
    });
    expect(cached.usd).toBeLessThan(fresh.usd);
    // The digest is the bulk of the prompt; reading it back must be an order
    // of magnitude cheaper or the caching is not worth its complexity.
    expect(fresh.usd / cached.usd).toBeGreaterThan(5);
  });

  it("treats missing cache counters as zero rather than NaN", () => {
    const usage = priceUsage("script", { input_tokens: 10, output_tokens: 10 });
    expect(Number.isFinite(usage.usd)).toBe(true);
    expect(usage.cacheReadTokens).toBe(0);
  });
});

describe("the prompts", () => {
  it("are files on disk, not strings in the code", async () => {
    for (const name of ["understand", "flowgen", "script", "repair"]) {
      const text = await readFile(join(TEMPLATES, "prompts", `${name}.md`), "utf8");
      expect(text.length, name).toBeGreaterThan(200);
    }
  });

  it("tell the writer that the opening seconds decide everything", async () => {
    const script = await readFile(join(TEMPLATES, "prompts", "script.md"), "utf8");
    expect(script).toMatch(/1\.7 seconds/);
    expect(script).toMatch(/single.{0,20}call to action|\*\*single\*\* call to action/i);
  });
});
