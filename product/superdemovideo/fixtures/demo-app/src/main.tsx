import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { Shell } from "./components/Shell.tsx";
import { RequireAuth } from "./components/RequireAuth.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { NewTaskPage } from "./pages/NewTaskPage.tsx";
import { TeamPage } from "./pages/TeamPage.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/tasks/new" element={<NewTaskPage />} />
          <Route path="/settings/team" element={<TeamPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
