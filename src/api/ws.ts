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
    const wsUrl = `${API_BASE_URL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      return;
    }

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
    };

    const pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);

    return () => {
      clearInterval(pingInterval);
      socket.close();
    };
  }, [enabled, qc]);
}
