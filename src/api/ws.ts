import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL, getToken } from "./client";

// Live updates over /ws.
//
// Auth: the socket is authenticated via a `?token=` query param (JWT or
// api_token), NOT an Authorization header (sockets can't set one) — the
// server resolves userId from that token itself, a client can't subscribe
// to someone else's stream. See AGENT-API.md §5 for the full event list
// (task:created/updated/completed/deleted, notification:new); this hook
// doesn't special-case each one, it just invalidates the two query caches
// that cover all of them.
export function useNotificationsSocket(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    const token = getToken();
    if (!enabled || !token) return;
    const httpBase = API_BASE_URL || window.location.origin;
    const wsUrl = `${httpBase.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

    let socket: WebSocket | null = null;
    let pingInterval: any = null;
    let reconnectTimeout: any = null;
    let isDisposed = false;

    function connect() {
      if (isDisposed) return;
      try {
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
          // При успешном подключении сразу обновляем задачи и уведомления
          qc.invalidateQueries({ queryKey: ["notifications"] });
          qc.invalidateQueries({ queryKey: ["tasks"] });
        };

        socket.onmessage = (evt) => {
          let data: any;
          try {
            data = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (
            data?.type === "connected" ||
            data?.type === "pong" ||
            data?.type === "error"
          )
            return;

          qc.invalidateQueries({ queryKey: ["notifications"] });
          qc.invalidateQueries({ queryKey: ["tasks"] });
          qc.invalidateQueries({ queryKey: ["projects"] });
        };

        socket.onclose = () => {
          socket = null;
          if (!isDisposed) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(connect, 3000);
          }
        };

        socket.onerror = () => {
          if (socket) {
            socket.close();
          }
        };
      } catch {
        if (!isDisposed) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = setTimeout(connect, 3000);
        }
      }
    }

    connect();

    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);

    // При возвращении экрана из фона/блокировки сразу переподключаем и обновляем кэш
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        qc.invalidateQueries({ queryKey: ["tasks"] });
        qc.invalidateQueries({ queryKey: ["notifications"] });
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          connect();
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);

    return () => {
      isDisposed = true;
      clearInterval(pingInterval);
      clearTimeout(reconnectTimeout);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
      if (socket) {
        socket.close();
      }
    };
  }, [enabled, qc]);
}
