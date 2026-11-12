// Виджет вопроса роли для Telegram (Bot API 10.4, method sendWidget).
//
// Один вопрос — одно сообщение Telegram: и текст, и варианты живут внутри
// виджета. Отдельная текстовая доставка с тем же вопросом не ставится — именно
// она и была дублем, который владелец видел перед карточкой.
//
// Разметка — самодостаточный HTML без сети: только инлайн <style>, кнопки
// локальные, ответ уходит обычным сообщением в чат (кнопки widget_query на
// сервере пока не принимаются — новый транспорт не появляется «наполовину»).
import zlib from "node:zlib";

import type { AnswerPayload, QuestionPayload } from "./chatQuestions.js";

/** Лимиты Telegram для sendWidget: HTML ≤ 32768 байт, после zlib-9 ≤ 4096. */
export const WIDGET_HTML_LIMIT = 32_768;
export const WIDGET_PACKED_LIMIT = 4096;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Текст вопроса без разметки — им же заполняется свёрнутая строка. */
export function questionPlainText(payload: QuestionPayload): string {
  const first = payload.questions[0];
  return first ? String(first.question) : "";
}

/** Строка «Вопрос: … → Ответ: …» для ленты после ответа. */
export function foldedQuestionText(payload: QuestionPayload, answer?: AnswerPayload | null): string {
  const parts: string[] = [];
  payload.questions.forEach((вопрос, номер) => {
    const запись = answer?.answers?.find((item) => item.questionIndex === номер);
    const выбранное = запись ? [...запись.selected, запись.custom ?? ""].filter(Boolean).join(", ") : "";
    parts.push(`Вопрос: ${вопрос.question}${выбранное ? ` → Ответ: ${выбранное}` : ""}`);
  });
  return parts.join("\n");
}

/** Живой виджет вопроса: заголовок, варианты, подпись «ответь в чате». */
export function questionWidgetHtml(payload: QuestionPayload): string {
  const blocks = payload.questions.slice(0, 4).map((вопрос, номер) => {
    const header = вопрос.header ? `<div class="h">${escapeHtml(вопрос.header)}</div>` : "";
    const options = вопрос.options
      .map(
        (вариант) =>
          `<li><b>${escapeHtml(вариант.label)}</b>${вариант.description ? `<span>${escapeHtml(вариант.description)}</span>` : ""}</li>`,
      )
      .join("");
    return `<div class="q">${header}<div class="t">${номер + 1}. ${escapeHtml(вопрос.question)}</div><ul>${options}</ul></div>`;
  });
  const note = payload.note ? `<div class="n">${escapeHtml(payload.note)}</div>` : "";
  const html = `<html><head><meta charset="utf-8"><style>
body{margin:0;padding:10px;font:13px -apple-system,system-ui,sans-serif;color:var(--tg-theme-text-color,#eee)}
.q{margin-bottom:8px}.t{font-weight:600;font-size:14px}
.h{font-size:11px;opacity:.6;margin-bottom:2px}
ul{margin:6px 0 0;padding-left:18px}li{margin:3px 0}li span{display:block;font-size:11px;opacity:.65}
.n{font-size:11px;opacity:.7;margin-top:6px}
.f{font-size:11px;opacity:.6;margin-top:8px}
</style></head><body>${blocks.join("")}${note}<div class="f">Ответь в чате — продолжу с этого места.</div></body></html>`;
  return fitWidgetHtml(html);
}

/**
 * Подогнать HTML под лимиты sendWidget: сырые 32768 байт и 4096 после zlib-9.
 * Перебор — не повод терять вопрос: режем подписи вариантов, а не молчим.
 */
export function fitWidgetHtml(html: string): string {
  let current = html;
  for (let step = 0; step < 6; step++) {
    const raw = Buffer.byteLength(current, "utf8");
    const packed = zlib.deflateSync(current, { level: 9 }).length;
    if (raw <= WIDGET_HTML_LIMIT && packed <= WIDGET_PACKED_LIMIT) return current;
    // Каждый шаг отрезает по одной строке описания — текст вопроса остаётся.
    const cut = current.replace(/<li>.*?<span>.*?<\/span><\/li>/s, "");
    if (cut === current) break;
    current = cut;
  }
  return current;
}

/** Свёрнутый вид после ответа: статичный текст вместо живого виджета. */
export function foldedQuestionHtml(payload: QuestionPayload, answer?: AnswerPayload | null): string {
  const text = foldedQuestionText(payload, answer);
  const lines = text.split("\n").map((line) => `<div class="r">${escapeHtml(line)}</div>`).join("");
  return fitWidgetHtml(`<html><head><meta charset="utf-8"><style>
body{margin:0;padding:10px;font:13px -apple-system,system-ui,sans-serif;color:var(--tg-theme-text-color,#eee)}
.r{margin:2px 0}.done{font-size:11px;opacity:.6;margin-top:4px}
</style></head><body>${lines}<div class="done">Отвечено</div></body></html>`);
}
