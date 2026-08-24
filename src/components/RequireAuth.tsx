import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { getToken, tryLanLogin } from "../api/client";

import { BiometricLockGuard } from "./BiometricLockGuard";

// Presence-of-token guard. If the token is stale/invalid, the first API
// call any screen makes will 401 and the api client itself clears the
// token and redirects to /login (see src/api/client.ts).
//
// 19.08.2026: до редиректа пробуем вход без пароля из домашней сети.
// Раньше проверка была одной строкой «нет токена — на /login», и весь
// смысл домашнего входа терялся на устройстве, которое ещё ни разу не
// логинилось: экран входа показывался раньше, чем клиент успевал
// спросить /api/auth/lan. Снаружи домашней сети маршрут отвечает 404 —
// тогда, как и было, на /login.
export function RequireAuth() {
  const [state, setState] = useState<"checking" | "ok" | "denied">(() =>
    getToken() ? "ok" : "checking",
  );

  useEffect(() => {
    if (state !== "checking") return;
    let cancelled = false;
    tryLanLogin().then((token) => {
      if (!cancelled) setState(token ? "ok" : "denied");
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  // Пустой экран на время попытки — она укладывается в один запрос по
  // локальной сети; спиннер тут мигал бы чаще, чем помогал.
  if (state === "checking") return null;
  if (state === "denied") return <Navigate to="/login" replace />;
  return (
    <BiometricLockGuard>
      <Outlet />
    </BiometricLockGuard>
  );
}
