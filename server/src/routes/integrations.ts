import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

const uid = () => crypto.randomUUID();

function getUserId(req: FastifyRequest): string {
  return (req as any).userId;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

interface GoogleTaskItem {
  id: string;
  title: string;
  notes?: string;
  status: "needsAction" | "completed";
  due?: string;
  completed?: string;
  deleted?: boolean;
  hidden?: boolean;
  updated?: string;
}

interface GoogleTaskList {
  id: string;
  title: string;
  updated?: string;
}

/** Получить рабочий access_token для Google API (с автообновлением при истечении). */
async function getFreshGoogleToken(userId: string): Promise<string | null> {
  const row = db
    .prepare(
      "SELECT access_token, refresh_token, token_expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google'",
    )
    .get(userId) as
    | {
        access_token: string | null;
        refresh_token: string | null;
        token_expires_at: number | null;
      }
    | undefined;

  if (!row || !row.refresh_token) return null;

  const now = Date.now();
  // Если токен валиден ещё хотя бы 2 минуты — используем его
  if (row.access_token && row.token_expires_at && row.token_expires_at > now + 120_000) {
    return row.access_token;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return row.access_token;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: row.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    // Раньше тут возвращался `row.access_token` (протухший) — и тогда
    // ручка ниже шла в Google за списками с битым токеном, Google отдавал
    // 401, ручка пробрасывала его клиенту, а APIClient на любой 401 чистил
    // токен сессии и разлогинивал. Сейчас на неуспешный refresh и на сетевую
    // ошибку возвращаем null — ручка уйдёт в ветку «Google не подключён»,
    // а та теперь отвечает пустым массивом/200 или 412, не 401.
    if (!res.ok) return null;
    const data = (await res.json()) as GoogleTokenResponse;
    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

    db.prepare(
      "UPDATE user_integrations SET access_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE user_id = ? AND provider = 'google'",
    ).run(data.access_token, expiresAt, userId);

    return data.access_token;
  } catch {
    return null;
  }
}

export function registerIntegrationRoutes(app: FastifyInstance) {
  // ═══════════ Статус интеграций ═══════════
  app.get("/api/integrations/status", { preHandler: authOrApiToken }, async (req) => {
    const userId = getUserId(req);
    const google = db
      .prepare(
        "SELECT provider, account_email, settings, last_synced_at, token_expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google'",
      )
      .get(userId) as any;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const isConfigured = Boolean(clientId && process.env.GOOGLE_CLIENT_SECRET);

    return {
      google: {
        configured: isConfigured,
        connected: Boolean(google),
        email: google?.account_email || null,
        lastSyncedAt: google?.last_synced_at || null,
        settings: google?.settings ? JSON.parse(google.settings) : {},
      },
    };
  });

  // ═══════════ Google OAuth: URL для авторизации ═══════════
  app.get("/api/integrations/google/auth-url", { preHandler: authOrApiToken }, async (req, reply) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return reply.code(400).send({
        error: "Google Client ID не настроен на сервере (GOOGLE_CLIENT_ID в .env)",
      });
    }

    const redirectUri =
      (req.query as any)?.redirect_uri ||
      process.env.GOOGLE_REDIRECT_URI ||
      "http://localhost:5180/settings/integrations";

    const scopes = [
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes,
      access_type: "offline",
      prompt: "consent",
    });

    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
  });

  // ═══════════ Google OAuth: Callback / Обмен кода на токены ═══════════
  app.post("/api/integrations/google/callback", { preHandler: authOrApiToken }, async (req, reply) => {
    const userId = getUserId(req);
    const { code, redirectUri } = req.body as { code?: string; redirectUri?: string };

    if (!code) {
      return reply.code(400).send({ error: "Параметр code обязателен" });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return reply.code(400).send({ error: "Google OAuth credentials не настроены на сервере" });
    }

    const redirect = redirectUri || process.env.GOOGLE_REDIRECT_URI || "http://localhost:5180/settings/integrations";

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return reply.code(400).send({ error: `Ошибка обмена кода Google: ${errText}` });
      }

      const tokenData = (await tokenRes.json()) as GoogleTokenResponse;
      const expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000;

      // Получаем email пользователя
      let email: string | null = null;
      try {
        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userRes.ok) {
          const userData = (await userRes.json()) as { email?: string };
          email = userData.email || null;
        }
      } catch {
        // email опционален
      }

      const existing = db
        .prepare("SELECT id, refresh_token FROM user_integrations WHERE user_id = ? AND provider = 'google'")
        .get(userId) as { id: string; refresh_token: string } | undefined;

      const refreshToken = tokenData.refresh_token || existing?.refresh_token || null;

      if (existing) {
        db.prepare(
          `UPDATE user_integrations
              SET access_token = ?, refresh_token = ?, token_expires_at = ?, account_email = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(tokenData.access_token, refreshToken, expiresAt, email, existing.id);
      } else {
        db.prepare(
          `INSERT INTO user_integrations (id, user_id, provider, account_email, access_token, refresh_token, token_expires_at, settings)
           VALUES (?, ?, 'google', ?, ?, ?, ?, '{}')`,
        ).run(uid(), userId, email, tokenData.access_token, refreshToken, expiresAt);
      }

      return { ok: true, email };
    } catch (err: any) {
      return reply.code(500).send({ error: `Ошибка Google OAuth: ${err.message}` });
    }
  });

  // ═══════════ Отключение интеграции ═══════════
  app.post("/api/integrations/google/disconnect", { preHandler: authOrApiToken }, async (req) => {
    const userId = getUserId(req);
    db.prepare("DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google'").run(userId);
    return { ok: true };
  });

  // ═══════════ Получение списков задач из Google Tasks ═══════════
  app.get("/api/integrations/google/lists", { preHandler: authOrApiToken }, async (req, reply) => {
    const userId = getUserId(req);
    const token = await getFreshGoogleToken(userId);
    if (!token) {
      // Не 401: APIClient на любой 401 чистит токен сессии и разлогинивает,
      // а здесь состояние «Google не подключён» (или протух, см. комментарий
      // в `getFreshGoogleToken`) — это не про сессию.
      return { lists: [] };
    }

    try {
      const res = await fetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return reply.code(res.status).send({ error: "Ошибка запроса списков задач Google" });
      }
      const data = (await res.json()) as { items?: GoogleTaskList[] };
      return { lists: data.items || [] };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════ Google Calendar: Списки календарей ═══════════
  app.get("/api/integrations/google/calendars", { preHandler: authOrApiToken }, async (req, reply) => {
    const userId = getUserId(req);
    const token = await getFreshGoogleToken(userId);
    if (!token) {
      return { calendars: [] };
    }

    try {
      const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return reply.code(res.status).send({ error: "Ошибка запроса календарей Google" });
      }
      const data = (await res.json()) as { items?: any[] };
      const calendars = (data.items || []).map((c) => ({
        id: c.id,
        summary: c.summary || c.id,
        backgroundColor: c.backgroundColor || "#4285F4",
        primary: !!c.primary,
      }));
      return { calendars };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════ Google Calendar: События на дату ═══════════
  app.get("/api/integrations/google/calendar-events", { preHandler: authOrApiToken }, async (req, reply) => {
    const userId = getUserId(req);
    const token = await getFreshGoogleToken(userId);
    if (!token) {
      return { events: [] };
    }

    const { date, calendarIds } = req.query as { date?: string; calendarIds?: string };
    if (!date) {
      return reply.code(400).send({ error: "Параметр date обязателен (YYYY-MM-DD)" });
    }

    const timeMin = `${date}T00:00:00Z`;
    const timeMax = `${date}T23:59:59Z`;

    let cIds = calendarIds ? calendarIds.split(",").map((s) => s.trim()).filter(Boolean) : [];

    try {
      if (cIds.length === 0) {
        const listRes = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (listRes.ok) {
          const listData = (await listRes.json()) as { items?: any[] };
          cIds = (listData.items || []).map((c) => c.id);
        }
        if (cIds.length === 0) {
          cIds = ["primary"];
        }
      }

      const allEvents: any[] = [];

      for (const cid of cIds) {
        try {
          const evRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cid)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (evRes.ok) {
            const evData = (await evRes.json()) as { summary?: string; items?: any[] };
            const calTitle = evData.summary || cid;
            for (const item of evData.items || []) {
              if (item.status === "cancelled") continue;
              const isAllDay = !!item.start?.date && !item.start?.dateTime;
              const startDate = item.start?.dateTime || `${item.start?.date}T00:00:00`;
              const endDate = item.end?.dateTime || `${item.end?.date}T23:59:59`;
              allEvents.push({
                id: item.id,
                calendarId: cid,
                title: item.summary || "(Без названия)",
                startDate,
                endDate,
                allDay: isAllDay,
                calendarTitle: calTitle,
                calendarColor: "#4285F4",
                location: item.location || undefined,
              });
            }
          }
        } catch {
          // ignore
        }
      }

      return { events: allEvents };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════ Синхронизация Google Tasks ═══════════
  app.post("/api/integrations/google/sync", { preHandler: authOrApiToken }, async (req, reply) => {
    const userId = getUserId(req);
    const token = await getFreshGoogleToken(userId);
    // 412, а не 401: см. длинный комментарий в `getFreshGoogleToken` и в
    // `/google/lists`. Это экшен, не чтение — пользователь должен явно
    // увидеть, что Google надо переподключить.
    if (!token) {
      return reply.code(412).send({ error: "Google аккаунт не подключён или токен требует повторного входа" });
    }

    const { listId = "@default" } = (req.body as any) || {};

    try {
      // 1. Получаем задачи из Google Tasks
      const gRes = await fetch(
        `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?showCompleted=true&showHidden=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!gRes.ok) {
        return reply.code(gRes.status).send({ error: "Ошибка получения задач из Google Tasks" });
      }

      const gData = (await gRes.json()) as { items?: GoogleTaskItem[] };
      const googleTasks = gData.items || [];

      let imported = 0;
      let updated = 0;

      // 1. Ищем или создаем проект "Google Задачи" для пользователя
      let googleProject = db
        .prepare("SELECT id FROM projects WHERE owner_id = ? AND name = 'Google Задачи'")
        .get(userId) as { id: string } | undefined;

      if (!googleProject) {
        const pId = uid();
        db.prepare(
          "INSERT INTO projects (id, name, color, owner_id) VALUES (?, 'Google Задачи', '#4285F4', ?)",
        ).run(pId, userId);
        googleProject = { id: pId };
      }

      for (const gt of googleTasks) {
        if (!gt.title || gt.deleted) continue;

        const isCompleted = gt.status === "completed";
        let dueDate: string | null = null;
        let startTime: string | null = null;

        if (gt.due) {
          const d = new Date(gt.due);
          if (!isNaN(d.getTime())) {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            dueDate = `${year}-${month}-${day}`;

            // Если время в Google Tasks указано (не дефолтная полночь UTC)
            if (
              gt.due.includes("T") &&
              !gt.due.endsWith("T00:00:00.000Z") &&
              !gt.due.endsWith("T00:00:00Z")
            ) {
              const hours = String(d.getHours()).padStart(2, "0");
              const minutes = String(d.getMinutes()).padStart(2, "0");
              startTime = `${hours}:${minutes}`;
            }
          }
        }

        // Проверяем, привязана ли уже задача
        const mapping = db
          .prepare("SELECT task_id FROM task_external_mappings WHERE provider = 'google' AND external_id = ?")
          .get(gt.id) as { task_id: string } | undefined;

        if (mapping) {
          // Обновляем существующую
          db.prepare(
            `UPDATE tasks
                SET title = ?, description = COALESCE(?, description),
                    status = ?, due_date = COALESCE(?, due_date),
                    start_time = COALESCE(?, start_time),
                    project_id = COALESCE(project_id, ?),
                    completed_at = CASE WHEN ? = 'completed' AND completed_at IS NULL THEN datetime('now') ELSE completed_at END,
                    updated_at = datetime('now')
              WHERE id = ?`,
          ).run(gt.title, gt.notes || null, isCompleted ? "completed" : "active", dueDate, startTime, googleProject.id, isCompleted ? "completed" : "active", mapping.task_id);
          updated++;
        } else {
          // Создаём новую задачу в TaskFlow в проекте "Google Задачи"
          const newTaskId = uid();
          db.prepare(
            `INSERT INTO tasks (id, creator_id, title, description, status, priority, due_date, start_time, project_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'), datetime('now'))`,
          ).run(newTaskId, userId, gt.title, gt.notes || "", isCompleted ? "completed" : "active", dueDate, startTime, googleProject.id);

          db.prepare(
            `INSERT INTO task_external_mappings (id, task_id, provider, external_id, external_list_id)
             VALUES (?, ?, 'google', ?, ?)`,
          ).run(uid(), newTaskId, gt.id, listId);
          imported++;
        }
      }

      // Обновляем время последней синхронизации
      db.prepare(
        "UPDATE user_integrations SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND provider = 'google'",
      ).run(userId);

      return {
        ok: true,
        imported,
        updated,
        totalGoogleTasks: googleTasks.length,
        syncedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return reply.code(500).send({ error: `Ошибка синхронизации: ${err.message}` });
    }
  });

  // ═══════════ Сохранение настроек интеграции ═══════════
  app.patch("/api/integrations/settings", { preHandler: authOrApiToken }, async (req) => {
    const userId = getUserId(req);
    const { provider = "google", settings } = req.body as { provider?: string; settings: any };

    db.prepare(
      `UPDATE user_integrations
          SET settings = ?, updated_at = datetime('now')
        WHERE user_id = ? AND provider = ?`,
    ).run(JSON.stringify(settings || {}), userId, provider);

    return { ok: true };
  });
}
