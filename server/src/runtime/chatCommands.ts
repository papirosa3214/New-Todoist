// Команды чата: реальные навыки роли и реальные инструменты, которыми она
// может пользоваться в этом чате (карточка e11eae7a, пункт 5).
//
// Список НИЧЕГО не выполняет: это только описание того, что у роли есть.
// Выполняется явный вызов — «/skill:имя » или «/mcp:имя » — и он
// проверяется при отправке сообщения: неизвестное имя отклоняется и не
// исполняется.
import { skillCard, toolCard } from "./chatCommandCard.js";
import { listRoleSkills } from "./instructionResources.js";
import { taskflowTools } from "./inProcessRun.js";
import { roleToolAllowed } from "../lib/roleToolScope.js";
import { CARD_WORK_OPERATIONS, type ChatExecutionMode } from "./chatExecutionMode.js";
import { PLANNING_TOOLS, type ChatWorkMode } from "./chatWorkMode.js";

export type ChatCommand = {
  id: string;
  title: string;
  kind: "skill" | "mcp";
  description: string;
  invocation: string;
  /** Карточка в приложении (владелец 27.10.2026): что делает в двух словах. */
  summary: string;
  /** Имя SF Symbol. */
  icon: string;
};

export type SlashInvocation = {
  kind: "skill" | "mcp";
  name: string;
  rest: string;
  /** Роль, названная перед вызовом («@builder /skill:имя …»). */
  role?: string | null;
};

/** Встроенные инструменты Pi: те же, что роль видит в сессии. */
const NATIVE_TOOLS: Array<{ name: string; title: string; description: string }> = [
  { name: "read", title: "Прочитать файл", description: "Прочитать файл или диапазон строк" },
  { name: "write", title: "Записать файл", description: "Записать содержимое в файл" },
  { name: "edit", title: "Править файл", description: "Заменить точный фрагмент в файле" },
  { name: "bash", title: "Команда в терминале", description: "Выполнить команду в рабочей папке роли" },
  { name: "grep", title: "Поиск по тексту", description: "Найти совпадения по содержимому файлов" },
  { name: "find", title: "Поиск по файлам", description: "Найти файлы по имени или шаблону" },
  { name: "ls", title: "Список файлов", description: "Показать содержимое папки" },
];

function nativeAllowed(name: string, mode: ChatWorkMode): boolean {
  if (mode !== "plan") return true;
  return PLANNING_TOOLS.includes(name);
}

function roleToolAllowedInChat(
  role: string,
  name: string,
  executionMode: ChatExecutionMode,
  mode: ChatWorkMode,
): boolean {
  if (!roleToolAllowed(role, name)) return false;
  // В режиме «в чате» карточные операции скрыты — как и в самом ходе роли.
  if (executionMode === "chat" && CARD_WORK_OPERATIONS.has(name)) return false;
  if (mode === "plan" && !PLANNING_TOOLS.includes(name)) return false;
  return true;
}

/** Команды чата для роли: навыки (реально загруженные) и инструменты (реально доступные). */
export async function listChatCommands(params: {
  role: string;
  executionMode: ChatExecutionMode;
  mode: ChatWorkMode;
  chatId?: string;
  messageId?: string;
}): Promise<ChatCommand[]> {
  const commands: ChatCommand[] = [];
  const skills = await listRoleSkills(params.role).catch((error) => {
    // Ошибку не глотаем молча: список команд без навыков вводит в
    // заблуждение, а причина обязана быть видна в журнале (D2 карточки
    // e11eae7a: реальный навык не должен выглядеть «не найден»).
    console.warn(
      `[chatCommands] навыки роли ${params.role} не загрузились:`,
      error instanceof Error ? error.message : error,
    );
    return [] as Awaited<ReturnType<typeof listRoleSkills>>;
  });
  for (const skill of skills) {
    const card = skillCard(skill.filePath, skill.name, skill.description ?? "");
    commands.push({
      id: skill.name,
      title: card.title,
      kind: "skill",
      description: skill.description ?? "",
      invocation: `/skill:${skill.name} `,
      summary: card.summary,
      icon: card.icon,
    });
  }
  for (const tool of NATIVE_TOOLS) {
    if (!nativeAllowed(tool.name, params.mode)) continue;
    const card = toolCard(tool.name, tool.title, tool.description);
    commands.push({
      id: tool.name,
      title: card.title,
      kind: "mcp",
      description: tool.description,
      invocation: `/mcp:${tool.name} `,
      summary: card.summary,
      icon: card.icon,
    });
  }
  const registry = taskflowTools(
    params.role,
    null,
    undefined,
    undefined,
    true,
    { chatId: params.chatId ?? "", messageId: params.messageId ?? "" },
  );
  for (const tool of registry) {
    if (!roleToolAllowedInChat(params.role, tool.name, params.executionMode, params.mode)) continue;
    const description = (tool.description ?? "").split("\n")[0].slice(0, 300);
    const card = toolCard(tool.name, tool.name, description);
    commands.push({
      id: tool.name,
      title: card.title,
      kind: "mcp",
      description,
      invocation: `/mcp:${tool.name} `,
      summary: card.summary,
      icon: card.icon,
    });
  }
  return commands;
}

/** Разбор явного вызова в начале сообщения. */
export function parseSlashInvocation(text: string): SlashInvocation | null {
  const match = /^(?:@([A-Za-z0-9_]+)[ \t]+)?\/(skill|mcp):([A-Za-z0-9_.-]+)[ \t]*([\s\S]*)$/.exec((text ?? "").trim());
  if (!match) return null;
  return {
    kind: match[2] as "skill" | "mcp",
    name: match[3],
    rest: match[4].trim(),
    role: match[1] ?? null,
  };
}

export type SlashResolution =
  | { ok: true; text: string; command: ChatCommand }
  | { ok: false; error: string };

/**
 * Проверка и подготовка явного вызова.
 * Навык подключается настоящим текстом навыка роли; инструмент — реальным
 * вызовом в правах текущего режима. Неизвестное имя — отказ, ничего не
 * выполняется.
 */
export async function resolveSlashCommand(params: {
  role: string;
  invocation: SlashInvocation;
  executionMode: ChatExecutionMode;
  mode: ChatWorkMode;
  chatId?: string;
  messageId?: string;
}): Promise<SlashResolution> {
  if (params.invocation.kind === "skill") {
    const skills = await listRoleSkills(params.role).catch((error) => {
      console.warn(
        `[chatCommands] навыки роли ${params.role} не загрузились:`,
        error instanceof Error ? error.message : error,
      );
      return [] as Awaited<ReturnType<typeof listRoleSkills>>;
    });
    const skill = skills.find((item) => item.name === params.invocation.name);
    if (!skill) {
      return { ok: false, error: `Навык «${params.invocation.name}» у роли ${params.role} не найден` };
    }
    const card = skillCard(skill.filePath, skill.name, skill.description ?? "");
    const command: ChatCommand = {
      id: skill.name,
      title: card.title,
      kind: "skill",
      description: skill.description ?? "",
      invocation: `/skill:${skill.name} `,
      summary: card.summary,
      icon: card.icon,
    };
    const text = [
      `ЯВНЫЙ ВЫЗОВ НАВЫКА «${skill.name}». Ниже его полный текст — следуй ему в этом ходу.`,
      skill.content,
      params.invocation.rest ? `ЗАПРОС ВЛАДЕЛЬЦА: ${params.invocation.rest}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { ok: true, text, command };
  }
  const commands = await listChatCommands({
    role: params.role,
    executionMode: params.executionMode,
    mode: params.mode,
    chatId: params.chatId,
    messageId: params.messageId,
  });
  const command = commands.find((item) => item.kind === "mcp" && item.id === params.invocation.name);
  if (!command) {
    return {
      ok: false,
      error: `Инструмент «${params.invocation.name}» роли ${params.role} в этом чате недоступен`,
    };
  }
  const text = [
    `ЯВНЫЙ ВЫЗОВ ИНСТРУМЕНТА «${command.id}». Вызови его сейчас, в правах текущего режима, с аргументами по его схеме.`,
    params.invocation.rest ? `ЗАПРОС ВЛАДЕЛЬЦА: ${params.invocation.rest}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { ok: true, text, command };
}
