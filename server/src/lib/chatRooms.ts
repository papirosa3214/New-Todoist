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
/** Сколько минут после последнего сообщения пара считается «на связи». */
const LIVE_MINUTES = 15;

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

/** Личка двух ролей: одна постоянная переписка на пару. */
export function ensureDirectRoom(a: string, b: string): string {
  return db.transaction(() => {
    const existing = db.prepare(`SELECT c.id FROM chats c WHERE c.room_kind='dm'
        AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=c.id AND member_id=?)
        AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=c.id AND member_id=?)
      ORDER BY c.created_at, c.id LIMIT 1`).get(a, b) as { id: string } | undefined;
    if (existing) return existing.id;
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

/** Идёт ли обмен в чате: свежее сообщение или доставка в очереди. */
function isLive(chatId: string): boolean {
  if (db.prepare("SELECT 1 FROM chat_message_queue WHERE chat_id=? AND status IN ('pending','picked') LIMIT 1").get(chatId)) return true;
  return !!db.prepare(`SELECT 1 FROM chat_messages WHERE chat_id=? AND created_at > datetime('now', ?) LIMIT 1`).get(chatId, `-${LIVE_MINUTES} minutes`);
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
  const roles = db.prepare(`SELECT u.id, u.name, u.role_key, u.avatar_color, u.avatar_url, u.initials
      FROM users u LEFT JOIN roles r ON r.key=u.role_key
     WHERE u.type='ai' AND u.role_key IS NOT NULL AND COALESCE(u.archived,0)=0
     ORDER BY CASE WHEN u.id=? THEN 0 ELSE 1 END, COALESCE(r.position, 999), u.name`).all(SECRETARY_ID) as Array<{ id: string; name: string; role_key: string; avatar_color: string | null; avatar_url: string | null; initials: string | null }>;
  const dms = db.prepare(`SELECT c.id, GROUP_CONCAT(m.member_id) AS members FROM chats c JOIN chat_members m ON m.chat_id=c.id
      WHERE c.room_kind='dm' GROUP BY c.id`).all() as Array<{ id: string; members: string }>;
  const dmInfo = dms.map((d) => {
    const pair = d.members.split(",").sort();
    return { chat_id: d.id, members: pair, pair: pair.join(":"), live: isLive(d.id), last_message: lastMessage(d.id) };
  });
  return {
    common: { chat_id: COMMON_CHAT_ID, live: isLive(COMMON_CHAT_ID), last_message: lastMessage(COMMON_CHAT_ID) },
    roles: roles.map((role) => {
      const personal = ensurePersonalRoom(role.id);
      const mine = dmInfo.filter((d) => d.members.includes(role.id));
      return {
        ...role,
        personal_chat_id: personal,
        working: isWorking(role.id),
        last_message: personal ? lastMessage(personal) : null,
        dms: mine.map((d) => ({
          chat_id: d.chat_id,
          peer_id: d.members.find((m) => m !== role.id) ?? null,
          pair: d.pair,
          live: d.live,
          last_message: d.last_message,
        })).sort((x, y) => (y.last_message?.created_at ?? "").localeCompare(x.last_message?.created_at ?? "")),
      };
    }),
  };
}
