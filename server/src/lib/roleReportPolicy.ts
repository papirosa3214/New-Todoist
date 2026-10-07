export const ROLE_REPORT_SECTIONS = ["Результат", "Что сделано", "Проверки", "Ограничения", "Материалы"];
export const ROLE_REPORT_INSTRUCTION = "При сдаче своего этапа обязательно передай report_markdown — читаемый отчёт для владельца, вместе с JSON-артефактом (artifact.report_markdown), либо рядом с result, если у шага нет контракта. Проверяющий передаёт report_markdown вместе с вердиктом taskflow_review. Разделы Markdown: ## Результат, ## Что сделано, ## Проверки, ## Ограничения, ## Материалы. Пиши связно по-русски: что получилось, факты работы, что/как проверено с доказательствами, что не проверено и осталось, ссылки на материалы. Если проверки не проводились или материалов нет — прямо скажи это. Не выдавай предположения за проверки, не заполняй отчёт техническим JSON. Сервер сам сохранит отчёт заметкой в папке этой задачи и прикрепит ссылку к результату этапа; отдельно doc_write для этого отчёта не вызывай. JSON payload остаётся входом следующей роли; отчёт предназначен владельцу.";
export function validateRoleReport(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("report_markdown обязателен: читаемый отчёт о результате этапа.");
  const markdown = value.trim();
  if (markdown.length > 64000) throw new Error("report_markdown: максимум 64000 символов.");
  const prose = markdown.replace(/^[ \t]*(\x60{3,}|~{3,}).*[\s\S]*?^[ \t]*\1[ \t]*$/gm, "");
  const headings = [...prose.matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)];
  for (const section of ROLE_REPORT_SECTIONS) {
    const heading = headings.find(h => h[1].trim() === section);
    if (!heading) throw new Error("report_markdown: нужен раздел «" + section + "».");
    const next = headings.find(h => h.index! > heading.index!);
    const content = prose.slice(heading.index! + heading[0].length, next?.index ?? prose.length).trim();
    if (!content || !/[\p{L}\p{N}]/u.test(content)) throw new Error("report_markdown: раздел «" + section + "» пуст.");
  }
  return markdown;
}
