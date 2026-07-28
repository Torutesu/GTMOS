import type { NativeScreen, RenderScreensInput, UseCaseDraft } from "./types.ts";

/**
 * Render native screens without a model.
 *
 * A declared interface is more parseable than it looks. SwiftUI and Compose
 * both spell their content out — `Text("Team")`, `Button("Send invite")`,
 * `TextField("Email address", …)` — and Android XML puts it in attributes.
 * Pulling those strings out in order gives a page with the app's real words in
 * the app's real order, which is enough to drive a flow and to assert on.
 *
 * It is a floor, not a replacement. The live path gets layout, grouping and
 * proportion right; this gets the content right and stacks it. Acceptance can
 * depend on it because it never varies and never calls anything.
 */
export function renderScreensDeterministically(input: RenderScreensInput): NativeScreen[] {
  const found: Array<{ path: string; title: string; source: string; controls: Control[] }> = [];

  for (const file of input.files) {
    const controls = extractControls(file.text, input.platform);
    if (controls.length === 0) continue;

    const name = screenName(file.path);
    const path = found.length === 0 ? "/" : `/${slugify(name)}`;
    if (found.some((s) => s.path === path)) continue;
    found.push({ path, title: name, source: file.path, controls });
    if (found.length >= 8) break;
  }

  // Every page carries links to the others, so a demo can move between screens
  // the way a person moves between tabs. Without them each screen would be an
  // island and a flow could never leave the one it opened on.
  const nav = found.map((s) => ({ path: s.path, title: s.title }));

  return found.map((s) => ({
    path: s.path,
    title: s.title,
    source: s.source,
    html: page(s.title, s.controls, input.platform, nav, s.path),
  }));
}

interface Control {
  kind: "heading" | "text" | "button" | "field" | "toggle";
  label: string;
}

/** An argument list that may contain a braced expression, one level deep. */
const ARGS = "(?:[^{}()]|\\{[^{}]*\\}|\\([^()]*\\))*";

/** `Text("Save")` and Compose's `Text(text = "Save")`. */
const TEXT_ARG = '(?:text\\s*=\\s*)?"([^"]{2,80})"';

/**
 * Pull the labelled controls out of a declared interface, in source order.
 *
 * Order matters more than completeness: a demo walks a screen top to bottom,
 * and a list of controls in the order they were written is a usable
 * approximation of that. Anything unlabelled is skipped — it has nothing to
 * show a viewer.
 */
export function extractControls(source: string, platform: RenderScreensInput["platform"]): Control[] {
  const out: Control[] = [];
  const seen = new Set<string>();

  // Controls before prose. A label reached by two patterns is claimed by the
  // first, and a button written as `Button(…) { Text("Save") }` would otherwise
  // be read as the paragraph "Save" — clickable in the source, unclickable on
  // the page.
  //
  // ARGS matches an argument list that contains a trailing closure or any other
  // braced expression, because `Button(onClick = { open() })` is the ordinary
  // way to write one and `[^)]*` stops at the first paren inside it.
  const patterns: Array<[RegExp, Control["kind"]]> =
    platform === "android"
      ? [
          [new RegExp(`\\bButton\\s*\\(${ARGS}\\)\\s*\\{\\s*Text\\s*\\(\\s*${TEXT_ARG}`, "g"), "button"],
          [
            new RegExp(`\\bOutlinedTextField\\s*\\(${ARGS}label\\s*=\\s*\\{\\s*Text\\s*\\(\\s*"([^"]{2,80})"`, "g"),
            "field",
          ],
          [new RegExp(`\\bSwitch\\s*\\(${ARGS}contentDescription\\s*=\\s*"([^"]{2,80})"`, "g"), "toggle"],
          [/android:hint\s*=\s*"([^"@]{2,80})"/g, "field"],
          [new RegExp(`\\bText\\s*\\(\\s*${TEXT_ARG}`, "g"), "text"],
          [/android:text\s*=\s*"([^"@]{2,80})"/g, "text"],
        ]
      : [
          [/\bnavigationTitle\s*\(\s*"([^"]{2,80})"/g, "heading"],
          [/\bButton\s*\(\s*"([^"]{2,80})"/g, "button"],
          [new RegExp(`\\bButton\\s*\\(${ARGS}\\)\\s*\\{\\s*Text\\s*\\(\\s*"([^"]{2,80})"`, "g"), "button"],
          [/\bTextField\s*\(\s*"([^"]{2,80})"/g, "field"],
          [/\bSecureField\s*\(\s*"([^"]{2,80})"/g, "field"],
          [/\bToggle\s*\(\s*"([^"]{2,80})"/g, "toggle"],
          [/\bText\s*\(\s*"([^"]{2,80})"/g, "text"],
          [/\bLabel\s*\(\s*"([^"]{2,80})"/g, "text"],
        ];

  // Collected by position so the page reads in the order the source declares.
  const hits: Array<{ index: number; control: Control }> = [];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const label = match[1]!.trim();
      if (!label || /^\s*$/.test(label)) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      hits.push({ index: match.index ?? 0, control: { kind, label } });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  for (const hit of hits) out.push(hit.control);
  return out;
}

const FRAME: Record<RenderScreensInput["platform"], { width: number; label: string }> = {
  ios: { width: 390, label: "iPhone" },
  android: { width: 412, label: "Android" },
  macos: { width: 960, label: "macOS" },
};

/**
 * The page a screen becomes.
 *
 * Semantic elements on purpose: capture resolves targets by role and label, so
 * a button rendered as a `<button>` is one the flow can actually click. A
 * `<div>` that merely looks like a button would film once and never replay.
 */
function page(
  title: string,
  controls: Control[],
  platform: RenderScreensInput["platform"],
  nav: Array<{ path: string; title: string }>,
  current: string,
): string {
  const frame = FRAME[platform];

  // Source order everywhere except the title. SwiftUI writes `.navigationTitle`
  // as a modifier after the body, and Compose often sets the top bar last, so
  // taking the order literally puts the screen's own name underneath its
  // content — where nobody looks for it, and where the first frame of the video
  // does not show it.
  const ordered = [
    ...controls.filter((c) => c.kind === "heading"),
    ...controls.filter((c) => c.kind !== "heading"),
  ];

  const body = ordered
    .map((c) => {
      const text = escapeHtml(c.label);
      switch (c.kind) {
        case "heading":
          return `      <h1>${text}</h1>`;
        case "button":
          return `      <button type="button">${text}</button>`;
        case "field":
          return `      <label>${text}<input type="text" placeholder="${text}" /></label>`;
        case "toggle":
          return `      <label class="row"><input type="checkbox" /> ${text}</label>`;
        default:
          return `      <p>${text}</p>`;
      }
    })
    .join("\n");

  const links =
    nav.length < 2
      ? ""
      : `    <nav aria-label="Screens">\n` +
        nav
          .map((n) => {
            // The path a screen claims, not the file it was written to: the
            // static server resolves /settings to settings.html and redirects
            // the other way round, so linking to the file would cost a hop.
            const here = n.path === current ? ' aria-current="page"' : "";
            return `      <a href="${n.path}"${here}>${escapeHtml(n.title)}</a>`;
          })
          .join("\n") +
        `\n    </nav>\n`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark }
  /* Centred in the viewport: the capture is 1440×900 whatever the device is,
     and a phone-width column pinned to the top leaves most of the frame empty. */
  body { margin:0; min-height:100vh; background:#0a0c10; color:#f2f5f7;
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,sans-serif;
    display:flex; align-items:center; justify-content:center; padding:32px 16px;
    box-sizing:border-box }
  main { width:100%; background:#12161c; border:1px solid #232a34;
    border-radius:${platform === "macos" ? 12 : 28}px; padding:24px 20px 28px; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-.01em }
  p { color:#aeb8c4; margin:0 0 10px }
  label { display:block; margin:14px 0 0; font-size:13px; color:#8c97a5 }
  label.row { display:flex; align-items:center; gap:8px; color:#e8edf3; font-size:15px }
  input[type=text] { display:block; width:100%; margin-top:6px; padding:10px 12px;
    background:#0d1218; border:1px solid #2a323d; border-radius:9px; color:#f2f5f7; font:inherit }
  button { margin-top:18px; padding:11px 18px; border:0; border-radius:9px;
    background:#5b8cff; color:#06101f; font:inherit; font-weight:650; cursor:pointer }
  .frame { width:100%; max-width:${frame.width}px }
  nav { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 14px }
  nav a { padding:6px 11px; border-radius:99px; border:1px solid #232a34; color:#aeb8c4;
    text-decoration:none; font-size:13px }
  nav a[aria-current="page"] { background:#1c2431; color:#f2f5f7; border-color:#334054 }
</style>
</head>
<body>
  <div class="frame">
${links}  <main>
${body}
  </main>
  </div>
</body>
</html>
`;
}

function screenName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.(swift|kt|java|xml|m|mm)$/i, "")
    .replace(/(View|Screen|Activity|Fragment|Controller)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .trim() || "Home";
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "screen";
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* ------------------ rendered screens → candidates and flows --------------- */

/**
 * What a rendered screen offers a viewer.
 *
 * Read back out of the HTML rather than carried alongside it, because the two
 * paths produce that HTML differently — one from a template here, one from the
 * model — and the flow has to be built from what will actually be on the page.
 * Anything that is not a real element with a real accessible name is not here,
 * which is the same rule capture applies when it resolves a target.
 */
export interface ScreenControl {
  kind: "heading" | "button" | "link" | "field";
  label: string;
  /** Where a link goes. */
  href: string | null;
}

export function screenControls(html: string): ScreenControl[] {
  const hits: Array<{ index: number; control: ScreenControl }> = [];
  const add = (index: number, kind: ScreenControl["kind"], label: string, href: string | null) => {
    const clean = decode(stripTags(label)).replace(/\s+/g, " ").trim();
    if (clean.length < 1 || clean.length > 80) return;
    hits.push({ index, control: { kind, label: clean, href } });
  };

  for (const m of html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    add(m.index ?? 0, "heading", m[1]!, null);
  }
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) {
    add(m.index ?? 0, "button", m[1]!, null);
  }
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1]!;
    if (/aria-current\s*=\s*["']page["']/i.test(attrs)) continue;
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? null;
    if (!href || href.startsWith("#")) continue;
    add(m.index ?? 0, "link", m[2]!, href);
  }
  // A field is named by the label that wraps it, the label that points at it,
  // or its own aria-label — in that order, because that is the order a browser
  // computes the accessible name in.
  for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<input\b[^>]*>/gi)) {
    add(m.index ?? 0, "field", m[1]!, null);
  }
  for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
    const label =
      /aria-label\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1] ??
      /placeholder\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1];
    if (label) add(m.index ?? 0, "field", label, null);
  }

  hits.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const out: ScreenControl[] = [];
  for (const { control } of hits) {
    const key = `${control.kind}:${control.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(control);
  }
  return out;
}

/**
 * One candidate per screen.
 *
 * For a web app the candidates come from its end-to-end tests, because nothing
 * else says which journeys matter. A native app has no such suite and does not
 * need one here: we rendered these screens, so the screens are the journeys,
 * and every control named in a candidate is one we know is on the page.
 */
export function screensToUseCases(screens: NativeScreen[]): UseCaseDraft[] {
  return screens.slice(0, 7).map((screen) => {
    const controls = screenControls(screen.html);
    const outline = controls
      .filter((c) => c.kind !== "heading")
      .slice(0, 6)
      .map((c) => describeControl(c));
    return {
      title: { en: screen.title, ja: screen.title },
      hypothesis: {
        en: `Show what the ${screen.title} screen offers, without a walkthrough.`,
        ja: `${screen.title} 画面でできることを、説明なしで見せる。`,
      },
      entryRoute: screen.path,
      outline: outline.length > 0 ? outline : [`Open the ${screen.title} screen`],
      signals: ["screen" as const],
      origin: screen.source,
    };
  });
}

/**
 * The walk through one screen.
 *
 * Buttons and links are pressed; fields are shown but never typed into. The
 * source declares that a field exists and what it is called, and it does not
 * say what a person would put in it — so filling one would mean inventing
 * content and presenting it as the app's. The live path reads the source and
 * can do better; this stays with what it knows.
 */
export function screenToSteps(screen: NativeScreen): unknown[] {
  const controls = screenControls(screen.html);
  const steps: unknown[] = [
    { do: "goto", path: screen.path, caption: text(`Open ${screen.title}`, `${screen.title} を開く`) },
  ];

  const heading = controls.find((c) => c.kind === "heading");
  if (heading) {
    steps.push({
      do: "expect",
      target: { role: { role: "heading", name: heading.label } },
      caption: text(`This is ${heading.label}`, `${heading.label} の画面`),
    });
  }

  for (const control of controls) {
    if (steps.length >= 9) break;
    if (control.kind === "button") {
      steps.push({
        do: "click",
        target: { role: { role: "button", name: control.label } },
        caption: text(`Press “${control.label}”`, `「${control.label}」を押す`),
      });
    } else if (control.kind === "field") {
      steps.push({
        do: "hover",
        target: { label: control.label },
        caption: text(`“${control.label}” goes here`, `「${control.label}」はここ`),
      });
    }
  }

  // End on a move to another screen when there is one, so the demo shows the
  // app rather than a single page of it.
  const link = controls.find((c) => c.kind === "link");
  if (link && steps.length < 10) {
    steps.push({
      do: "click",
      target: { role: { role: "link", name: link.label } },
      caption: text(`On to ${link.label}`, `${link.label} へ`),
    });
  }

  if (steps.length < 2) {
    steps.push({ do: "wait", ms: 800, caption: text("Take it in", "少し眺める") });
  }
  return steps;
}

function describeControl(c: ScreenControl): string {
  switch (c.kind) {
    case "button":
      return `Press “${c.label}”`;
    case "link":
      return `Go to ${c.label}`;
    case "field":
      return `The “${c.label}” field`;
    default:
      return c.label;
  }
}

function text(en: string, ja: string) {
  return { en, ja };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
