import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { getToken, setToken } from "./api.ts";
import { Link, usePath } from "./router.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { ProjectPage } from "./pages/Project.tsx";
import { RunPage } from "./pages/Run.tsx";
import "./styles.css";

function App() {
  const path = usePath();

  const project = /^\/projects\/([^/]+)$/.exec(path);
  const run = /^\/runs\/([^/]+)$/.exec(path);

  return (
    <>
      <header className="top">
        <Link to="/" className="brand">
          Superdemovideo
        </Link>
        <span className="spacer" />
        <TokenBox />
      </header>
      {run ? (
        <RunPage id={run[1]!} />
      ) : project ? (
        <ProjectPage id={project[1]!} />
      ) : (
        <ProjectsPage />
      )}
    </>
  );
}

/**
 * The API token.
 *
 * It lives in localStorage rather than a login flow because M1 has one
 * operator on one machine and a session store would be ceremony around a
 * single environment variable. It is hidden entirely when the server is
 * running without a token at all.
 */
function TokenBox() {
  const [value, setValue] = useState(getToken());
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button className="ghost small" onClick={() => setOpen(true)}>
        {value ? "token set" : "set token"}
      </button>
    );
  }
  return (
    <div className="row">
      <input
        type="password"
        value={value}
        placeholder="SDV_TOKEN"
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 220 }}
      />
      <button
        onClick={() => {
          setToken(value);
          setOpen(false);
          window.location.reload();
        }}
      >
        Save
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
