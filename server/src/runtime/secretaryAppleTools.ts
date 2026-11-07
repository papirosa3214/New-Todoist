import { Type } from "typebox";
import db from "../db.js";
import { DEVICE_OPS } from "../device/protocol.js";
import { liveDeviceIds, runDeviceOp } from "../ws.js";
import type { Tool } from "./universalTaskflow.js";

/**
 * Apple Напоминания и Apple Календарь для Помощника владельца (21.10.2026).
 *
 * Зачем так: данные лежат только на айфоне (EventKit в нативном клиенте), а
 * роль работает на сервере .110. Зеркала Apple-данных на сервере не заводим —
 * вторая правда разошлась бы с телефоном при первом же изменении списка.
 * Поэтому здесь нет своего кода доступа: инструмент только спрашивает у
 * телефона операцию `reminder.*` / `calendar.*` и отдаёт ответ как есть.
 * Ровно как с Things 3, только вместо макины — устройство.
 *
 * Кому: только secretary. Это личный помощник владельца — тот же принцип,
 * что у почты (`secretaryMailTools`) и у дел (`secretaryThings3Tools`): доступ
 * к личному календарю и напоминаниям есть у помощника, а не у всей команды.
 *
 * Удаление: `apple_reminders_delete` в каталоге остаётся (модель должна
 * видеть, что такая операция есть и что она НЕДОСТУПНА), но право роли
 * (`roleToolScope.ts`) режет любое имя с delete/purge/remove. Дополнительно
 * сам инструмент ничего не стирает и отвечает честным отказом.
 */

/** Имена операций в общем каталоге — по ним модель их находит. */
export const APPLE_TOOL_NAMES = [
  "apple_reminders_create",
  "apple_reminders_list",
  "apple_reminders_complete",
  "apple_reminders_reschedule",
  "apple_reminders_delete",
  "apple_calendar_agenda",
  "apple_calendar_create",
  "apple_calendar_update",
] as const;

export interface AppleToolsContext {
  role: string;
  taskId?: string;
  subtaskId?: string;
  chatId?: string;
  messageId?: string;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

// ── Выбор устройства ─────────────────────────────────────────────────────
//
// Устройство выбирается по живому сокету: телефон может быть спарен, но
// лежать в кармане с закрытым приложением — тогда операция не уйдёт.
// Несколько живых устройств — операция не угадывает: «что у меня в
// календаре» с двух разных телефонов даст две разные правды.

type Устройство = { id: string; name: string };

function живыеУстройства(): Устройство[] {
  const ids = liveDeviceIds();
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const строки = db
    .prepare(
      `SELECT d.id AS id, d.name AS name, d.revoked_at AS revoked_at,
              u.role AS role, u.role_key AS role_key
         FROM devices d
         JOIN users u ON u.id = d.user_id
        WHERE d.id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: string;
    name: string | null;
    revoked_at: string | null;
    role: string;
    role_key: string | null;
  }>;
  const поБазе = new Map(строки.map((строка) => [строка.id, строка]));
  const живые: Устройство[] = [];
  for (const id of ids) {
    const строка = поБазе.get(id);
    if (строка?.revoked_at) continue; // устройство отозвано
    // Данные Apple — личные данные владельца: чужие устройства в прокси не
    // идут.
    if (
      строка &&
      строка.role !== "owner" &&
      строка.role_key !== "secretary"
    )
      continue;
    живые.push({ id, name: строка?.name || "айфон" });
  }
  return живые;
}

function устройствоВладельца(): Устройство {
  const живые = живыеУстройства();
  if (!живые.length) {
    throw new Error(
      "Телефон владельца сейчас не на связи: приложение TaskFlow на айфоне свёрнуто или телефон вне сети. " +
        "Попроси владельца открыть TaskFlow на айфоне и повторить — операция уходит на телефон и ждёт ответа.",
    );
  }
  if (живые.length > 1) {
    throw new Error(
      `У владельца несколько подключённых устройств (${живые.map((у) => у.name).join(", ")}). ` +
        "Операция не угадывает, на каком работать: попроси владельца отозвать лишнее устройство или назвать нужное.",
    );
  }
  return живые[0];
}

// ── Отказы устройства → понятный текст для роли ──────────────────────────

const ОТКАЗЫ: Record<string, string> = {
  access_denied:
    "На айфоне нет доступа к Напоминаниям или Календарю: владелец должен выдать доступ в приложении (Настройки → Напоминания / Календарь).",
  not_found:
    "На айфоне нет такого напоминания или события: возможно, его уже закрыли, перенесли или удалили.",
  invalid_arguments:
    "Айфон не принял параметры операции: проверь формат даты (ISO 8601 с часовым поясом, например 2026-10-22T09:00:00+03:00) и названия.",
  op_unknown:
    "Приложение на айфоне не умеет эту операцию: нужно обновить TaskFlow на телефоне.",
  version_unsupported:
    "Приложение на айфоне старее нужного: обнови TaskFlow на телефоне.",
  timeout: "Айфон не ответил вовремя.",
  internal: "На айфоне произошла ошибка.",
};

function отказУстройства(ошибка: { code: string; message: string }): Error {
  const основа = ОТКАЗЫ[ошибка.code] ?? "Айфон не выполнил операцию.";
  const деталь = ошибка.message ? ` Текст с телефона: ${ошибка.message}` : "";
  return new Error(`${основа} (код: ${ошибка.code}).${деталь}`);
}

// ── Форматирование ответа устройства ─────────────────────────────────────

// Зона владельца: даты в ответах показываем в местном времени, без «UTC»
// и без мусорного хвоста вида «:00Z» (дефект QA 22.10).
const ЗОНА_ВЛАДЕЛЬЦА = process.env.TASKFLOW_TIMEZONE || "Europe/Moscow";

const ФОРМАТ_ЗОНЫ = new Intl.DateTimeFormat("en-GB", {
  timeZone: ЗОНА_ВЛАДЕЛЬЦА,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Дата и время момента в зоне владельца: «24.10.2026 10:00». */
function вЗонеВладельца(момент: Date): string {
  const части = new Map<string, string>();
  for (const часть of ФОРМАТ_ЗОНЫ.formatToParts(момент)) {
    if (часть.type !== "literal") части.set(часть.type, часть.value);
  }
  const год = части.get("year") ?? "";
  const месяц = части.get("month") ?? "";
  const день = части.get("day") ?? "";
  const час = части.get("hour") ?? "";
  const минута = части.get("minute") ?? "";
  return `${день}.${месяц}.${год} ${час}:${минута}`;
}

function дата(значение: unknown): string {
  const s = String(значение ?? "").trim();
  if (!s) return "без срока";
  const разбор = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?(.*)$/.exec(s);
  if (!разбор) return s;
  const [, год, месяц, день, час, минута, хвост] = разбор;
  const когда = `${день}.${месяц}.${год}`;
  if (!час) return когда; // дата без времени (весь день) — время не выдумываем
  // Время без явной зоны не переводим: иначе сдвинем момент на час назад.
  const зонаЯвная = /(?:Z|[+-]\d{2}:?\d{2})$/.test(хвост);
  if (!зонаЯвная) return `${когда} ${час}:${минута}`;
  const момент = new Date(s);
  if (Number.isNaN(момент.getTime())) return `${когда} ${час}:${минута}`;
  return вЗонеВладельца(момент);
}

function названиеСписка(списки: any[], id: unknown): string {
  const строка = списки.find((с: any) => с && (с.id === id || с.title === id));
  if (строка?.title) return `список «${строка.title}»`;
  if (id) return `список ${id}`;
  return "";
}

function форматНапоминаний(data: any): string {
  const напоминания = Array.isArray(data?.reminders) ? data.reminders : [];
  const списки = Array.isArray(data?.lists) ? data.lists : [];
  if (!напоминания.length) {
    const перечень = списки.length
      ? ` Списки на айфоне: ${списки.map((с: any) => `«${с?.title ?? с?.id}»`).join(", ")}.`
      : "";
    return `Напоминаний нет.${перечень}`;
  }
  const строки = напоминания.map((н: any, i: number) => {
    const когда = н?.dueDate ? дата(н.dueDate) : "без срока";
    const список = названиеСписка(списки, н?.listId ?? н?.list);
    const состояние = н?.isCompleted ? "выполнено" : "не выполнено";
    const заметка = н?.notes ? `, заметка: ${н.notes}` : "";
    return `${i + 1}. [id: ${н?.id}] ${н?.title ?? "(без текста)"} — ${когда}${список ? `, ${список}` : ""}, ${состояние}${заметка}`;
  });
  const шапка = `Напоминания (${напоминания.length}):`;
  const подсказка =
    "\nИдентификатор в квадратных скобках нужен для закрытия и переноса (apple_reminders_complete, apple_reminders_reschedule).";
  return `${шапка}\n${строки.join("\n")}${подсказка}`;
}

function форматСобытий(data: any): string {
  const события = Array.isArray(data?.events) ? data.events : [];
  if (!события.length) {
    const календари = Array.isArray(data?.calendars) ? data.calendars : [];
    const перечень = календари.length
      ? ` Календари: ${календари.map((к: any) => `«${к?.title ?? к?.id}»`).join(", ")}.`
      : "";
    return `Событий нет.${перечень}`;
  }
  const строки = события.map((с: any, i: number) => {
    const начало = дата(с?.start);
    const конец = с?.end ? `–${дата(с.end).split(" ").pop()}` : "";
    const календарь = с?.calendarTitle ? `, календарь «${с.calendarTitle}»` : "";
    const место = с?.location ? `, место «${с.location}»` : "";
    const заметка = с?.notes ? `, заметка: ${с.notes}` : "";
    const всеДень = с?.isAllDay ? ", весь день" : "";
    return `${i + 1}. [id: ${с?.id}] ${с?.title ?? "(без названия)"} — ${начало}${конец}${календарь}${место}${всеДень}${заметка}`;
  });
  const шапка = `События (${события.length}):`;
  const подсказка =
    "\nИдентификатор в квадратных скобках нужен для переноса и отмены (apple_calendar_update).";
  return `${шапка}\n${строки.join("\n")}${подсказка}`;
}

function форматСоздания(что: string, data: any): string {
  const id = data?.id ? ` (id: ${data.id})` : "";
  const название = data?.title ? `«${data.title}»` : "";
  const когда = data?.dueDate ? `, срок: ${дата(data.dueDate)}` : "";
  const начало = data?.start ? `, начало: ${дата(data.start)}` : "";
  const конец = data?.end ? `, конец: ${дата(data.end)}` : "";
  return `${что}: ${название}${id}${когда}${начало}${конец}.`;
}

// ── Схемы параметров ──────────────────────────────────────────────────────

const схемаДаты = (что: string) =>
  Type.String({
    description:
      `${что}: ISO 8601 с часовым поясом, например 2026-10-22T09:00:00+03:00; без времени — только дата 2026-10-22`,
  });

const idНапоминания = Type.String({
  description:
    "Идентификатор напоминания из apple_reminders_list (Apple calendarItemIdentifier)",
});

// ── Операции ──────────────────────────────────────────────────────────────

type AppleOp = {
  /** Операция на устройстве. */
  op: string;
  /** Что делать с аргументами инструмента перед отправкой. */
  args: (p: Record<string, unknown>) => Record<string, unknown>;
  /** Как показать ответ устройства. */
  format: (data: any) => string;
  /** Поля, которые операция понимает. */
  поля: string[];
  /** Поля без которых операция бессмысленна. */
  обязательные: string[];
  /** Образец правильного вызова — в отказе, а не только в описании. */
  пример: Record<string, unknown>;
};

/** Убрать незаполненные поля: телефон не должен получать мусор. */
function толькоЗаданные(объект: Record<string, unknown>): Record<string, unknown> {
  const итог: Record<string, unknown> = {};
  for (const [ключ, значение] of Object.entries(объект)) {
    if (значение === undefined || значение === null || значение === "") continue;
    итог[ключ] = значение;
  }
  return итог;
}

const ОПЕРАЦИИ: Record<string, AppleOp> = {
  // Удаления (apple_reminders_delete) здесь нет: стирание недоступно
  // Помощнику, в контракт канала оно не входит, а сам инструмент отвечает
  // честным отказом (см. ниже).
  apple_reminders_create: {
    op: DEVICE_OPS.reminderCreate,
    args: (p) =>
      толькоЗаданные({
        title: p.title,
        dueDate: p.dueDate,
        list: p.list,
        notes: p.notes,
        priority: p.priority,
      }),
    format: (data) => форматСоздания("Напоминание создано", data),
    поля: ["title", "dueDate", "list", "notes", "priority"],
    обязательные: ["title"],
    пример: {
      title: "Позвонить в сервис",
      dueDate: "2026-10-22T09:00:00+03:00",
    },
  },
  apple_reminders_list: {
    op: DEVICE_OPS.reminderList,
    args: (p) =>
      толькоЗаданные({
        list: p.list,
        from: p.from,
        to: p.to,
        includeCompleted: p.includeCompleted,
      }),
    format: форматНапоминаний,
    поля: ["list", "from", "to", "includeCompleted"],
    обязательные: [],
    пример: { from: "2026-10-22T00:00:00+03:00", to: "2026-10-22T23:59:59+03:00" },
  },
  apple_reminders_complete: {
    op: DEVICE_OPS.reminderComplete,
    args: (p) => ({ id: p.id }),
    format: (data) =>
      `Напоминание закрыто галочкой${data?.id ? ` (id: ${data.id})` : ""}. Оно остаётся в выполненных.`,
    поля: ["id"],
    обязательные: ["id"],
    пример: { id: "идентификатор из apple_reminders_list" },
  },
  apple_reminders_reschedule: {
    op: DEVICE_OPS.reminderReschedule,
    args: (p) => ({ id: p.id, dueDate: p.dueDate }),
    format: (data) =>
      `Напоминание перенесено${data?.dueDate ? ` на ${дата(data.dueDate)}` : ""}${data?.id ? ` (id: ${data.id})` : ""}.`,
    поля: ["id", "dueDate"],
    обязательные: ["id", "dueDate"],
    пример: { id: "идентификатор из apple_reminders_list", dueDate: "2026-10-23T10:00:00+03:00" },
  },
  apple_calendar_agenda: {
    op: DEVICE_OPS.calendarEvents,
    args: (p) =>
      толькоЗаданные({ from: p.from, to: p.to, calendarId: p.calendarId }),
    format: форматСобытий,
    поля: ["from", "to", "calendarId"],
    обязательные: [],
    пример: { from: "2026-10-22T00:00:00+03:00", to: "2026-10-22T23:59:59+03:00" },
  },
  apple_calendar_create: {
    op: DEVICE_OPS.calendarEventCreate,
    args: (p) =>
      толькоЗаданные({
        title: p.title,
        start: p.start,
        end: p.end,
        calendar: p.calendar,
        location: p.location,
        notes: p.notes,
        alertMinutesBefore: p.alertMinutesBefore,
      }),
    format: (data) => форматСоздания("Встреча создана", data),
    поля: [
      "title",
      "start",
      "end",
      "calendar",
      "location",
      "notes",
      "alertMinutesBefore",
    ],
    обязательные: ["title", "start"],
    пример: { title: "Встреча с врачом", start: "2026-10-22T15:00:00+03:00", end: "2026-10-22T16:00:00+03:00" },
  },
  apple_calendar_update: {
    op: DEVICE_OPS.calendarEventUpdate,
    args: (p) =>
      толькоЗаданные({
        id: p.id,
        start: p.start,
        end: p.end,
        title: p.title,
        location: p.location,
        notes: p.notes,
        cancelled: p.cancelled,
      }),
    format: (data) =>
      data?.cancelled
        ? `Встреча отменена${data?.id ? ` (id: ${data.id})` : ""}.`
        : `Встреча перенесена или изменена${data?.start ? `, начало: ${дата(data.start)}` : ""}${data?.end ? `, конец: ${дата(data.end)}` : ""}${data?.id ? ` (id: ${data.id})` : ""}.`,
    поля: ["id", "start", "end", "title", "location", "notes", "cancelled"],
    обязательные: ["id"],
    пример: { id: "идентификатор из apple_calendar_agenda", start: "2026-10-22T16:00:00+03:00" },
  },
};

/** Поля-даты: значение должно быть ISO 8601, иначе телефон его не поймёт. */
const ПОЛЯ_ДАТЫ = new Set(["dueDate", "from", "to", "start", "end"]);

/**
 * Проверить вызов ДО отправки: пропущенное обязательное поле или кривая
 * дата — это ошибка вызова, а не данных. Без такой проверки модель могла бы
 * создать напоминание без срока (поле называлось не так) и потом сказать
 * владельцу «напомнил» — а напоминать было не о чем.
 */
function проверитьВызов(операция: AppleOp, p: Record<string, unknown>): void {
  const отсутствуют = операция.обязательные.filter(
    (поле) => p[поле] === undefined || p[поле] === null || p[поле] === "",
  );
  const лишние = Object.keys(p).filter((поле) => !операция.поля.includes(поле));
  const криваяДата = операция.поля.find(
    (поле) =>
      ПОЛЯ_ДАТЫ.has(поле) &&
      p[поле] !== undefined &&
      !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(String(p[поле])),
  );
  if (!отсутствуют.length && !криваяДата && !лишние.length) return;
  const части: string[] = [];
  if (отсутствуют.length) {
    части.push(`не хватает полей: ${отсутствуют.join(", ")}`);
  }
  if (криваяДата) {
    части.push(
      `поле ${криваяДата} — это не дата: нужен ISO 8601 с часовым поясом, например 2026-10-22T09:00:00+03:00`,
    );
  }
  if (лишние.length) {
    части.push(`поля вне схемы: ${лишние.join(", ")}`);
  }
  throw new Error(
    `${части.join("; ")}. Правильный вызов: ${JSON.stringify(операция.пример)}. ` +
      "Исправь вызов по образцу — это ошибка вызова, а не поломка телефона.",
  );
}

export function secretaryAppleTools(context: AppleToolsContext): Tool[] {
  void context;

  const выполнить = async (
    имя: string,
    p: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const операция = ОПЕРАЦИИ[имя];
    if (!операция) {
      throw new Error(
        `«${имя}» — не операция Apple. Доступны: ${APPLE_TOOL_NAMES.join(", ")}`,
      );
    }
    // Сначала проверка вызова, потом телефон: ошибка вызова не зависит от
    // того, на связи айфон или нет, иначе модель будет получать «телефон
    // офлайн» вместо подсказки «не хватает поля».
    проверитьВызов(операция, p ?? {});
    const устройство = устройствоВладельца();
    const ответ = await runDeviceOp(
      устройство.id,
      операция.op,
      операция.args(p ?? {}),
      { signal },
    );
    if (!ответ.ok) throw отказУстройства(ответ.error);
    return text(операция.format(ответ.data));
  };

  return [
    {
      name: "apple_reminders_create",
      description:
        "Напомни мне в указанное время — создай напоминание в Apple Напоминаниях на айфоне.\n" +
        "Примеры владельца: «напомни мне завтра в 9 про налоговую», «запиши напоминалку купить хлеб», «напомни про врача 15 октября в 14:00».\n" +
        "Поля: title — текст напоминания (обязательно); dueDate — когда напомнить, ISO 8601 с часовым поясом, например 2026-10-22T09:00:00+03:00; list — список напоминаний, например «Семья»; notes — заметка; priority — приоритет 0–9.\n" +
        "Синонимы: напомни, напоминалка, напоминание, «напомни мне».",
      parameters: Type.Object({
        title: Type.String({ description: "Текст напоминания" }),
        dueDate: Type.Optional(схемаДаты("Когда напомнить")),
        list: Type.Optional(
          Type.String({ description: "Список напоминаний, например «Семья»" }),
        ),
        notes: Type.Optional(Type.String({ description: "Заметка к напоминанию" })),
        priority: Type.Optional(
          Type.Number({ description: "Приоритет 0–9 (EventKit)" }),
        ),
      }),
      execute: async (_id, p, signal) =>
        выполнить("apple_reminders_create", p, signal),
    },
    {
      name: "apple_reminders_list",
      description:
        "Покажи мои напоминания за указанный период — что у меня по напоминаниям.\n" +
        "Примеры владельца: «что у меня по напоминаниям?», «что у меня сегодня по напоминаниям», «покажи на неделю», «покажи напоминалки из списка Семья».\n" +
        "Поля: from — начало периода, ISO 8601; to — конец периода, ISO 8601; list — список напоминаний; includeCompleted — true, чтобы показать и выполненные.\n" +
        "В ответе есть идентификаторы напоминаний: они нужны, чтобы закрыть или перенести напоминание.\n" +
        "Синонимы: напоминания, напоминалка, «что по напоминаниям», «покажи напоминания».",
      parameters: Type.Object({
        from: Type.Optional(схемаДаты("Начало периода")),
        to: Type.Optional(схемаДаты("Конец периода")),
        list: Type.Optional(
          Type.String({ description: "Список напоминаний, например «Семья»" }),
        ),
        includeCompleted: Type.Optional(
          Type.Boolean({ description: "Показать и выполненные напоминания" }),
        ),
      }),
      execute: async (_id, p, signal) =>
        выполнить("apple_reminders_list", p, signal),
    },
    {
      name: "apple_reminders_complete",
      description:
        "Отметь напоминание выполненным прямо сейчас — закрой галочкой.\n" +
        "Примеры владельца: «напоминание про таблетки выполнено», «закрой напоминание про налоговую», «отметь как сделал».\n" +
        "Поля: id — идентификатор напоминания из apple_reminders_list (обязательно).\n" +
        "Важно: это ЗАКРЫТИЕ, напоминание остаётся в выполненных. УДАЛЕНИЕ НЕДОСТУПНО — если владелец просит «удали напоминание», скажи прямо: стирать надо руками на айфоне (Напоминания → напоминание → удалить), а через Помощника доступно закрыть (эта операция) или перенести (apple_reminders_reschedule).\n" +
        "Синонимы: выполнено, закрыть, сделал, готово, отметь, напоминалка.",
      parameters: Type.Object({
        id: idНапоминания,
      }),
      execute: async (_id, p, signal) =>
        выполнить("apple_reminders_complete", p, signal),
    },
    {
      name: "apple_reminders_reschedule",
      description:
        "Перенеси напоминание на другое время — сдвинь дату и час.\n" +
        "Примеры владельца: «перенеси напоминание на пятницу», «отложи напомниналку на час», «перенеси напоминание про врача на завтра в 10».\n" +
        "Поля: id — идентификатор напоминания из apple_reminders_list (обязательно); dueDate — новое время, ISO 8601 с часовым поясом (обязательно).\n" +
        "Важно: УДАЛЕНИЕ НЕДОСТУПНО — если владелец просит «удали напоминание», скажи прямо: стирать надо руками на айфоне (Напоминания → напоминание → удалить), а через Помощника доступно закрыть (apple_reminders_complete) или перенести (эта операция).\n" +
        "Синонимы: перенеси, отложи, напомни позже, напоминалка.",
      parameters: Type.Object({
        id: idНапоминания,
        dueDate: схемаДаты("Новое время напоминания"),
      }),
      execute: async (_id, p, signal) =>
        выполнить("apple_reminders_reschedule", p, signal),
    },
    {
      name: "apple_reminders_delete",
      description:
        "Удали напоминание прямо сейчас — сотри без следа.\n" +
        "ВНИМАНИЕ: УДАЛЕНИЕ НЕДОСТУПНО. У Помощника нет операции удаления: право роли закрывает стирание, и вызов ничего не стирает. Что делать вместо этого: закрыть напоминание (apple_reminders_complete) или перенести его на другое время (apple_reminders_reschedule). Владельцу скажи прямо: удалить напоминание можно только руками на айфоне (Напоминания → напоминание → удалить) — не говори, что удалил.\n" +
        "Синонимы: удали, сотри, выкинь, снеси, напоминалка.",
      parameters: Type.Object({
        id: idНапоминания,
      }),
      execute: async () => {
        // Страховка вторым слоем: даже если право роли когда-нибудь расширят,
        // удаление всё равно не выполнится — только честный отказ.
        throw new Error(
          "Удаление недоступно: Помощник не стирает напоминания. Предложи закрыть напоминание " +
            "(apple_reminders_complete) или перенести его (apple_reminders_reschedule) и скажи владельцу, " +
            "что удалить напоминание можно только руками на айфоне (Напоминания → напоминание → удалить).",
        );
      },
    },
    {
      name: "apple_calendar_agenda",
      description:
        "Покажи мою повестку за указанный день — что у меня в календаре.\n" +
        "Примеры владельца: «что у меня в календаре?», «что у меня завтра», «как выглядит мой четверг», «покажи встречи на неделю».\n" +
        "Поля: from — начало периода, ISO 8601; to — конец периода, ISO 8601; calendarId — конкретный календарь, если нужен.\n" +
        "В ответе есть идентификаторы событий: они нужны, чтобы перенести или отменить встречу.\n" +
        "Синонимы: календарь, повестка, встреча, событие, «что у меня завтра».",
      parameters: Type.Object({
        from: Type.Optional(схемаДаты("Начало периода")),
        to: Type.Optional(схемаДаты("Конец периода")),
        calendarId: Type.Optional(
          Type.String({ description: "Календарь, если нужен конкретный" }),
        ),
      }),
      execute: async (_id, p, signal) =>
        выполнить("apple_calendar_agenda", p, signal),
    },
    {
      name: "apple_calendar_create",
      description:
        "Поставь встречу на указанное время — создай событие в Apple Календаре на айфоне.\n" +
        "Примеры владельца: «поставь встречу завтра в 15:00 на час», «создай событие в четверг в 18:00, Дом», «добавь встречу с врачом в пятницу в 11».\n" +
        "Поля: title — название встречи (обязательно); start — начало, ISO 8601 с часовым поясом (обязательно); end — конец, ISO 8601 (по умолчанию час); calendar — календарь; location — место; notes — заметка; alertMinutesBefore — за сколько минут напомнить.\n" +
        "Синонимы: встреча, событие, «поставь встречу», «создай встречу».",
      parameters: Type.Object({
        title: Type.String({ description: "Название встречи" }),
        start: схемаДаты("Начало встречи"),
        end: Type.Optional(схемаДаты("Конец встречи")),
        calendar: Type.Optional(
          Type.String({ description: "Календарь, например «Личный»" }),
        ),
        location: Type.Optional(Type.String({ description: "Место встречи" })),
        notes: Type.Optional(Type.String({ description: "Заметка к встрече" })),
        alertMinutesBefore: Type.Optional(
          Type.Number({ description: "Напомнить за сколько минут до начала" }),
        ),
      }),
      execute: async (_id, p, signal) =>
        выполнить("apple_calendar_create", p, signal),
    },
    {
      name: "apple_calendar_update",
      description:
        "Перенеси или отмени встречу в указанное время — сдвинь начало и конец.\n" +
        "Примеры владельца: «перенеси встречу на час позже», «отмени обед», «передвинь событие на завтра в 12».\n" +
        "Поля: id — идентификатор события из apple_calendar_agenda (обязательно); start — новое начало, ISO 8601; end — новый конец, ISO 8601; title — новое название; location — новое место; notes — заметка; cancelled — true, чтобы отменить встречу.\n" +
        "Синонимы: встреча, событие, перенеси, отмени, передвинь.",
      parameters: Type.Object({
        id: Type.String({
          description:
            "Идентификатор события из apple_calendar_agenda (Apple calendarItemIdentifier)",
        }),
        start: Type.Optional(схемаДаты("Новое начало встречи")),
        end: Type.Optional(схемаДаты("Новый конец встречи")),
        title: Type.Optional(Type.String({ description: "Новое название встречи" })),
        location: Type.Optional(Type.String({ description: "Новое место встречи" })),
        notes: Type.Optional(Type.String({ description: "Новая заметка" })),
        cancelled: Type.Optional(
          Type.Boolean({ description: "true — отменить встречу" }),
        ),
      }),
      execute: async (_id, p, signal) =>
        выполнить("apple_calendar_update", p, signal),
    },
  ];
}
