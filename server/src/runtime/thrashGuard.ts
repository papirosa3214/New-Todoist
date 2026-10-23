// Сторож топтания (владелец 23.10.2026): роль, которая крутит одни и те же
// чтения и пересказывает одну находку, должна получить указание в свой же ход —
// «сформулируй вывод и переходи к правке».
//
// Владелец 23.10.2026, кадр из чата «Разработчик»: 22 вызова host_bash и одна и
// та же фраза «эталон найден» после каждой пачки шагов, правка так и не начата.
// Сторож тишины такое не ловит: события идут, значит роль «жива».
//
// Здесь только решение и текст. Кто и как отдаёт указание в ход — в рантаймах
// (chatSystemPrompt/PiRuntimeAdapter и inProcessRun).

export type ThrashEvent = {
  /** Имя инструмента (или операции), как она видна в событиях рантайма. */
  tool: string;
  /** Устойчивый дайджест аргументов: одинаковый вызов — одинаковый ключ. */
  argsDigest: string;
};

export type ThrashGuardOptions = {
  /** Сколько раз один и тот же вызов считается повтором. */
  repeatLimit?: number;
  /** Сколько шагов подряд «только чтение» без единого изменения терпим. */
  readStreakLimit?: number;
  /** Сколько шагов после срабатывания сторож молчит. */
  cooldownSteps?: number;
};

const DEFAULTS: Required<ThrashGuardOptions> = {
  repeatLimit: 3,
  readStreakLimit: 12,
  cooldownSteps: 6,
};

/** Инструменты «только чтение»: ими роль исследует, но ничего не меняет.
 *  Список точный: широкое совпадение по подстроке ловило «taskflow_host_bash»
 *  из-за «task» и считало запись чтением. */
const RESEARCH_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "taskflow_recall",
  "taskflow_kb_search",
  "taskflow_doc_read",
  "taskflow_task",
  "taskflow_my_tasks",
  "taskflow_project_tasks",
  "taskflow_status",
  "taskflow_rules",
  "taskflow_chat_read",
  "taskflow_hosts",
  "taskflow_host_read",
  "taskflow_host_ls",
]);

export function isResearchTool(tool: string): boolean {
  const name = tool.toLowerCase();
  if (RESEARCH_TOOLS.has(name)) return true;
  // MCP-инструменты: чтение — по суффиксу, запись сюда не попадает.
  return /_(read|ls|get|search|list)$/.test(name);
}

/** Короткий устойчивый ключ аргументов: одинаковый вызов — одинаковый ключ. */
export function stepDigest(args: unknown): string {
  try {
    const text = JSON.stringify(args ?? {});
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36) + ":" + text.length;
  } catch {
    return "unserializable";
  }
}

export class ThrashGuard {
  private readonly options: Required<ThrashGuardOptions>;
  private readonly calls = new Map<string, number>();
  private readStreak = 0;
  private cooldown = 0;
  private fired = 0;

  constructor(options: ThrashGuardOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Сколько раз сторож уже срабатывал в этом ходе. */
  get firedCount(): number {
    return this.fired;
  }

  /**
   * Учесть шаг. Возвращает текст указания для роли или null, если всё в норме.
   */
  observe(event: ThrashEvent): string | null {
    const key = event.tool + "\u0000" + event.argsDigest;
    const repeats = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, repeats);

    if (isResearchTool(event.tool)) this.readStreak += 1;
    else this.readStreak = 0;

    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return null;
    }

    if (repeats >= this.options.repeatLimit) {
      this.calls.set(key, 0);
      return this.fire(
        `Ты повторяешь один и тот же вызов «${event.tool}» уже ${repeats} раз с теми же аргументами. ` +
          "Повтор не даст нового ответа. Сформулируй вывод из того, что уже получено, и переходи к следующему шагу; " +
          "если нужное так и не нашлось — скажи, чего именно не хватает, и задай владельцу вопрос с вариантами.",
      );
    }

    if (this.readStreak >= this.options.readStreakLimit) {
      this.readStreak = 0;
      return this.fire(
        `Ты сделал ${this.options.readStreakLimit} шагов подряд только чтением и ещё ничего не изменил. ` +
          "Хватит искать: назови, что уже нашёл, и начинай работу по чек-листу. " +
          "Если для работы не хватает данных или решение за владельцем — задай один вопрос с вариантами ответа.",
      );
    }

    return null;
  }

  private fire(text: string): string {
    this.cooldown = this.options.cooldownSteps;
    this.fired += 1;
    return text;
  }
}
