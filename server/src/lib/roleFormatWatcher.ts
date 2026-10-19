// Сторож формата ответов ролей (карточка cea8d997, правило приборов и
// сторожей из INDEX.md: «если построен прибор — на него обязана быть
// проверка, а проверка обязана быть в docs/watchers.md»).
//
// Что проверяет. Формат ответа роли — прибор, которым рисует всё приложение:
// один и тот же ответ показывается в чате, ленте, комментарии, результате
// шага, описании и итоге задачи. Ломается он тихо: блок с неизвестным типом
// или лишним полем проходит мимо нормализатора (его задача — привести старый
// формат, а не проверять новый), роль видит на телефоне «виджет не
// разработан», а сервер считает, что всё в порядке.
//
// Как проверяет. Раз в сутки (и при старте сервера) каждый тип блока из
// каталога lib/widgetContract.ts собирается по контракту и проходит весь
// путь: пример → текст роли → нормализация → проверка по каталогу. Плюс
// три автозамены на живых примерах: таблица Markdown, ряд «название: число»
// и ряд чисел по датам. Это не «структура на месте», а настоящий проход
// данных по тому же коду, который стоит в четырёх маршрутах.
//
// При поломке — уведомление владельцу в «Состояние системы», не карточка
// (владелец 13.10.2026: тревоги-карточки — шум на доске), и не чаще одного
// раза в сутки.

import crypto from "node:crypto";

import db from "../db.js";
import {
  ALL_WIDGET_TYPE_SPECS,
  widgetExample,
  widgetExampleFence,
  type NewWidgetTypeSpec,
} from "./widgetContract.js";
import { applyRoleFormat } from "./roleFormat.js";

export const ROLE_FORMAT_WATCH_TYPE = "role_format_watch";

export interface RoleFormatWatchResult {
  ok: boolean;
  /** Что именно не прошло: тип блока или автозамена. */
  failures: string[];
}

function sampleFromSpec(spec: NewWidgetTypeSpec): string | null {
  // Погоду собирает только инструмент: подставлять её вручную нечего, но
  // блок всё равно должен проходить путь целиком.
  const json = widgetExample(spec.type);
  return json ? "```widget\n" + json + "\n```" : null;
}

/**
 * Проба формата: каждый тип из каталога проходит нормализацию и проверку,
 * автозамены проверяются на живых примерах. Ничего не пишет в базу.
 */
export function checkRoleFormat(): RoleFormatWatchResult {
  const failures: string[] = [];

  for (const spec of ALL_WIDGET_TYPE_SPECS) {
    const block = sampleFromSpec(spec);
    if (!block) {
      failures.push(`${spec.type}: нет примера в каталоге`);
      continue;
    }
    const result = applyRoleFormat(block);
    if (result.problems.length) {
      failures.push(`${spec.type}: ${result.problems[0].path} — ${result.problems[0].message}`);
      continue;
    }
    // Пример обязан пережить нормализацию без потерь: иначе клиент получит
    // не то, что показал сервер в ошибке (дефект D1 в новой оболочке).
    if (!result.text.includes('"type": "' + spec.type + '"')) {
      failures.push(`${spec.type}: блок потерял имя типа при нормализации`);
    }
  }

  const cases: { name: string; text: string; expect: string }[] = [
    {
      name: "таблица Markdown",
      text: ["| Проверка | Результат |", "| --- | --- |", "| tsc | чисто |", "| тесты | 12/12 |"].join("\n"),
      expect: '"type": "table"',
    },
    {
      name: "ряд «название: число»",
      text: ["Задач: 12", "Проверок: 7", "Дефектов: 0"].join("\n"),
      expect: '"type": "metrics"',
    },
    {
      name: "ряд чисел по датам",
      text: ["2026-10-01: 4", "2026-10-02: 9", "2026-10-03: 6"].join("\n"),
      expect: '"type": "chart"',
    },
  ];
  for (const item of cases) {
    const result = applyRoleFormat(item.text);
    if (result.problems.length) {
      failures.push(`автозамена «${item.name}»: ${result.problems[0].message}`);
      continue;
    }
    if (!result.autoReplaced.length || !result.text.includes(item.expect)) {
      failures.push(`автозамена «${item.name}»: блок ${item.expect} не появился`);
    }
  }

  // Отказ должен возвращать образец: без него роль не знает, что прислать.
  const refusal = applyRoleFormat("```widget\n{это не json}\n```");
  if (!refusal.problems.length) {
    failures.push("битый JSON принят как корректный блок");
  } else if (!refusal.problems[0].sample.includes("```widget")) {
    failures.push("в отказе нет образца правильного блока");
  }

  return { ok: failures.length === 0, failures };
}

/** Уведомление в «Состояние системы» — не чаще одного раза в сутки. */
function alert(reason: string): void {
  const already = db
    .prepare(
      "SELECT 1 FROM notifications WHERE type = ? AND created_at >= datetime('now','-1 day') LIMIT 1",
    )
    .get(ROLE_FORMAT_WATCH_TYPE);
  if (already) return;
  const owners = db.prepare("SELECT id FROM users WHERE role = 'owner'").all() as { id: string }[];
  const text =
    "Формат ответов ролей сломан: роли рисуют блоки, которые клиент не понимает. " +
    reason +
    " Проверить lib/roleFormat.ts и выполнить checkRoleFormat.";
  for (const owner of owners) {
    db.prepare("INSERT INTO notifications (id, user_id, type, text) VALUES (?,?,?,?)").run(
      crypto.randomUUID(),
      owner.id,
      ROLE_FORMAT_WATCH_TYPE,
      text.slice(0, 400),
    );
  }
}

export function startRoleFormatWatcher(): () => void {
  const check = (): void => {
    const result = checkRoleFormat();
    if (!result.ok) alert(result.failures.join("; "));
  };
  check();
  const timer = setInterval(check, 24 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Образец блока по типу — для тестов сторожа и документации. */
export { widgetExampleFence };