import { useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { STATUSES, getMembers, getTasks, getThroughput, memberById, subscribe } from "../store.ts";

export function DashboardPage() {
  const tasks = useSyncExternalStore(subscribe, getTasks);
  const members = useSyncExternalStore(subscribe, getMembers);
  const throughput = getThroughput();
  const shippedThisWeek = throughput[throughput.length - 1]?.shipped ?? 0;
  const shippedLastWeek = throughput[throughput.length - 2]?.shipped ?? 0;
  const open = tasks.filter((t) => t.status !== "Done").length;
  const inReview = tasks.filter((t) => t.status === "In review").length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="sub">Everything the team has in flight this week.</p>
        </div>
        <Link className="btn" to="/tasks/new">
          New task
        </Link>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Open work</div>
          <div className="value">{open}</div>
          <div className="delta">across {members.length} people</div>
        </div>
        <div className="stat">
          <div className="label">In review</div>
          <div className="value">{inReview}</div>
          <div className="delta">waiting on a second pair of eyes</div>
        </div>
        <div className="stat">
          <div className="label">Shipped this week</div>
          <div className="value">{shippedThisWeek}</div>
          <div className="delta">+{shippedThisWeek - shippedLastWeek} vs last week</div>
        </div>
        <div className="stat">
          <div className="label">Cycle time</div>
          <div className="value">3.4d</div>
          <div className="delta">down from 4.1d</div>
        </div>
      </div>

      <div className="columns">
        {STATUSES.map((status) => {
          const column = tasks.filter((t) => t.status === status);
          return (
            <section key={status} aria-label={status}>
              <div className="column-head">
                <span>{status}</span>
                <span className="count">{column.length}</span>
              </div>
              {column.map((task) => {
                const owner = memberById(task.owner);
                return (
                  <article className="task" key={task.id}>
                    <div className="id">{task.id}</div>
                    <div className="title">{task.title}</div>
                    <div className="meta">
                      <span className="tag">{task.tag}</span>
                      <span className="avatar" title={owner?.name}>
                        {owner?.initials ?? "—"}
                      </span>
                    </div>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </>
  );
}
