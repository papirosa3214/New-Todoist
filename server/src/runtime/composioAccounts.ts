import { spawn } from "node:child_process";
import { composioCommand } from "./composioPolicy.js";

export type ComposioAccount = { id: string; address: string | null; alias: string | null; status: string; created_at: string | null };
export type ComposioAccountAction = "accounts" | "account-link" | "account-delete" | "mail-list" | "mail-read" | "mail-draft" | "mail-archive" | "mail-spam" | "mail-send";

/** Один вызов моста Composio для аккаунтов сервиса: вход — JSON в stdin, выход — JSON. */
export function composioAccountsCall(ownerId: string, toolkit: string, action: ComposioAccountAction, input: Record<string, unknown> = {}): Promise<any> {
  if (!/^[a-z0-9_\-]{1,100}$/.test(toolkit)) return Promise.reject(new Error("Неизвестный сервис"));
  const command = composioCommand({ role: "integrations", ownerId, enabled: true, toolkits: [toolkit] }, "work", "integrations");
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args, "--" + action], {
      env: { ...process.env, ...command.env, TASKFLOW_COMPOSIO_TOOLKIT: toolkit }, stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "", settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Composio не ответил вовремя")), 60_000);
    child.on("error", () => finish(new Error("Не удалось запустить подключение Composio")));
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 1_000_000) finish(new Error("Слишком большой ответ Composio")); });
    child.on("close", () => {
      try { finish(undefined, JSON.parse(output)); } catch { finish(new Error("Composio не отвечает или ключ недействителен")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export const MAIL_ERRORS: Record<string, string> = {
  not_connected: "Почта не подключена: добавьте адрес в «Интеграциях».",
  account_not_found: "Такого подключённого адреса нет.",
  recipient_not_allowed: "Отправлять можно только на адреса владельца, подключённые в «Интеграциях». Для остальных получателей готовь черновик.",
  mail_failed: "Gmail не выполнил операцию.",
};
