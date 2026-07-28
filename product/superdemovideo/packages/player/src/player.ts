/**
 * Superdemovideo interactive demo player.
 *
 * Replays the DOM snapshots taken during capture and lets a visitor click
 * through the same journey the video shows. It ships with no dependencies and
 * no network calls: everything it needs travels in the bundle, so a demo keeps
 * working after the app it was recorded from is redeployed or retired.
 */

interface Localized {
  en: string;
  ja: string;
}

interface DemoStep {
  index: number;
  caption: Localized | null;
  hotspot: { x: number; y: number; w: number; h: number } | null;
  screenshot: string;
  dom: string | null;
}

interface DemoManifest {
  schemaVersion: 1;
  title: Localized;
  fidelity: "L2";
  seededData: boolean;
  cta: { label: string; url: string } | null;
  steps: DemoStep[];
  /** Viewport the capture was taken at; hotspots are in these coordinates. */
  viewport: { width: number; height: number };
  assets?: Record<string, string>;
}

interface DomSnapshot {
  html: string;
  styles: string[];
  title: string;
  url: string;
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
}

type Lang = "en" | "ja";

const STYLE = `
.sdv{position:relative;width:100%;background:#0a0c10;color:#f2f5f7;border-radius:12px;overflow:hidden;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.sdv *{box-sizing:border-box}
.sdv-stage{position:relative;width:100%;overflow:hidden;background:#0a0c10}
.sdv-scale{position:absolute;top:0;left:0;transform-origin:0 0}
.sdv-frame{border:0;background:#fff;display:block}
.sdv-shot{display:block;width:100%;height:auto}
.sdv-hot{position:absolute;border-radius:8px;box-shadow:0 0 0 3px #5b8cff,0 0 0 9999px rgba(6,8,12,.5);
  cursor:pointer;animation:sdv-pulse 1.9s ease-in-out infinite;background:transparent}
.sdv-hot:focus-visible{outline:3px solid #fff;outline-offset:3px}
@keyframes sdv-pulse{0%,100%{box-shadow:0 0 0 3px #5b8cff,0 0 0 9999px rgba(6,8,12,.5)}
  50%{box-shadow:0 0 0 6px rgba(91,140,255,.75),0 0 0 9999px rgba(6,8,12,.5)}}
.sdv-cap{position:absolute;left:50%;transform:translateX(-50%);bottom:64px;max-width:min(78%,560px);
  background:rgba(10,12,16,.88);border-left:3px solid #5b8cff;padding:10px 16px;border-radius:9px;
  font-weight:600;font-size:15px;backdrop-filter:blur(6px)}
.sdv-bar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#111620;
  border-top:1px solid #212836}
.sdv-dots{display:flex;gap:6px;flex:1}
.sdv-dot{width:22px;height:4px;border-radius:2px;background:#2a3242;border:0;padding:0;cursor:pointer}
.sdv-dot[aria-current="true"]{background:#5b8cff}
.sdv-btn{background:#5b8cff;color:#08101f;border:0;border-radius:7px;padding:7px 14px;
  font-weight:600;cursor:pointer;font-size:13px}
.sdv-btn[disabled]{opacity:.4;cursor:default}
.sdv-btn.ghost{background:transparent;color:#98a2ad;border:1px solid #2a3242}
.sdv-meta{font-size:11px;color:#6f7a89}
.sdv-cta{position:absolute;inset:0;display:grid;place-items:center;background:rgba(8,10,14,.86);
  backdrop-filter:blur(3px);text-align:center;padding:24px}
.sdv-cta h3{margin:0 0 14px;font-size:19px}
.sdv-foot{display:block;text-align:center;padding:6px;font-size:11px;color:#5c6675;text-decoration:none}
@media (prefers-reduced-motion:reduce){.sdv-hot{animation:none}}
`;

class Player {
  private root: HTMLElement;
  private manifest: DemoManifest;
  private baseUrl: string;
  private lang: Lang;
  private index = 0;
  private stage!: HTMLElement;
  private scaler!: HTMLElement;
  private captionEl!: HTMLElement;
  private dots: HTMLButtonElement[] = [];
  private nextBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private ctaEl: HTMLElement | null = null;
  private domCache = new Map<number, DomSnapshot>();

  constructor(root: HTMLElement, manifest: DemoManifest, baseUrl: string) {
    this.root = root;
    this.manifest = manifest;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.lang = (root.getAttribute("data-lang") as Lang) === "ja" ? "ja" : "en";
    this.build();
    void this.show(0);
  }

  private build(): void {
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.appendChild(style);

    const wrap = el("div", "sdv");
    this.stage = el("div", "sdv-stage");
    this.scaler = el("div", "sdv-scale");
    this.stage.appendChild(this.scaler);
    this.captionEl = el("div", "sdv-cap");
    this.captionEl.style.display = "none";
    this.stage.appendChild(this.captionEl);
    wrap.appendChild(this.stage);

    const bar = el("div", "sdv-bar");
    this.prevBtn = button("Back", "sdv-btn ghost", () => void this.show(this.index - 1));
    bar.appendChild(this.prevBtn);

    const dots = el("div", "sdv-dots");
    this.manifest.steps.forEach((_, i) => {
      const d = document.createElement("button");
      d.className = "sdv-dot";
      d.type = "button";
      d.setAttribute("aria-label", `Step ${i + 1}`);
      d.onclick = () => void this.show(i);
      this.dots.push(d);
      dots.appendChild(d);
    });
    bar.appendChild(dots);

    const meta = el("span", "sdv-meta");
    meta.textContent = this.manifest.seededData ? "Sample data" : "";
    bar.appendChild(meta);

    this.nextBtn = button("Next", "sdv-btn", () => void this.show(this.index + 1));
    bar.appendChild(this.nextBtn);
    wrap.appendChild(bar);

    const foot = document.createElement("a");
    foot.className = "sdv-foot";
    foot.href = "https://superdemovideo.com";
    foot.target = "_blank";
    foot.rel = "noopener";
    foot.textContent = "Made with Superdemovideo";
    wrap.appendChild(foot);

    this.root.appendChild(wrap);

    this.root.tabIndex = 0;
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        void this.show(this.index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        void this.show(this.index - 1);
      }
    });

    window.addEventListener("resize", () => this.fit());
  }

  private async show(index: number): Promise<void> {
    const steps = this.manifest.steps;
    if (index < 0 || index >= steps.length) return;
    this.index = index;
    const step = steps[index]!;

    this.scaler.textContent = "";
    const snapshot = step.dom ? await this.loadDom(index, step.dom) : null;

    if (snapshot) {
      this.scaler.appendChild(this.renderSnapshot(snapshot, step));
    } else {
      const img = document.createElement("img");
      img.className = "sdv-shot";
      img.src = `${this.baseUrl}/${step.screenshot}`;
      img.alt = step.caption ? step.caption[this.lang] : `Step ${index + 1}`;
      this.scaler.appendChild(img);
    }

    if (step.caption) {
      this.captionEl.textContent = step.caption[this.lang];
      this.captionEl.style.display = "";
    } else {
      this.captionEl.style.display = "none";
    }

    this.dots.forEach((d, i) => d.setAttribute("aria-current", String(i === index)));
    this.prevBtn.disabled = index === 0;
    this.nextBtn.disabled = index === steps.length - 1;
    this.ctaEl?.remove();
    this.ctaEl = null;
    if (index === steps.length - 1 && this.manifest.cta) this.showCta();

    this.fit();
  }

  /**
   * Rebuild one captured screen.
   *
   * The snapshot goes into a sandboxed iframe: replayed markup is the
   * customer's, not ours, and it must not be able to reach this page's
   * storage, cookies or scripts. Everything visual survives; nothing runs.
   */
  private renderSnapshot(snap: DomSnapshot, step: DemoStep): HTMLElement {
    const holder = document.createElement("div");
    holder.style.position = "relative";
    holder.style.width = `${this.manifest.viewport.width}px`;
    holder.style.height = `${this.manifest.viewport.height}px`;

    const frame = document.createElement("iframe");
    frame.className = "sdv-frame";
    frame.width = String(this.manifest.viewport.width);
    frame.height = String(this.manifest.viewport.height);
    frame.setAttribute("sandbox", "");
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("title", snap.title || "Demo");
    frame.srcdoc = this.documentFor(snap);
    holder.appendChild(frame);

    if (step.hotspot) {
      const hot = document.createElement("button");
      hot.type = "button";
      hot.className = "sdv-hot";
      hot.style.left = `${step.hotspot.x}px`;
      hot.style.top = `${step.hotspot.y - snap.scroll.y}px`;
      hot.style.width = `${step.hotspot.w}px`;
      hot.style.height = `${step.hotspot.h}px`;
      hot.setAttribute(
        "aria-label",
        step.caption ? step.caption[this.lang] : "Continue the demo",
      );
      hot.onclick = () => void this.show(this.index + 1);
      holder.appendChild(hot);
    }
    return holder;
  }

  private documentFor(snap: DomSnapshot): string {
    const assets = this.manifest.assets ?? {};
    let html = snap.html;
    // Rewrite recorded URLs to the copies that travel with the bundle.
    for (const [original, local] of Object.entries(assets)) {
      html = html.split(original).join(`${this.baseUrl}/${local}`);
    }
    const styles = snap.styles.join("\n");
    return `<!doctype html><html><head><meta charset="utf-8">
<base target="_blank">
<style>${styles}</style>
<style>html,body{margin:0;overflow:hidden}*{animation:none!important;transition:none!important}
::-webkit-scrollbar{display:none}</style>
</head>${stripHtmlTag(html)}</html>`;
  }

  private async loadDom(index: number, path: string): Promise<DomSnapshot | null> {
    const cached = this.domCache.get(index);
    if (cached) return cached;
    try {
      const res = await fetch(`${this.baseUrl}/${path}`);
      if (!res.ok) return null;
      const snap = (await res.json()) as DomSnapshot;
      this.domCache.set(index, snap);
      return snap;
    } catch {
      return null;
    }
  }

  private showCta(): void {
    const cta = this.manifest.cta!;
    const overlay = el("div", "sdv-cta");
    const inner = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = this.manifest.title[this.lang];
    const a = document.createElement("a");
    a.className = "sdv-btn";
    a.href = cta.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = cta.label;
    a.style.textDecoration = "none";
    const again = button("Replay", "sdv-btn ghost", () => void this.show(0));
    again.style.marginLeft = "8px";
    inner.append(h, a, again);
    overlay.appendChild(inner);
    this.stage.appendChild(overlay);
    this.ctaEl = overlay;
  }

  /** Scale the captured viewport down to whatever width the embed has. */
  private fit(): void {
    const available = this.stage.clientWidth || this.root.clientWidth || 960;
    const scale = available / this.manifest.viewport.width;
    this.scaler.style.transform = `scale(${scale})`;
    this.scaler.style.width = `${this.manifest.viewport.width}px`;
    this.stage.style.height = `${Math.round(this.manifest.viewport.height * scale)}px`;
  }
}

/* -------------------------------- helpers -------------------------------- */

function el(tag: string, className: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = className;
  return n;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function stripHtmlTag(html: string): string {
  const m = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html);
  const body = m ? m[1]! : html;
  return /<body/i.test(body) ? body : `<body>${body}</body>`;
}

/* --------------------------------- boot ---------------------------------- */

async function mount(root: HTMLElement): Promise<void> {
  const src = root.getAttribute("data-demo");
  if (!src) return;
  const baseUrl = src.replace(/\/[^/]*$/, "");
  const res = await fetch(src);
  const manifest = (await res.json()) as DemoManifest;
  new Player(root, manifest, baseUrl);
}

function boot(): void {
  document.querySelectorAll<HTMLElement>("[data-demo]").forEach((n) => {
    if (n.getAttribute("data-sdv-mounted")) return;
    n.setAttribute("data-sdv-mounted", "1");
    void mount(n);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

(window as unknown as { SuperdemoPlayer: unknown }).SuperdemoPlayer = { boot, mount };
