import { NavLink, Outlet } from "react-router-dom";
import { workspaceName } from "../store.ts";

export function Shell() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              T
            </span>
            <span>
              Taskloop
              <div className="workspace">{workspaceName()}</div>
            </span>
          </div>
        </div>

        <nav className="nav" aria-label="Main">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/tasks/new">New task</NavLink>
          <NavLink to="/settings/team">Team</NavLink>
        </nav>

        <div className="sidebar-foot">Week 30 · Northwind</div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
