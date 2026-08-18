import { Navigate, Outlet } from "react-router-dom";
import { getToken } from "../api/client";

// Presence-of-token guard. If the token is stale/invalid, the first API
// call any screen makes will 401 and the api client itself clears the
// token and redirects to /login (see src/api/client.ts).
export function RequireAuth() {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Outlet />;
}
