import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "../store.ts";

export function LoginPage() {
  const [email, setEmail] = useState("rosa@northwind.design");
  const navigate = useNavigate();

  return (
    <div className="login">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          signIn(email);
          navigate("/dashboard", { replace: true });
        }}
      >
        <h1>Sign in to Taskloop</h1>
        <p className="sub">Plan the week, assign work, keep the team aligned.</p>

        <div className="form">
          <div>
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>
          <button className="btn" type="submit">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}
