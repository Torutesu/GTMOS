import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { currentUser } from "../store.ts";

export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (!currentUser()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
