/**
 * TaskFlow activity reporter — живой поток действий агента в карточку задачи.
 *
 * Слушает выполнения инструментов Pi (Read/Edit/Write/Bash/Grep/Glob/
 * WebFetch/WebSearch) и шлёт в TaskFlow `POST /api/tasks/:id/activity` с видом
 * действия: read / edit / write / search / run / web / image / test / build /
 * git / think. Это даёт владельцу полоску иконок «что агент предпринимал»
 * (просьба 20.09.2026).
 *
 * MCP-инструменты `taskflow_*` НЕ трогаем: их действия уже шлёт сам
 * MCP-сервер (`mcp_server.py`), иначе было бы задвоение.
 *
 * Данные приходят из окружения захода (см. `trigger.py`):
 *   TASKFLOW_ACTIVITY_TASK_ID   — id задачи
 *   TASKFLOW_ACTIVITY_ROLE      — роль (для журнала)
 *   TASKFLOW_ACTIVITY_VAULT_KEY — имя ключа роли в vault
 *   TASKFLOW_BASE               — база API (по умолчанию http://localhost:3001)
 *
 * Мягкая деградация: любая ошибка отправки ГЛОТАЕТСЯ и не ломает вызов
 * инструмента — репортинг активности побочный, а не основной.
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VAULT_GET = "/home/maksim/.claude/vault-get.py";
const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg|bmp|heic)$/i;

function baseUrl(): string {
    return process.env.TASKFLOW_BASE || "http://localhost:3001";
}

let cachedToken: string | null = null;
function token(): string | null {
    if (cachedToken) return cachedToken;
    const direct = process.env.TASKFLOW_ACTIVITY_TOKEN;
    if (direct) {
        cachedToken = direct;
        return cachedToken;
    }
    const key = process.env.TASKFLOW_ACTIVITY_VAULT_KEY;
    if (!key) return null;
    try {
        const value = execFileSync("python3", [VAULT_GET, "--raw", key], {
            encoding: "utf8",
            timeout: 5000,
        }).trim();
        cachedToken = value || null;
        return cachedToken;
    } catch {
        return null;
    }
}

function classifyCommand(cmd: string): string {
    const c = cmd.toLowerCase();
    if (
        /(^|\s)(vitest|jest|pytest|rspec|phpunit)(\s|$)/.test(c) ||
        /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(c)
    ) {
        return "test";
    }
    if (
        /\b(tsc|vite\s+build|xcodebuild|swift\s+build|gradle|cargo\s+build|go\s+build|npm\s+run\s+build|pnpm\s+build)\b/.test(c)
    ) {
        return "build";
    }
    if (/(^|\s)git\s/.test(c)) return "git";
    return "run";
}

function classify(tool: string, rawArgs: unknown): { kind: string; target: string } | null {
    const name = tool.toLowerCase();
    const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
    const path = String(a.file_path ?? a.path ?? a.filePath ?? a.pattern ?? a.url ?? "");
    switch (name) {
        case "read":
            return IMAGE_RE.test(path)
                ? { kind: "image", target: path }
                : { kind: "read", target: path };
        case "edit":
        case "multiedit":
        case "notebookedit":
            return { kind: "edit", target: path };
        case "write":
            return { kind: "write", target: path };
        case "grep":
        case "glob":
        case "find":
        case "ls":
            return { kind: "search", target: String(a.pattern ?? a.query ?? path) };
        case "webfetch":
        case "websearch":
        case "web_search":
            return { kind: "web", target: String(a.url ?? a.query ?? "") };
        case "bash":
        case "shell":
        case "powershell": {
            const cmd = String(a.command ?? "");
            return { kind: classifyCommand(cmd), target: cmd };
        }
        default:
            return null;
    }
}

function shortTarget(t: string): string {
    const s = (t || "").trim().replace(/\s+/g, " ");
    return s.length > 160 ? s.slice(0, 159) + "…" : s;
}

export default function (pi: ExtensionAPI) {
    let lastKey = "";
    let lastAt = 0;

    const send = (kind: string, target: string) => {
        try {
            const taskId = process.env.TASKFLOW_ACTIVITY_TASK_ID;
            if (!taskId) return;
            const key = `${kind}|${target}`;
            const now = Date.now();
            if (key === lastKey && now - lastAt < 1500) return;
            lastKey = key;
            lastAt = now;
            const t = token();
            if (!t) return;
            void fetch(`${baseUrl()}/api/tasks/${taskId}/activity`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${t}`,
                },
                body: JSON.stringify({ kind, target: shortTarget(target) }),
            }).catch(() => {
                /* побочный эффект — молча */
            });
        } catch {
            /* побочный эффект — молча */
        }
    };

    pi.on("tool_execution_start", (event) => {
        try {
            if (event.toolName.startsWith("taskflow_")) return;
            const hit = classify(event.toolName, event.args);
            if (hit) send(hit.kind, hit.target);
        } catch {
            /* не ломаем вызов инструмента */
        }
    });

    pi.on("turn_start", () => {
        send("think", "обдумывает следующий шаг");
    });
}
