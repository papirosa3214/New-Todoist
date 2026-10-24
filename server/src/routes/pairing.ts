/**
 * Привязка телефона по QR (карточка b5a16110, документ решения a91ac9a1-…,
 * §5 и §11.2).
 *
 * Схема словами: владелец на доверенном клиенте вызывает POST
 * /api/pairing/code и показывает QR. Телефон сканирует его и один раз
 * меняет код на долговременный токен устройства через POST
 * /api/pairing/exchange. Дальше телефон ходит только с этим токеном — и по
 * HTTP, и по /ws.
 *
 * Три свойства, ради которых всё и затевалось:
 *
 *  1. В базе нет ни кода, ни токена — только sha256. Утёкший файл базы не
 *     даёт войти: хеш нельзя предъявить, из него нельзя восстановить
 *     секрет (перебор 128 бит бессмысленен). Открытое значение живёт ровно
 *     в ответе выдачи и в QR-коде на экране.
 *  2. Код живёт 5 минут и одноразовый: первый успешный обмен гасит его.
 *  3. Обмен БЕЗ аутентификации — вход и есть обмен кода. Поэтому все
 *     неудачи отвечают ОДНИМ и тем же 400 invalid_code: различая «нет
 *     такого», «просрочен» и «уже использован», подбор по таймингу и по
 *     коду ответа только упрощался бы перебор.
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import db, { hashApiToken } from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { findMachineByName, issueMachineKey } from "../host/machines.js";

/** Срок жизни кода — 5 минут (документ решения §5). */
const CODE_TTL_MS = 5 * 60 * 1000;
/** 128 бит энтропии = 32 hex-символа. */
const CODE_BYTES = 16;
/** Сколько кодов один человек может выписать в час. */
const CODE_LIMIT_PER_HOUR = 10;
/** Сколько ПОПЫТОК обмена с одного адреса в час. */
const EXCHANGE_LIMIT_PER_IP_PER_HOUR = 20;
/** Сколько попыток обмена на один код. */
const EXCHANGE_ATTEMPTS_PER_CODE = 10;

function uid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function oneHourAgoIso(): string {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

/**
 * Журнал привязок.
 *
 * Пишем в `device_events`, а не в общий серверный журнал: события привязки
 * нужны рядом с устройством («когда этот телефон подключали и кто отозвал»),
 * и документ решения §11.1 требует журнал отдельной таблицей. Секретов
 * сюда не кладём — только идентификаторы и время.
 */
function logDeviceEvent(input: {
  deviceId?: string | null;
  userId?: string | null;
  kind: string;
  data?: Record<string, unknown> | null;
}): void {
  try {
    db.prepare(
      "INSERT INTO device_events(id, device_id, user_id, kind, created_at, data) VALUES (?,?,?,?,?,?)",
    ).run(
      uid(),
      input.deviceId ?? null,
      input.userId ?? null,
      input.kind,
      nowIso(),
      input.data ? JSON.stringify(input.data) : null,
    );
  } catch {
    // Журнал не должен ронять привязку: не записалось — не повод отказать
    // владельцу в QR-коде.
  }
}

/**
 * Адрес внешнего сервера, который телефон увидит в QR.
 *
 * Задаётся переменной окружения: адрес ретранслятора — это решение владельца
 * про VPS, а не константа в коде. Если переменной нет, host пустой, и
 * приложение спросит адрес отдельно (так и задумано в §11.2).
 */
function relayBaseUrl(): string {
  return String(process.env.TASKFLOW_RELAY_BASE_URL || "").trim().replace(/\/+$/, "");
}

// Лимит по адресу считается по ПОПЫТКАМ, а не по успешным обменам.
// Поначалу здесь стоял подсчёт удачных обменов — и это была дыра: перебор
// идёт неверными кодами, ни один из них не обменивается успешно, значит
// лимит не срабатывал никогда и подбор 128-битного кода был ничем не
// ограничен. Считаем каждую попытку, успешную или нет.
/** Записать попытку обмена: нужна и для лимита, и для журнала. */
function logExchangeAttempt(ip: string, codeHash: string | null, ok: boolean): void {
  logDeviceEvent({
    kind: "pairing_exchange_attempt",
    data: { ip, code_hash: codeHash, ok },
  });
}

export function registerPairingRoutes(app: FastifyInstance) {
  // ═══════ ВЫДАЧА ОДНОРАЗОВОГО QR-КОДА ═══════
  // Владелец на доверенном клиенте (дома — вход без пароля, с другого
  // устройства — api_token). Телефон этот маршрут не зовёт.
  app.post<{ Body?: never }>(
    "/api/pairing/code",
    { preHandler: authOrApiToken, schema: { body: undefined } },
    async (req, reply) => {
      const userId = (req as any).userId as string;

      // Код для привязки выдаёт ВЛАДЕЛЕЦ (24.10.2026, аудит безопасности).
      //
      // Раньше маршрут был открыт любому авторизованному, и роль могла
      // получить код, обменять его на машинный ключ и получить удалённое
      // выполнение команд на маке-хосте. Привязка телефона — тоже дело
      // владельца: телефон привязывают к СВОЕМУ аккаунту, а роль — не
      // владелец.
      if (!isOwner(userId)) {
        return reply
          .code(403)
          .send({ error: "код привязки выдаёт только владелец" });
      }

      // Лимит на пользователя, а не на IP: у Максима телефон, браузер и все
      // агенты сидят с одного адреса, лимит по IP запер бы их вместе.
      const issued = db
        .prepare(
          "SELECT COUNT(*) AS n FROM pairing_codes WHERE created_by = ? AND created_at > ?",
        )
        .get(userId, oneHourAgoIso()) as { n: number };
      if (issued.n >= CODE_LIMIT_PER_HOUR) {
        return reply
          .code(429)
          .send({ error: "pairing_rate_limited", retry_after: 3600 });
      }

      // На экране всегда ровно один действующий QR: старый неиспользованный
      // гасим, иначе у Максима накапливалась бы пачка кодов, half из которых
      // уже никто не показывает (гасится он только обменом, а обмена может
      // не быть неделями).
      db.prepare(
        "UPDATE pairing_codes SET used_at = ? WHERE created_by = ? AND used_at IS NULL",
      ).run(nowIso(), userId);

      const code = crypto.randomBytes(CODE_BYTES).toString("hex");
      const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
      db.prepare(
        "INSERT INTO pairing_codes(id, code_hash, created_by, created_at, expires_at, used_at, source_ip) VALUES (?,?,?,?,?,NULL,?)",
      ).run(uid(), hashApiToken(code), userId, nowIso(), expiresAt, req.ip || null);

      logDeviceEvent({ userId, kind: "pairing_code_issued" });

      const base = relayBaseUrl();
      const host = base ? new URL(base).host : "";
      return {
        code,
        // Тот же формат, что ждёт приложение (§10 п.2): только адрес https и
        // никаких логина/пароля в URL — пароля в этой схеме нет вовсе.
        qr: `taskflow://pair?v=1&code=${code}&host=${encodeURIComponent(host)}`,
        expires_at: expiresAt,
        expires_in: CODE_TTL_MS / 1000,
      };
    },
  );

  // ═══════ ОБМЕН КОДА НА ТОКЕН УСТРОЙСТВА ═══════
  // Без аутентификации: предъявленный код и есть вход. Все отказы — один
  // и тот же 400 invalid_code (см. шапку файла).
  app.post<{
    Body: {
      code?: string;
      install_id?: string;
      name?: string;
      model?: string;
      os?: string;
      app_version?: string;
      /**
       * Куда обменивать код: устройство (телефон, как раньше) или машина.
       * Одна таблица pairing_codes и один обмен на оба случая — вторая
       * система рядом с готовой была бы ровно тем, чего здесь не хотим.
       */
      target?: "device" | "machine";
      /**
       * Разрешённые папки машины.
       *
       * ⚠️ Это поле НЕ является разрешением (24.10.2026, аудит безопасности).
       * Раньше корни брались прямо отсюда, и любой, у кого есть pairing-код,
       * выпускал машинный ключ с allowed_roots:["/"] — то есть удалённое
       * выполнение команд на маке-хосте (bash, read, write, edit, git_push).
       * Проверено на живом сервере: роль role_architect без прав владельца
       * обменяла код на ключ с корнем "/".
       *
       * Теперь корни для target:"machine" берутся ТОЛЬКО из реестра машин,
       * заведённого владельцем через POST /api/machines. Поле из тела запроса
       * игнорируется. Завести машину через pairing может только владелец.
       */
      allowed_roots?: string[];
    };
  }>("/api/pairing/exchange", async (req, reply) => {
    const ip = req.ip || "";

    const exchanges = db
      .prepare(
        "SELECT COUNT(*) AS n FROM device_events WHERE kind = 'pairing_exchange_attempt' AND json_extract(data, '$.ip') = ? AND created_at > ?",
      )
      .get(ip, oneHourAgoIso()) as { n: number };
    if (exchanges.n >= EXCHANGE_LIMIT_PER_IP_PER_HOUR) {
      return reply
        .code(429)
        .send({ error: "pairing_rate_limited", retry_after: 3600 });
    }

    const code = String(req.body?.code || "").trim();
    const installId = String(req.body?.install_id || "").trim();
    // Машина приходит по QR без install_id: у неё нет приложения с
    // переустановкой, вместо неё — имя и платформа.
    const цель = req.body?.target === "machine" ? "machine" : "device";
    // Обязательны только эти два; остальное телефон присылает для списка
    // устройств, и его отсутствие не должно мешать привязке.
    if (!code || (цель === "device" && !installId)) {
      logExchangeAttempt(ip, null, false);
      return reply.code(400).send({ error: "invalid_code" });
    }

    const codeHash = hashApiToken(code);
    logExchangeAttempt(ip, codeHash, false);

    const row = db
      .prepare(
        "SELECT id, created_by, expires_at, used_at FROM pairing_codes WHERE code_hash = ?",
      )
      .get(codeHash) as
      | { id: string; created_by: string; expires_at: string; used_at: string | null }
      | undefined;

    // Попыток на один код — тоже ограниченное число (в том числе успешная,
    // иначе счётчик не добрал бы до своего предела при нормальной работе).
    const попыток = db
      .prepare(
        "SELECT COUNT(*) AS n FROM device_events WHERE kind = 'pairing_exchange_attempt' AND json_extract(data, '$.code_hash') = ? AND created_at > ?",
      )
      .get(codeHash, oneHourAgoIso()) as { n: number };

    // Одинаковый ответ на «нет», «просрочен», «использован» и «много попыток»
    // — намеренно: иначе подбор по таймингу и по коду ответа только
    // упрощался бы.
    const usable =
      row &&
      row.used_at === null &&
      Date.parse(row.expires_at) > Date.now() &&
      попыток.n <= EXCHANGE_ATTEMPTS_PER_CODE;
    if (!row || !usable) {
      return reply.code(400).send({ error: "invalid_code" });
    }

    // MACHINE_BRANCH_MARKER — обмен кода на машину (правка 7 плана
    // taskflow-mac-host). Телефонное сопряжение ниже не меняется ни на
    // строчку: тот же код, тот же обмен, различается только запись.
    //
    // Три отличия от устройства, и все три существенные:
    //
    //  1. Ключ машины выпускает issueMachineKey — тот же класс секрета, что
    //     токен устройства, и в базе тоже только sha256;
    //  2. Разрешённые папки берутся с СЕРВЕРА, а не с хоста: иначе первое же
    //     подключение выдало бы роль права на весь домашний каталог без
    //     спроса. Хост может сузить пересечение, расширить — нет;
    //  3. Отзыв старой машины с тем же именем — по имени, а не по
    //     install_id: у машины его нет.
    if (цель === "machine") {
      const имя = String(req.body?.name || "").trim() || "mac";

      // Корни разрешённых папок — ИЗ РЕЕСТРА, а не из тела запроса.
      //
      // Почему (24.10.2026, аудит безопасности): раньше корни брались из
      // req.body.allowed_roots, и РОЛЬ (у которой есть свой api_token и
      // доступ к /api/pairing/code) обменивала код на машинный ключ с
      // allowed_roots:["/"] — ключ, который подключается к /host-ws и
      // получает операции bash/write/edit/git_push по всему диску машины.
      // Комментарий в коде обещал обратное («берутся с сервера, не с хоста»),
      // но обещание не было выполнено.
      //
      // Теперь: машина должна быть ЗАВЕДЕНА владельцем заранее
      // (POST /api/machines — только владелец), и обмен выдаёт ключ с теми
      // корнями, что указал владелец при заведении. Ключ с другими корнями
      // выпустить нельзя.
      const заведённая = findMachineByName(имя);
      if (!заведённая) {
        logExchangeAttempt(ip, codeHash, false);
        return reply.code(400).send({ error: "invalid_code" });
      }
      const просимые = заведённая.allowed_roots;

      // Завести новую машину через pairing может только владелец: у роли нет
      // права расширять полномочия машин. Обмен для УЖЕ ЗАВЕДЁННОЙ машины
      // (повторный ключ, переустановка хоста) допускаем всем, у кого есть
      // код — корни у такой машины всё равно те же, что задал владелец.
      const владелецКода = db
        .prepare("SELECT role, type FROM users WHERE id = ?")
        .get(row.created_by) as { role: string; type: string } | undefined;
      const кодОтВладельца =
        владелецКода?.role === "owner" || владелецКода?.type === "human";
      if (!кодОтВладельца) {
        const можетОбновить =
          db
            .prepare(
              "SELECT 1 FROM machines WHERE name = ? AND revoked_at IS NULL AND id = ?",
            )
            .get(имя, заведённая.id) !== undefined;
        if (!можетОбновить) {
          logExchangeAttempt(ip, codeHash, false);
          return reply.code(400).send({ error: "invalid_code" });
        }
      }

      let выдано: { machine: { id: string; name: string; allowed_roots: string[]; token_prefix: string }; token: string } | null = null;
      let выдача_не_прошла = false;

      db.transaction(() => {
        const burned = db
          .prepare("UPDATE pairing_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
          .run(nowIso(), row.id);
        if (burned.changes !== 1) return; // успел кто-то раньше — код уже чужой

        // Прежняя машина с тем же именем отзывается: новая привязка той же
        // машины не должна оставлять в реестре две живые записи с одним
        // именем — роль спрашивает «машина mac», и ответ стал бы
        // неоднозначным. Имена живых машин уникальны (частичный индекс,
        // миграция 142), поэтому без отзыва выпуск нового ключа упал бы.
        //
        // Корни нового ключа берутся из заведённой машины (см. выше) —
        // отзыв прежней записи на них не влияет.
        const прежние = db
          .prepare("SELECT id FROM machines WHERE name = ? AND revoked_at IS NULL")
          .all(имя) as Array<{ id: string }>;
        for (const м of прежние) {
          db.prepare(
            "UPDATE machines SET revoked_at = ?, revoke_reason = 'repaired' WHERE id = ?",
          ).run(nowIso(), м.id);
        }

        try {
          выдано = issueMachineKey({
            name: имя,
            allowedRoots: просимые,
            platform: req.body?.os ?? "darwin",
            createdBy: row.created_by,
          });
        } catch {
          // Имя занято живой машиной — отказ теми же словами, что и на
          // телефоне, чтобы клиенту не пришлось разбирать коды.
          выдача_не_прошла = true;
        }
      })();

      // Промежуточная константа: TypeScript сужает выдано до null проверкой
      // выше и дальше считает его never, хотя транзакция уже заполнила.
      const итог = выдано as { machine: { id: string; name: string; allowed_roots: string[]; token_prefix: string }; token: string } | null;
      if (выдача_не_прошла || !итог) {
        return reply.code(400).send({ error: "invalid_code" });
      }

      logDeviceEvent({
        userId: row.created_by,
        kind: "pairing_machine_exchange",
        data: { name: имя },
      });

      return {
        token: итог.token,
        token_type: "machine",
        machine_id: итог.machine.id,
        prefix: итог.machine.token_prefix,
        allowed_roots: итог.machine.allowed_roots,
        relay_base_url: relayBaseUrl(),
        issued_at: nowIso(),
      };
    }

    // Гасим код ДО выпуска токена и одной транзакцией. Иначе два
    // одновременных обмена одного кода оба прошли бы проверку и выпустили
    // два живых токена — код перестал бы быть одноразовым.
    const token = "tfd_" + crypto.randomBytes(32).toString("hex");
    const deviceId = uid();
    const granted = db.transaction(() => {
      const burned = db
        .prepare(
          "UPDATE pairing_codes SET used_at = ? WHERE id = ? AND used_at IS NULL",
        )
        .run(nowIso(), row.id);
      if (burned.changes !== 1) return false; // успел кто-то раньше — код уже чужой

      // Тот же телефон (тот же install_id) перепривязывается, а не
      // плодит устройства: прежний токен отзывается, выпускается новый.
      // Иначе переустановка приложения дала бы вторую «копию» телефона,
      // которую потом не отозвать, не отозвав настоящую.
      db.prepare(
        "UPDATE devices SET revoked_at = ?, revoke_reason = 'repaired' WHERE user_id = ? AND install_id = ? AND revoked_at IS NULL",
      ).run(nowIso(), row.created_by, installId);

      db.prepare(
        `INSERT INTO devices(id, user_id, install_id, name, model, os, app_version, token_hash, token_prefix, created_at, last_seen_at, revoked_at, revoke_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      ).run(
        deviceId,
        row.created_by,
        installId,
        req.body?.name ?? null,
        req.body?.model ?? null,
        req.body?.os ?? null,
        req.body?.app_version ?? null,
        hashApiToken(token),
        token.slice(0, 8),
        nowIso(),
        nowIso(),
      );
      return true;
    })();

    if (!granted) {
      return reply.code(400).send({ error: "invalid_code" });
    }

    logDeviceEvent({
      deviceId,
      userId: row.created_by,
      kind: "pairing_exchange",
      data: { install_id: installId, ip },
    });

    const user = db
      .prepare("SELECT id, name, role FROM users WHERE id = ?")
      .get(row.created_by) as
      | { id: string; name: string | null; role: string | null }
      | undefined;

    return {
      token,
      token_type: "device",
      device_id: deviceId,
      prefix: token.slice(0, 8),
      user: user
        ? { id: user.id, name: user.name, role: user.role }
        : null,
      relay_base_url: relayBaseUrl(),
      issued_at: nowIso(),
    };
  });
}