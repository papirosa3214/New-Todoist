import { spawn } from "node:child_process";
import { composioCommand } from "./composioPolicy.js";

export class LinearSourceError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

/** Transport for fixed server queries only. No client-supplied GraphQL route. */
export async function linearQuery(ownerId: string, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  if (!/^\s*query\s/.test(query) || /\b(mutation|subscription)\b/.test(query)) throw new LinearSourceError("Разрешено только чтение Linear", 400);
  const command = composioCommand({ role: "linear_import", ownerId, enabled: true, toolkits: ["linear"] }, "plan", "linear_import");
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args, "--linear-read"], {
      env: { ...process.env, ...command.env }, stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "", settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new LinearSourceError("Linear не ответил вовремя. Повторите загрузку.")), 90_000);
    child.on("error", () => finish(new LinearSourceError("Не удалось запустить подключение Linear")));
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 24 * 1024 * 1024) finish(new LinearSourceError("Ответ Linear слишком большой. Выберите меньше задач.", 422));
    });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      if (code !== 0) return finish(new LinearSourceError("Composio недоступен. Проверьте общее подключение."));
      try {
        const parsed = JSON.parse(output);
        if (parsed.error === "not_connected") return finish(new LinearSourceError("Подключите общий аккаунт Linear в Composio.", 409));
        if (parsed.error === "multiple_accounts") return finish(new LinearSourceError("Найдено несколько аккаунтов Linear. Оставьте одно общее подключение для импорта.", 409));
        if (parsed.error || !parsed.data) return finish(new LinearSourceError("Linear отклонил запрос. Проверьте права аккаунта и повторите загрузку."));
        finish(undefined, parsed.data);
      } catch { finish(new LinearSourceError("Некорректный ответ подключения Linear")); }
    });
    child.stdin.end(JSON.stringify({ query, variables }));
  });
}
