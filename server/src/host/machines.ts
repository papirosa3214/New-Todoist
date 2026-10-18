/**
 * Реестр машин-хостов: выдача ключа, поиск по ключу, отзыв (тикет 1,
 * план taskflow-host, D4/D7).
 *
 * Ключ в базе не лежит — только его sha256 и префикс для показа, ровно как у
 * токена устройства (миграция 141). Поэтому `findMachineByToken` — это
 * единственная точка входа для машины, и проверку «отозван ли» она делает
 * здесь же, а не в шлюзе: отозванный хост не должен отличаться от чужого ни
 * по ответу, ни по времени ответа.
 *
 * Имена живых машин уникальны (частичный индекс в миграции 142) — роль
 * спрашивает машину по имени, и две живые машины с одним именем сделали бы
 * такой вопрос неоднозначным.
 */
import crypto from "node:crypto";
import db, { hashApiToken } from "../db.js";

/** Префикс ключа машины. Отличается от пользовательского (tf_) и устройственного (tfd_),
 *  чтобы ключ, случайно попавший в не тот адрес, отличался ошибкой, а не работой. */
export const MACHINE_TOKEN_PREFIX = "tfh_";

/** Сколько первых символов ключа показываем в списке — по нему человек узнаёт свою машину. */
const TOKEN_DISPLAY_PREFIX = 8;

export type Machine = {
  id: string;
  name: string;
  platform: string | null;
  token_prefix: string;
  allowed_roots: string[];
  host_version: string | null;
  created_by: string | null;
  created_at: string;
  last_seen_at: string | null;
  online: number;
  revoked_at: string | null;
  revoke_reason: string | null;
};

type MachineRow = Omit<Machine, "allowed_roots"> & { allowed_roots: string };

/** allowed_roots в базе лежит строкой JSON: это список, а SQLite-массивы не умеет.
 *  Порча JSON не должна ронять чтение реестра целиком, поэтому непарсимый
 *  список становится пустым, а машина при этом видна (и видна как «корней нет»). */
function toMachine(row: MachineRow): Machine {
  let roots: string[] = [];
  try {
    const разобранное = JSON.parse(row.allowed_roots);
    if (Array.isArray(разобранное)) roots = разобранное.map(String);
  } catch {
    roots = [];
  }
  return { ...row, allowed_roots: roots };
}

const SELECT_COLUMNS =
  "id, name, platform, token_prefix, allowed_roots, host_version, created_by, created_at, last_seen_at, online, revoked_at, revoke_reason";

/** Журнал: кто выдал, кто отозвал, когда машина пришла и ушла. Реестр переживает
 *  задачу, а разбираться «почему мак молчит» придётся в другой сессии. */
export function logMachineEvent(
  machineId: string | null,
  kind: string,
  data?: Record<string, unknown>,
) {
  db.prepare(
    "INSERT INTO machine_events (id, machine_id, kind, created_at, data) VALUES (?,?,?,?,?)",
  ).run(
    crypto.randomUUID(),
    machineId,
    kind,
    new Date().toISOString(),
    data ? JSON.stringify(data) : null,
  );
}

/**
 * Выдать машине ключ. Возвращает машину и САМ ключ — он уходит на машину
 * один раз и больше нигде не сохраняется: в базе остаётся sha256.
 */
export function issueMachineKey(input: {
  name: string;
  allowedRoots: string[];
  platform?: string | null;
  createdBy?: string | null;
}): { machine: Machine; token: string } {
  const имя = input.name.trim();
  if (!имя) throw new Error("имя машины обязательно");

  // 32 байта энтропии — тот же класс секрета, что у токена устройства.
  const token =
    MACHINE_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    db
      .prepare(
        `INSERT INTO machines
           (id, name, platform, token_hash, token_prefix, allowed_roots,
            created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        имя,
        input.platform ?? null,
        hashApiToken(token),
        token.slice(0, TOKEN_DISPLAY_PREFIX),
        JSON.stringify(input.allowedRoots),
        input.createdBy ?? null,
        now,
      );
  } catch (err) {
    // UNIQUE на имени живых машин: сырой SqliteError с индексом в тексте —
    // не то, что читает человек, который завёл вторую машину «mac».
    if (String(err).includes("UNIQUE") && String(err).includes("machines.name")) {
      throw new Error(`машина «${имя}» уже есть и не отозвана`);
    }
    throw err;
  }
  logMachineEvent(id, "issued", { name: имя, prefix: token.slice(0, TOKEN_DISPLAY_PREFIX) });

  const machine = getMachine(id);
  if (!machine) throw new Error("машина не сохранилась после выдачи ключа");
  return { machine, token };
}

/** Машина по id, отозванная тоже видна — по ней и объясняют, почему молчит. */
export function getMachine(id: string): Machine | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM machines WHERE id = ?`)
    .get(id) as MachineRow | undefined;
  return row ? toMachine(row) : null;
}

/**
 * Машина по ключу — вход для шлюза.
 *
 * Отозванный ключ возвращает null, а не «машину с revoked_at»: снаружи
 * отозванная машина не должна отличаться от несуществующей, иначе по времени
 * ответа можно перебором узнать, какие ключи когда-то были выданы.
 */
export function findMachineByToken(token: string): Machine | null {
  if (!token || !token.startsWith(MACHINE_TOKEN_PREFIX)) return null;
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM machines
        WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .get(hashApiToken(token)) as MachineRow | undefined;
  return row ? toMachine(row) : null;
}

/** Живая машина по имени — так роль и планировщик спрашивают «mac онлайн?». */
export function findMachineByName(name: string): Machine | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM machines
        WHERE name = ? AND revoked_at IS NULL`,
    )
    .get(name) as MachineRow | undefined;
  return row ? toMachine(row) : null;
}

/**
 * Отзыв ключа. Возвращает true, если машина была жива и отзыв её снял.
 * Повторный отзыв — false: «уже отозвано» это тот же результат, а не ошибка
 * (вызывающий может повторять запрос, разбираясь с ответом).
 */
export function revokeMachine(id: string, reason?: string | null): boolean {
  const now = new Date().toISOString();
  const сколько = db
    .prepare(
      "UPDATE machines SET revoked_at = ?, revoke_reason = ?, online = 0 WHERE id = ? AND revoked_at IS NULL",
    )
    .run(now, reason ?? null, id).changes;
  if (!сколько) return false;
  logMachineEvent(id, "revoked", { reason: reason ?? null });
  return true;
}

/** Удалить запись машины насовсем. Отзыв — это «погасить доступ», он
    мягкий и повторно не проходит (revokeMachine бьёт по `revoked_at IS
    NULL`), поэтому отозванные тестовые записи висели в списке вечно и
    убрать их было нечем (владелец 18.10.2026). Здесь строка и её события
    уходят физически; живой хост предварительно отключается вызывающим. */
export function purgeMachine(id: string): boolean {
  const живая = db.prepare("SELECT 1 FROM machines WHERE id = ?").get(id);
  if (!живая) return false;
  db.prepare("DELETE FROM machine_events WHERE machine_id = ?").run(id);
  const сколько = db.prepare("DELETE FROM machines WHERE id = ?").run(id).changes;
  return сколько > 0;
}

export function listMachines(): Machine[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM machines ORDER BY created_at DESC`)
    .all() as MachineRow[];
  return rows.map(toMachine);
}

/** Хост пришёл: онлайн, когда видели, и версия хоста (её присылает хост). */
export function markMachineOnline(
  id: string,
  hostVersion?: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE machines SET online = 1, last_seen_at = ?, host_version = COALESCE(?, host_version) WHERE id = ?",
  ).run(now, hostVersion ?? null, id);
}

/** Хост отвалился. `online = 0`, но last_seen_at НЕ трогаем: это время последней
 *  связи, по нему видно, когда машина пропала, а не когда мы её записали. */
export function markMachineOffline(id: string): void {
  db.prepare("UPDATE machines SET online = 0 WHERE id = ?").run(id);
}

/** Все машины — офлайн. Вызывается на старте сервера: после рестарта живых
 *  сокетов не осталось ни у кого, и `online = 1` из прошлого запуска было бы
 *  враньём, которое снимается только следующим подключением (то есть на минуты). */
export function markAllMachinesOffline(): void {
  db.prepare("UPDATE machines SET online = 0 WHERE online <> 0").run();
}

/** Пинг хоста — «связь жива». last_seen_at двигается, но в таблицу machine_events
 *  строка не пишется: пинг идёт каждые 20 секунд и сам по себе событием не является. */
export function markMachineSeen(id: string): void {
  db.prepare("UPDATE machines SET last_seen_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}