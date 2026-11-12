import db from "../db.js";

/**
 * Метки сессии владельца, которых нет в файле Pi: название, проект-папка,
 * закрепление, архив (владелец 12.11.2026: строки сессий — как строки чатов,
 * с папками, закреплением и меню). Файл сессии не трогаем: архив — метка,
 * переписка остаётся.
 */
export interface OwnerSessionMeta {
  title: string | null;
  projectId: string | null;
  pinned: boolean;
  archivedAt: string | null;
}

export interface OwnerSessionMetaPatch {
  title?: string | null;
  projectId?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export interface OwnerSessionMetaStore {
  read(ids: string[]): Map<string, OwnerSessionMeta>;
  patch(id: string, fields: OwnerSessionMetaPatch): OwnerSessionMeta;
}

type Row = { session_id: string; title: string | null; project_id: string | null; pinned: number; archived_at: string | null };

const fromRow = (row: Row): OwnerSessionMeta => ({
  title: row.title,
  projectId: row.project_id,
  pinned: row.pinned === 1,
  archivedAt: row.archived_at,
});

export const ownerSessionMeta: OwnerSessionMetaStore = {
  read(ids) {
    if (!ids.length) return new Map();
    const rows = db
      .prepare(`SELECT * FROM owner_session_meta WHERE session_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Row[];
    return new Map(rows.map(row => [row.session_id, fromRow(row)]));
  },
  patch(id, fields) {
    const current = ownerSessionMeta.read([id]).get(id)
      ?? { title: null, projectId: null, pinned: false, archivedAt: null };
    const next: OwnerSessionMeta = {
      title: fields.title !== undefined ? fields.title : current.title,
      projectId: fields.projectId !== undefined ? fields.projectId : current.projectId,
      pinned: fields.pinned ?? current.pinned,
      archivedAt: fields.archived === undefined
        ? current.archivedAt
        : fields.archived ? current.archivedAt ?? new Date().toISOString() : null,
    };
    db.prepare(`INSERT INTO owner_session_meta(session_id,title,project_id,pinned,archived_at,updated_at)
      VALUES(?,?,?,?,?,datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, project_id=excluded.project_id,
        pinned=excluded.pinned, archived_at=excluded.archived_at, updated_at=excluded.updated_at`)
      .run(id, next.title, next.projectId, next.pinned ? 1 : 0, next.archivedAt);
    return next;
  },
};
