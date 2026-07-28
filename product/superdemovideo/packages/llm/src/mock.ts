import { Flow, type LlmUsage, type UseCase } from "@sdv/core";
import type { LlmClient, RepoDigest, ScriptDraft, SpecAction, SpecInfo, UseCaseDraft } from "./types.ts";

/**
 * A deterministic stand-in for the model.
 *
 * The signal an end-to-end suite carries is structural, not linguistic: a spec
 * is already an ordered list of user actions with stable selectors. That is
 * enough to derive candidates and a flow mechanically — no key, no network, no
 * variance between runs — which is what lets the acceptance suite assert on
 * exact output. It is a floor, not a replacement: repositories without tests
 * fall back to routes, and the phrasing is templated rather than written.
 */
export function createMockLlm(): LlmClient {
  return {
    mode: "mock",
    usage: (): LlmUsage[] => [],

    async extractUseCases(digest: RepoDigest): Promise<UseCaseDraft[]> {
      const fromSpecs = digest.specs
        .filter((s) => !s.isSetup && s.actions.length > 0)
        .map((spec) => specToUseCase(spec));

      const covered = new Set(fromSpecs.map((u) => u.entryRoute));
      const fromRoutes = digest.routes
        .filter((r) => !covered.has(r.path) && r.path !== "/login")
        .slice(0, Math.max(0, 5 - fromSpecs.length))
        .map((r) => routeToUseCase(r.path, r.label));

      const all = [...fromSpecs, ...fromRoutes];
      if (all.length === 0) {
        all.push(routeToUseCase("/", digest.projectName));
      }
      return all.slice(0, 7);
    },

    async generateFlow(digest: RepoDigest, useCase: UseCase): Promise<Flow> {
      const spec = digest.specs.find((s) => s.file === useCase.origin && !s.isSetup);
      const steps = spec ? specToSteps(spec) : routeSteps(useCase.entryRoute);
      return Flow.parse({
        schemaVersion: 1,
        useCaseId: useCase.id,
        title: useCase.title,
        steps,
      });
    },

    async writeScript(_digest, useCase, flow): Promise<ScriptDraft> {
      return {
        title: useCase.title,
        intro: useCase.hypothesis,
        outro: { en: "Try it yourself", ja: "実際に試す" },
        captions: flow.steps.map(
          (s) => s.caption ?? { en: describe(s), ja: describeJa(s) },
        ),
      };
    },

    async repairStep(): Promise<null> {
      // Repair is a judgement call about intent. The mock does not pretend to
      // make it — a broken step stays broken and shows up in the diff.
      return null;
    },
  };
}

/* ----------------------------- spec → use case --------------------------- */

function specToUseCase(spec: SpecInfo): UseCaseDraft {
  const goto = spec.actions.find((a) => a.kind === "goto");
  const entryRoute = goto?.value ?? "/";
  const title = titleCase(spec.title);
  return {
    title: { en: title, ja: title },
    hypothesis: {
      en: `Show a visitor how to ${lowerFirst(spec.title)} without a walkthrough.`,
      ja: `${title}までの流れを、説明なしで見せる。`,
    },
    entryRoute,
    outline: spec.actions.filter((a) => a.kind !== "goto").map((a) => describeAction(a)),
    signals: ["e2e-test"],
    origin: spec.file,
  };
}

function routeToUseCase(path: string, label: string | null): UseCaseDraft {
  const name = label ?? (path.replace(/^\//, "").replace(/[-/]/g, " ") || "the app");
  const title = titleCase(name);
  return {
    title: { en: title, ja: title },
    hypothesis: {
      en: `Give a visitor a first look at ${lowerFirst(title)}.`,
      ja: `${title}を最初のひと目で伝える。`,
    },
    entryRoute: path,
    outline: [`Open ${path}`],
    signals: ["route"],
    origin: null,
  };
}

/* ------------------------------ spec → steps ----------------------------- */

function specToSteps(spec: SpecInfo): unknown[] {
  const steps: unknown[] = [];
  const goto = spec.actions.find((a) => a.kind === "goto");
  steps.push({ do: "goto", path: goto?.value ?? "/", caption: caption(`Open ${goto?.value ?? "/"}`) });

  for (const a of spec.actions) {
    if (a.kind === "goto") continue;
    const target = toTarget(a);
    if (!target) continue;
    switch (a.kind) {
      case "click":
        steps.push({ do: "click", target, caption: caption(describeAction(a)) });
        break;
      case "fill":
        steps.push({ do: "fill", target, value: a.value ?? "", caption: caption(describeAction(a)) });
        break;
      case "select":
        steps.push({ do: "select", target, value: a.value ?? "", caption: caption(describeAction(a)) });
        break;
      case "hover":
        steps.push({ do: "hover", target, caption: caption(describeAction(a)) });
        break;
      case "expect":
        steps.push({ do: "expect", target, caption: caption(describeAction(a)) });
        break;
      case "press":
        steps.push({ do: "press", key: a.value ?? "Enter", caption: caption(describeAction(a)) });
        break;
    }
  }

  if (steps.length < 2) steps.push({ do: "wait", ms: 500, caption: caption("Take it in") });
  return steps.slice(0, 30);
}

function routeSteps(path: string): unknown[] {
  return [
    { do: "goto", path, caption: caption(`Open ${path}`) },
    { do: "wait", ms: 800, caption: caption("Take it in") },
  ];
}

function toTarget(a: SpecAction): Record<string, unknown> | null {
  if (a.role && a.name) return { role: { role: a.role, name: a.name } };
  if (a.locator === "getByLabel" && a.name) return { label: a.name };
  if (a.locator === "getByTestId" && a.name) return { testId: a.name };
  if (a.locator === "getByPlaceholder" && a.name) return { label: a.name };
  if (a.name) return { text: a.name };
  return null;
}

/* -------------------------------- phrasing ------------------------------- */

function caption(en: string) {
  return { en, ja: toJa(en) };
}

function describeAction(a: SpecAction): string {
  switch (a.kind) {
    case "goto":
      return `Open ${a.value ?? "/"}`;
    case "click":
      return `Click ${quoted(a.name)}`;
    case "fill":
      return `Enter ${quoted(a.value)} in ${quoted(a.name)}`;
    case "select":
      return `Choose ${quoted(a.value)}`;
    case "hover":
      return `Hover ${quoted(a.name)}`;
    case "press":
      return `Press ${a.value ?? "Enter"}`;
    case "expect":
      return `See ${quoted(a.name)}`;
  }
}

function describe(step: { do: string }): string {
  return titleCase(step.do);
}

function describeJa(step: { do: string }): string {
  const map: Record<string, string> = {
    goto: "画面を開く",
    click: "クリックする",
    fill: "入力する",
    select: "選択する",
    press: "キーを押す",
    hover: "カーソルを合わせる",
    expect: "結果を確認する",
    wait: "少し待つ",
  };
  return map[step.do] ?? step.do;
}

function toJa(en: string): string {
  if (en.startsWith("Open ")) return `${en.slice(5)} を開く`;
  if (en.startsWith("Click ")) return `${en.slice(6)} をクリック`;
  if (en.startsWith("Enter ")) return `${en.slice(6)} を入力`;
  if (en.startsWith("Choose ")) return `${en.slice(7)} を選択`;
  if (en.startsWith("See ")) return `${en.slice(4)} を確認`;
  if (en.startsWith("Hover ")) return `${en.slice(6)} にカーソル`;
  if (en.startsWith("Press ")) return `${en.slice(6)} キーを押す`;
  return en;
}

function quoted(s: string | null): string {
  return s ? `“${s}”` : "the field";
}

function titleCase(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
