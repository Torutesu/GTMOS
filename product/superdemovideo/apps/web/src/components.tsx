const PILL: Record<string, string> = {
  succeeded: "ok",
  running: "run",
  queued: "run",
  awaiting_selection: "wait",
  failed: "bad",
};

const LABEL: Record<string, string> = {
  awaiting_selection: "choose a demo",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${PILL[status] ?? ""}`}>{LABEL[status] ?? status}</span>;
}
