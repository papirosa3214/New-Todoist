// ═══════════ ОБЩИЙ ЖУРНАЛ СИНХРОНИЗАЦИИ (sync_changes) ═══════════
//
// Зачем этот маршрут. Журнал карточек (`/api/tasks/changes`) покрывает
// только tasks и его дочерние таблицы. Проекты, метки, заметки и рутины в
// него не пишутся — а события сокета в разрыв связи не доходят. Итог (разбор
// 02.11.2026): правка рутины, заметки, проекта или метки на сервере
// оставалась на телефоне до перезагрузки экрана.
//
// Решение — заметка Архитектора «Техническое решение и риски» (карточка
// 2980844e): источник правды — журнал на сервере и чтение по курсору;
// сокет остаётся сигналом («что-то изменилось, перечитай»), но пропуск
// события не ведёт к рассинхрону — после разрыва клиент догоняет по курсору.
//
// Контракт: `GET /api/sync/changes?since=<курсор>` →
//   {
//     server_time, cursor, full,
//     entities: {
//       projects:  { changed_ids, removed_ids },
//       labels:    { changed_ids, removed_ids },
//       notes:     { changed_ids, removed_ids },
//       schedules: { changed_ids, removed_ids },
//     }
//   }
//
// Почему id, а не готовые строки (D6): точечных маршрутов «сущность по id»
// у большинства типов нет, а списки маленькие — клиент после дельты
// перечитывает список целиком. Так на сервере не появляется вторая форма
// ответа на ту же сущность.
//
// Видимость — на сервере, до выдачи (риск R3 архитектурной заметки):
// чужие приватные проекты и метки в дельту не попадают.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner, visibleScope } from "../access.js";
import {
  ensureSyncChangesLedger,
  listSyncChanges,
  syncCursor,
  type SyncChangeRow,
  type SyncEntityType,
} from "../lib/syncChanges.js";

/**
 * Видимость снимка владельца (проекта, метки, рутины).
 *
 * Правило — то же, что у справочников в списках (`visibleScope` из
 * `access.ts`): владелец трекера и его контур видят всё, прочий человек —
 * своё. Снимок владельца берётся из журнала: удалённой записи в живой
 * таблице уже нет, и проверить её видимость по ней нельзя.
 */
function ownerVisible(
  userId: string,
  ownerId: string | null,
  scope: { sql: string; params: any[] },
): boolean {
  if (ownerId === null) return false;
  const row = db
    .prepare(`SELECT 1 AS ok FROM (SELECT ? AS owner_id) t WHERE ${scope.sql}`)
    .get(ownerId, ...scope.params) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

/**
 * Частный проект виден только владельцу трекера — тем же правилом, что и
 * в списке проектов (`privateProjectHides`). Для удалённого проекта живой
 * строки уже нет, поэтому приватность берётся из снимка в журнале.
 */
function privateHidden(userId: string, flags: string | null): boolean {
  if (!flags || !flags.includes("private")) return false;
  return !isOwner(userId);
}

/** Сводит записи журнала к последнему состоянию по каждой сущности. */
function collapse(rows: SyncChangeRow[]): Map<string, SyncChangeRow> {
  const state = new Map<string, SyncChangeRow>();
  for (const row of rows) {
    const key = `${row.entity_type}:${row.entity_id}`;
    const prev = state.get(key);
    state.set(key, {
      ...row,
      // Удаление перебивает правку: сущности уже нет.
      deleted: (prev?.deleted ?? 0) === 1 || row.deleted === 1 ? 1 : 0,
      owner_id: row.owner_id ?? prev?.owner_id ?? null,
      parent_id: row.parent_id ?? prev?.parent_id ?? null,
      flags: row.flags ?? prev?.flags ?? null,
    });
  }
  return state;
}

export function registerSyncRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;
  ensureSyncChangesLedger();

  app.get<{ Querystring: { since?: string } }>(
    "/api/sync/changes",
    { preHandler: authPre },
    async (req: any) => {
      const userId = req.userId;
      const since = typeof req.query?.since === "string" ? req.query.since : null;
      const cursor = syncCursor();
      const { rows, full } = listSyncChanges(since);
      if (full) {
        // Журнал не покрывает запрошенный момент — клиент перечитывает всё.
        return {
          server_time: cursor,
          cursor,
          full: true,
          entities: emptyEntities(),
        };
      }

      const state = collapse(rows);
      const entityScope = visibleScope(userId, "owner_id");
      const buckets: Record<
        SyncEntityType,
        { changed_ids: string[]; removed_ids: string[] }
      > = {
        projects: { changed_ids: [], removed_ids: [] },
        labels: { changed_ids: [], removed_ids: [] },
        notes: { changed_ids: [], removed_ids: [] },
        schedules: { changed_ids: [], removed_ids: [] },
      };

      for (const row of state.values()) {
        const bucket = buckets[row.entity_type];
        if (!bucket) continue;
        if (row.entity_type === "projects") {
          // Проект — справочник с владельцем и приватностью: видимость
          // решается по снимку журнала (у удалённого проекта живой строки
          // уже нет).
          if (!ownerVisible(userId, row.owner_id, entityScope)) continue;
          if (privateHidden(userId, row.flags)) continue;
        }
        if (row.entity_type === "labels" || row.entity_type === "schedules") {
          // Метки и рутины — тоже справочники с владельцем.
          if (!ownerVisible(userId, row.owner_id, entityScope)) continue;
        }
        // Заметки — общие для трекера: их и обычный список `/api/notes`
        // отдаёт целиком.
        if (row.deleted === 1) bucket.removed_ids.push(row.entity_id);
        else bucket.changed_ids.push(row.entity_id);
      }

      return {
        server_time: cursor,
        cursor,
        full: false,
        entities: buckets,
      };
    },
  );
}

function emptyEntities(): Record<
  SyncEntityType,
  { changed_ids: string[]; removed_ids: string[] }
> {
  return {
    projects: { changed_ids: [], removed_ids: [] },
    labels: { changed_ids: [], removed_ids: [] },
    notes: { changed_ids: [], removed_ids: [] },
    schedules: { changed_ids: [], removed_ids: [] },
  };
}
