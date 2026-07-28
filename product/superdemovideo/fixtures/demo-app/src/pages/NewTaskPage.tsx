import { useState, useSyncExternalStore } from "react";
import { addTask, getMembers, subscribe } from "../store.ts";

export function NewTaskPage() {
  const members = useSyncExternalStore(subscribe, getMembers);
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState(members[0]?.id ?? "");
  const [due, setDue] = useState("2026-08-15");
  const [tag, setTag] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  return (
    <>
      <h1>New task</h1>
      <p className="sub">Give it an owner and a date, or it never happens.</p>

      {created && <div className="banner">Task {created} created</div>}

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          const task = addTask({ title, owner, due, tag });
          setCreated(task.id);
          setTitle("");
          setTag("");
        }}
      >
        <div className="form">
          <div>
            <label htmlFor="title">Title</label>
            <input
              id="title"
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to happen?"
            />
          </div>

          <div className="row">
            <div>
              <label htmlFor="owner">Owner</label>
              <select id="owner" name="owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="due">Due date</label>
              <input id="due" name="due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          </div>

          <div>
            <label htmlFor="tag">Tag</label>
            <input
              id="tag"
              name="tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="Onboarding, Billing, Performance…"
            />
            <div className="hint">Tags group work on the dashboard.</div>
          </div>

          <button className="btn" type="submit">
            Create task
          </button>
        </div>
      </form>
    </>
  );
}
