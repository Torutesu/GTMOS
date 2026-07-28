import { useState, useSyncExternalStore } from "react";
import { getMembers, inviteMember, subscribe, workspaceName } from "../store.ts";

export function TeamPage() {
  const members = useSyncExternalStore(subscribe, getMembers);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("Editor");
  const [sentTo, setSentTo] = useState<string | null>(null);

  return (
    <>
      <h1>Team</h1>
      <p className="sub">Who can see and change work in {workspaceName()}.</p>

      {sentTo && <div className="banner">Invitation sent to {sentTo}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.includes("@")) return;
            inviteMember(email, role);
            setSentTo(email);
            setEmail("");
          }}
        >
          <div className="form">
            <div className="row">
              <div>
                <label htmlFor="invite-email">Email address</label>
                <input
                  id="invite-email"
                  name="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@company.com"
                />
              </div>
              <div>
                <label htmlFor="invite-role">Role</label>
                <select id="invite-role" name="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option>Admin</option>
                  <option>Editor</option>
                  <option>Viewer</option>
                </select>
              </div>
            </div>
            <div>
              <button className="btn" type="submit">
                Send invite
              </button>
              <div className="hint">They will get an email with a link that expires in 7 days.</div>
            </div>
          </div>
        </form>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="member">
                    <span className="avatar">{m.initials}</span>
                    {m.name}
                  </span>
                </td>
                <td>{m.email}</td>
                <td>{m.role}</td>
                <td>
                  <span className={m.pending ? "pill pending" : "pill"}>
                    {m.pending ? "Invited" : "Active"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
