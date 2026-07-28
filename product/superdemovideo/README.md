# Superdemovideo — M1

Point it at a repository. It works out how the app builds, films a real
browser driving a real build of it, and produces a launch video and a
clickable demo. When the code changes, it re-films and tells you exactly which
steps moved.

The product is not "a video". It is a video that is **still true**, which is
the part nobody maintains by hand.

## What it can point at

Every demo is filmed as HTML in a browser, whatever the app is. The platform
decides one thing only: where that HTML comes from.

| Platform | Where the HTML comes from | End-to-end tests |
| --- | --- | --- |
| Web | The app serves its own | **Required** |
| Electron | The renderer is HTML already. The preload's `contextBridge` calls are read and a stand-in `window.api` is injected, so the page runs without a main process | Not needed |
| macOS, iOS | Rendered from the source that declares the screens — SwiftUI, UIKit | Not needed |
| Android | Rendered from Jetpack Compose or Android XML | Not needed |

Only a web app is asked for specs, because the reason for the requirement only
fits one: we can neither know which journeys matter nor trust a selector we
guessed at, and a spec answers both.

A native app answers both differently — we render its screens ourselves, so the
markup and the labels are ours and the screens are the journeys. An Electron app
answers both by being run: its renderer is the app's real HTML, so the controls
are read off the live page rather than guessed. What no spec would have given us
there is the way *between* screens. In a desktop app that is the main process
telling the renderer to move, and a suite driving the real app would go through
a main process we do not have — so the demo delivers those events itself, from
the app's own declared defaults and committed fixtures.

What that costs: a rendered screen is **a rendition of what the source says**,
not a screenshot of a running build. A control that only appears at runtime
will not be there. In exchange, no Xcode, no Gradle, no simulator and no
device — and the rest of the pipeline does not change at all.

## Requirements

- Node 22+
- pnpm 10+
- A Chromium already on the machine. **Nothing here ever downloads a browser.**
  Set `PLAYWRIGHT_BROWSERS_PATH` (or `SDV_CHROMIUM_PATH`) if it is somewhere
  unusual.

ffmpeg and Postgres are *not* prerequisites: ffmpeg ships as a static binary
and the database is embedded (PGlite) unless you point `DATABASE_URL`
somewhere.

```bash
pnpm install
pnpm build:player      # the embeddable demo player
pnpm doctor            # confirms the machine has everything
```

`pnpm doctor` is the only reliable way to find out whether this will work
here. Run it first.

## Try it

```bash
pnpm api                                  # API + worker + web UI on :3000
pnpm sdv init ./fixtures/demo-app         # register the golden fixture, start a run
pnpm sdv status <runId> --follow          # watch the stages
pnpm sdv select <runId> 2                 # pick a candidate demo
pnpm sdv publish <runId>                  # make it the live one
pnpm sdv open <slug>                      # the public URL and the README badge
```

Or open <http://127.0.0.1:3000> and do the same thing with buttons.

## How a run works

```
analyse    ingest → detect → understand            seconds, reads source only
           ↓
           a human picks one of the candidates
           ↓
produce    flowgen → build → seed → capture → compose → emit
           ↓
publish    swap the published directory, atomically
```

The split is deliberate. Analysis is cheap and ends with a question only a
person can answer; production is expensive and runs without interruption.
Holding a preview server alive across an open-ended wait for someone to choose
would leak a process every time nobody came back.

**Regeneration** re-runs ingest and the build but reuses the stored flow — it
answers "does the demo we already agreed on still hold?", and re-deciding the
story would make the diff meaningless. Publishing is always manual: an
automatic republish of a demo whose steps just broke would be worse than a
stale one.

## What comes out

| Artifact | What it is |
| --- | --- |
| `video_169.mp4` | 1920×1080, browser-framed. The landing-page hero. |
| `video_916.mp4` | 1080×1920, cropped to whatever each step is about. |
| `video_11.mp4` | 1080×1080. Holds its size in a mobile timeline. |
| `poster.png` | The first frame that shows the product — never a title card. |
| `captions.en.srt`, `captions.ja.srt` | Sidecar subtitles. English is also burned in. |
| `demo/` | `index.html` + `demo.json` + a 3KB player. Clickable, self-contained. |
| `sdv export <run>` | The same demo folded into **one HTML file**. Opens from a download or an attachment; makes no network requests at all. |

The video and the interactive demo come from **one** capture pass — pixels,
DOM and target boxes recorded together — so they agree by construction rather
than by discipline.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm doctor` | Check node, pnpm, ffmpeg, sharp, Chromium, disk, PGlite |
| `pnpm api` | API + in-process worker + the web UI (`--no-worker` to split) |
| `pnpm sdv <cmd>` | The CLI. `sdv help` lists it. |
| `pnpm test` | Unit + integration (vitest) |
| `pnpm typecheck` | `tsc --noEmit` across every package |
| `pnpm accept` | The whole thing, end to end, mock mode, one command |
| `pnpm build:player` | Bundle the demo player (fails over 50KB gzipped) |
| `pnpm build:web` | Build the SPA the API serves |

`pnpm accept` is the definition of "M1 works": it drives the product over HTTP
against the golden fixture, then asserts on the files that come out — codec,
dimensions, frame rate, duration, caption cues, player size, and a real
Chromium clicking through the emitted demo to its last step. Its last step does
the same against a SwiftUI project, which has no package.json, no dev server
and no test suite. It needs no network and no API key.

## Configuration

Everything is optional; see `.env.example`. The ones that matter:

| Variable | Default | Why you would change it |
| --- | --- | --- |
| `SDV_LLM_MODE` | `mock` | `live` uses Anthropic and needs `ANTHROPIC_API_KEY` |
| `SDV_VAR_DIR` | `./var` | Everything written at runtime lives here and nowhere else |
| `SDV_TOKEN` | unset | Unset means no authentication — fine locally, not otherwise |
| `DATABASE_URL` | unset | Unset means embedded PGlite. Set it for a real cluster. |
| `SDV_PORT` | `3000` | |

**Never put a real secret in a project's environment.** Build fills every
required key with an obvious placeholder, and the UI has no field that accepts
one. A demo is a public artifact; a captured secret is a published secret.

## Layout

```
packages/core       schemas, error taxonomy, config — the contracts
packages/db         SQL, migrations, job queue
packages/llm        one client, a mock driver and a live one
packages/pipeline   every stage, plus the runner that orders them
packages/player     the embeddable demo player (independent build)
packages/api        Fastify, SSE, the worker
packages/cli        `sdv`
apps/web            the SPA
fixtures/demo-app   Taskloop — the golden fixture, deliberately outside the workspace
fixtures/native-app the same app as SwiftUI: no package.json, no server, no specs
templates/launch    skeleton, theme, prompts
scripts             doctor, accept
```

The Flow DSL is **data, never code**. It is generated as JSON and interpreted
by the capture executor; nothing in it is ever evaluated.

## Known limits (M1)

- **The local sandbox does not contain a hostile repository.** Install and
  build scripts run as your user in a scratch copy with a scrubbed
  environment and a hard timeout. That is isolation by construction, not by
  kernel. The docker driver is the answer for arbitrary repositories and it is
  not implemented here.
- Storage is the filesystem. The S3 driver throws.
- Regeneration records a broken step rather than repairing it in mock mode;
  repair is a live-model path.
- Japanese captions ship as SRT only. Burning CJK glyphs into the frame
  depends on fonts we cannot assume are installed, and a missing glyph is a
  visible defect in the deliverable.
- Short cuts (15s, 6s) are not generated yet. See
  `docs/products/superdemovideo-video-craft.md`.
- **It has only ever produced a video from a repository we wrote.** Both
  fixtures — the web one and the SwiftUI one — have clean routes, committed
  auth state and role-based selectors, which is the best case by construction.
  Nine real repositories have been through analysis and none has reached a
  video. "Point it at a repository" is not yet a tested claim.
- A rendered native screen shows what the source declares and nothing else. No
  runtime state, no server data, no platform chrome beyond a device frame.
- An Electron demo shows the renderer with a stand-in for its main process. A
  bridge call the repository declares no default for is answered with nothing,
  and the app renders whatever it renders in that case — in KashinAI, a
  permission banner with a blank where the status word goes. Answering it would
  mean claiming a state we cannot know.

## Where the design lives

- `docs/products/superdemovideo-requirements.md` — what it must do
- `docs/products/superdemovideo-architecture.md` — pipeline and cost model
- `docs/products/superdemovideo-m1-plan.md` — this milestone, and the delta record
- `docs/products/superdemovideo-video-craft.md` — why the template is shaped the way it is
