import crypto from "node:crypto";
import db from "../db.js";
import { COMMON_CHAT_ID, ensureCommonChat } from "./chatCommon.js";

/**
 * Комнаты раздела «Чаты» (владелец 21.10.2026,
 * docs/2026-10-21-chats-rooms-and-sessions.md).
 *
 * Постоянные комнаты различаются по `chats.room_kind`, а не по составу:
 * - `personal` — владелец ↔ роль, одна на роль, не удаляется;
 * - `dm` — личка роль ↔ роль, одна на пару;
 * - `common` — Общая.
 * Служебные `wake` и `handoff` — это сессии, их личкой не считаем никогда.
 */

const SECRETARY_ID = "u-secretary";

function ownerId(): string | null {
  return (db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
}

function activeRole(roleId: string): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE id=? AND type='ai' AND role_key IS NOT NULL AND COALESCE(archived,0)=0").get(roleId);
}

/** Личная комната владельца с ролью: найти или завести. */
export function ensurePersonalRoom(roleId: string): string | null {
  const owner = ownerId();
  if (!owner || !activeRole(roleId)) return null;
  return db.transaction(() => {
    const existing = db.prepare(`SELECT c.id FROM chats c WHERE c.room_kind='personal'
        AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=c.id AND member_id=?)
      ORDER BY c.created_at, c.id LIMIT 1`).get(roleId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = roleId === SECRETARY_ID ? "chat-secretary" : "personal:" + roleId;
    db.prepare("INSERT OR IGNORE INTO chats(id,kind,created_by,room_kind) VALUES(?,'direct',?,'personal')").run(id, owner);
    db.prepare("UPDATE chats SET room_kind='personal' WHERE id=?").run(id);
    const member = db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)");
    member.run(id, owner);
    member.run(id, roleId);
    return id;
  })();
}

/** Название сессии по первому сообщению (владелец 26.10.2026): первая
 * непустая строка без разметки, до 60 знаков с обрезкой по слову — как у
 * «Ветки». Пусто — `null`. */
export function autoTitleFromText(text: string): string | null {
  const line = text.split("\n").map((l) => l.replace(/[#*_`>~]+/g, "").replace(/\s+/g, " ").trim()).find(Boolean);
  if (!line) return null;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 59);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, "") + "…";
}

/** Сессия без названия получает его от первого сообщения человека. Комнаты,
 * темы задач, проектные группы и ветки не трогаем: у них своё имя. */
export function autoTitleChat(chatId: string, text: string): void {
  const title = autoTitleFromText(text);
  if (!title) return;
  db.prepare(`UPDATE chats SET title=? WHERE id=? AND (title IS NULL OR title='') AND room_kind IS NULL
      AND task_id IS NULL AND project_id IS NULL AND parent_chat_id IS NULL AND branch_of_chat_id IS NULL
      AND (SELECT COUNT(*) FROM chat_messages m JOIN users u ON u.id=m.from_user_id
           WHERE m.chat_id=chats.id AND u.type!='ai' AND COALESCE(m.is_session_marker,0)=0)=1`).run(title, chatId);
}

/** Личка двух ролей: одна постоянная переписка на пару. */
export function ensureDirectRoom(a: string, b: string): string {
  return db.transaction(() => {
    const existing = db.prepare(`SELECT c.id FROM chats c WHERE c.room_kind='dm'
        AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=c.id AND member_id=?)
        AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=c.id AND member_id=?)
      ORDER BY c.created_at, c.id LIMIT 1`).get(a, b) as { id: string } | undefined;
    if (existing) {
      db.prepare("UPDATE chats SET closed_at=NULL WHERE id=? AND closed_at IS NOT NULL").run(existing.id);
      return existing.id;
    }
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO chats(id,kind,created_by,room_kind) VALUES(?,'direct',?,'dm')").run(id, a);
    const member = db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)");
    member.run(id, a);
    member.run(id, b);
    return id;
  })();
}

export function isDirectRoom(chatId: string): boolean {
  return !!db.prepare("SELECT 1 FROM chats WHERE id=? AND room_kind='dm'").get(chatId);
}

type LastMessage = { text: string; created_at: string; from_user_id: string } | null;

/** Превью строки: без конверта роли и кода виджетов — функцию даёт маршрут. */
let preview: (text: string) => string = (text) => text;

function lastMessage(chatId: string): LastMessage {
  const row = (db.prepare(`SELECT text, created_at, from_user_id FROM chat_messages
      WHERE chat_id=? AND COALESCE(is_session_marker,0)=0 ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(chatId) as LastMessage) ?? null;
  return row ? { ...row, text: preview(row.text ?? "").slice(0, 200) } : null;
}

/** Идёт ли обмен в чате прямо сейчас: есть недоставленная или выполняемая
 *  доставка роли. Окна «15 минут после сообщения» больше нет (владелец
 *  21.10.2026): облачко гасится, как только разговор закончился. */
function isLive(chatId: string): boolean {
  return !!db.prepare("SELECT 1 FROM chat_message_queue WHERE chat_id=? AND status IN ('pending','picked') LIMIT 1").get(chatId);
}

export type RoomTurnOutcome = "answered" | "failed" | "limit";

/**
 * Ход роли в комнате для строки списка (владелец 27.10.2026): `running` —
 * роль сейчас отвечает здесь (анимированная аватарка); `outcome` — чем
 * кончился последний ход, пока зритель не открыл комнату: ответила
 * (зелёная точка), отвалилась (жёлтая), кончился лимит (красная). Открыл
 * комнату — отметка прочтения новее ответа, итог гаснет.
 */
export function roomTurn(chatId: string, viewerId: string | null): { running: boolean; outcome: RoomTurnOutcome | null } {
  const running = !!db.prepare("SELECT 1 FROM chat_message_queue WHERE chat_id=? AND status='picked' LIMIT 1").get(chatId);
  if (running || !viewerId) return { running, outcome: null };
  const read = db.prepare("SELECT last_read_at FROM chat_members WHERE chat_id=? AND member_id=?").get(chatId, viewerId) as
    | { last_read_at: string | null }
    | undefined;
  // Зритель не участник комнаты (переписка ролей) — отметки прочтения нет,
  // итог показывать не на что гасить.
  if (!read) return { running, outcome: null };
  const last = db.prepare(`SELECT m.stop_reason FROM chat_messages m JOIN users u ON u.id=m.from_user_id
      WHERE m.chat_id=? AND u.type='ai' AND COALESCE(m.is_session_marker,0)=0 AND COALESCE(m.message_type,'')!='system'
        AND m.created_at > COALESCE(?, '1970-01-01')
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`).get(chatId, read.last_read_at) as { stop_reason: string | null } | undefined;
  if (!last) return { running, outcome: null };
  if (!last.stop_reason) return { running, outcome: "answered" };
  if (last.stop_reason === "limit") return { running, outcome: "limit" };
  if (last.stop_reason === "owner_interrupt") return { running, outcome: null };
  return { running, outcome: "failed" };
}

/** Работает ли роль прямо сейчас: забранная доставка любого чата. */
function isWorking(roleId: string): boolean {
  return !!db.prepare("SELECT 1 FROM chat_message_queue WHERE role_id=? AND status='picked' LIMIT 1").get(roleId);
}

/**
 * Снимок панели «Комнаты»: Общая и личная комната каждой действующей роли
 * с её личками. `pair` — ключ пары для цвета облачка: одинаковый у обеих
 * ролей, поэтому клиент красит их одним цветом.
 */
export function roomsSnapshot(previewText?: (text: string) => string) {
  if (previewText) preview = previewText;
  ensureCommonChat();
  // Внутренние роли (runtime pi) держат постоянную комнату всегда; внешние
  // агенты — только если владелец сам её завёл (21.10.2026: «внешние —
  // разовые, постоянные только у внутренних»).
  const all = db.prepare(`SELECT u.id, u.name, u.role_key, u.avatar_color, u.avatar_url, u.initials,
        COALESCE(r.runtime, 'pi') <> 'pi' AS external,
        EXISTS(SELECT 1 FROM chats c JOIN chat_members m ON m.chat_id=c.id WHERE c.room_kind='personal' AND m.member_id=u.id) AS has_room
      FROM users u LEFT JOIN roles r ON r.key=u.role_key
     WHERE u.type='ai' AND u.role_key IS NOT NULL AND COALESCE(u.archived,0)=0
     ORDER BY CASE WHEN u.id=? THEN 0 ELSE 1 END, COALESCE(r.position, 999), u.name`).all(SECRETARY_ID) as Array<{ id: string; name: string; role_key: string; avatar_color: string | null; avatar_url: string | null; initials: string | null; external: number; has_room: number }>;
  const roles = all.filter((r) => !r.external || r.has_room).map(({ external: _e, has_room: _h, ...role }) => role);
  const externalCandidates = all.filter((r) => r.external && !r.has_room).map(({ external: _e, has_room: _h, ...role }) => role);
  const dms = db.prepare(`SELECT c.id, GROUP_CONCAT(m.member_id) AS members FROM chats c JOIN chat_members m ON m.chat_id=c.id
      WHERE c.room_kind='dm' AND c.closed_at IS NULL GROUP BY c.id`).all() as Array<{ id: string; members: string }>;
  const viewer = ownerId();
  const dmInfo = dms.map((d) => {
    const pair = d.members.split(",").sort();
    return { chat_id: d.id, members: pair, pair: pair.join(":"), live: isLive(d.id), turn: roomTurn(d.id, viewer), last_message: lastMessage(d.id) };
  });
  return {
    common: { chat_id: COMMON_CHAT_ID, live: isLive(COMMON_CHAT_ID), last_message: lastMessage(COMMON_CHAT_ID) },
    /** Внешние агенты без комнаты — пункт «Комната внешнего агента» в меню. */
    external_candidates: externalCandidates,
    roles: roles.map((role) => {
      const personal = ensurePersonalRoom(role.id);
      const mine = dmInfo.filter((d) => d.members.includes(role.id));
      return {
        ...role,
        personal_chat_id: personal,
        personal_turn: personal ? roomTurn(personal, viewer) : null,
        working: isWorking(role.id),
        last_message: personal ? lastMessage(personal) : null,
        dms: mine.map((d) => ({
          chat_id: d.chat_id,
          peer_id: d.members.find((m) => m !== role.id) ?? null,
          pair: d.pair,
          live: d.live,
          turn: d.turn,
          last_message: d.last_message,
        })).sort((x, y) => (y.last_message?.created_at ?? "").localeCompare(x.last_message?.created_at ?? "")),
      };
    }),
  };
}
