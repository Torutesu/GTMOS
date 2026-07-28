import { useEffect, useState, type ReactNode } from "react";

/**
 * A router in thirty lines.
 *
 * Three routes do not justify a routing library on a page whose whole job is
 * to show progress. Anything more — nested layouts, guards, data loaders — and
 * this would be the wrong call.
 */
export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function Link({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        // Let modified clicks open a new tab: intercepting those is the kind
        // of thing that makes a hand-rolled router feel broken.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
