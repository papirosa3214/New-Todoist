/** One private reminder per role run; an attempted lookup is enough, even if its provider fails. */
export class MemoryConsultationGuard {
  private actions = 0;
  private consulted = false;
  private reminded = false;

  observe(tool: string, args: unknown): string | null {
    if (this.reminded || this.consulted) return null;
    const payload = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const operation = tool === "taskflow" && payload.action === "invoke"
      ? String(payload.operation ?? "") : tool;
    if (operation === "taskflow_recall" || operation === "taskflow_kb_search") {
      this.consulted = true;
      return null;
    }
    if (++this.actions < 10) return null;
    this.reminded = true;
    return "За первые 10 вызовов инструментов ты ещё не обращался к памяти или базе знаний. " +
      "Перед следующим рабочим действием поищи похожий случай по смыслу задачи: taskflow_recall (память) " +
      "или taskflow_kb_search (база знаний). Через taskflow используй discover/describe, затем action=invoke. " +
      "Учти найденное в работе. Если поиск недоступен, продолжай с доступными данными и укажи ограничение в итоге. " +
      "Это внутреннее напоминание: не пересказывай его владельцу и не повторяй статус ради самого статуса.";
  }
}
