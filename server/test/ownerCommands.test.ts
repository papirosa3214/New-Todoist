// MAK-82 / карточка d9dee6f8: маршрут /api/owner-command/run.
// Покрывает: права (403 не-владелец, 401 без токена), белый список без
// confirm, отказ вне списка без confirm, выполнение вне списка с confirm,
// тайм-аут, журнал who/what/when/outcome, автобэкап при BACKUP_REQUIRED,
// действие db.snapshot.
//
// Реальный exec замокан через PATH: временная папка с фейковым `sh`
// ставится первой, и он сам решает, что отвечать. Подробности — в
// комментарии к fakeBin ниже.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { BACKUP_REQUIRED, WHITELIST } from "../src/routes/owner-commands.js";

/**
 * Содержимое фейкового `sh`, который мы кладём в PATH первым.
 *
 * Роут вызывает `spawn(<first word of command>, args)` — чтобы прокинуть
 * его через этот скрипт, в тестах достаточно передавать `command: "sh ..."`
 * либо `command: "systemctl ... sh <args>"` и т.п. Здесь проще: для
 * разрешённых действий команда-строка начинается с `sh`, а сам скрипт
 * смотрит $1 (подкоманда) и по ней выбирает поведение.
 *
 * Поддерживаемые сценарии:
 *   sh restart         -> печатает "restart ok", exit 0
 *   sh status         -> печатает "active\n", exit 0
 *   sh is-active X    -> печатает "active" / "inactive" по имени
 *   sh tail X N       -> печатает N фиктивных строк, exit 0
 *   sh sleep          -> спит дольше тайм-аута, чтобы тест его словил
 */
function fakeShScript(): string {
  return `#!/bin/sh
set -e
cmd="$1"
shift || true
case "$cmd" in
  restart|systemctl-restart)
    echo "restart ok"
    exit 0 ;;
  status|systemctl-status)
    echo "active"
    exit 0 ;;
  is-active|systemctl-is-active)
    name="$1"
    case "$name" in
      taskflow-server.service) echo "active"; exit 0 ;;
      *) echo "inactive"; exit 3 ;;
    esac ;;
  tail|journalctl)
    # Роут передаёт args: --user -u UNIT -n N --no-pager. После shift
    # это $1=--user, $2=-u, $3=UNIT, $4=-n, $5=N, $6=--no-pager.
    unit="$3"
    n="$5"
    i=0
    while [ $i -lt "$n" ]; do
      i=$((i+1))
      printf '%s line %d\\n' "$unit" "$i"
    done
    exit 0 ;;
  sleep)
    # Длиннее любого тестового тайм-аута (тесты ставят ≤1 с), чтобы
    # SIGTERM/SIGKILL от родителя точно сработал раньше естественного
    # завершения.
    sleep 60
    exit 0 ;;
  systemctl)
    # Роут для service.* вызывает systemctl --user <verb> <unit>.
    sub="$1"
    case "$sub" in
      --user) sub="$2"; shift 2 ;;
    esac
    case "$sub" in
      restart) echo "restart ok"; exit 0 ;;
      is-active)
        name="$1"
        case "$name" in
          taskflow-server.service) echo "active"; exit 0 ;;
          *) echo "inactive"; exit 3 ;;
        esac ;;
      *) echo "fake systemctl: $sub" 1>&2; exit 1 ;;
    esac ;;
  *)
    echo "fake sh: unknown command $cmd" 1>&2
    exit 127 ;;
esac
`;
}

describe("POST /api/owner-command/run", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let fakeBin: string;
  let originalPath: string | undefined;
  let backupDir: string;

  const logRows = (): Array<Record<string, unknown>> =>
    db
      .prepare("SELECT * FROM owner_command_log ORDER BY rowid DESC")
      .all() as Array<Record<string, unknown>>;

  beforeAll(async () => {
    fakeBin = mkdtempSync(path.join(tmpdir(), "taskflow-ocmd-"));
    const shPath = path.join(fakeBin, "sh");
    writeFileSync(shPath, fakeShScript());
    chmodSync(shPath, 0o755);
    // systemctl/journalctl/sqlite3 из PATH ведут в тот же fakeSh, но
    // argv[0] у sh становится <verb>, а не сам бинарь. Передаём первым
    // аргументом имя бинаря, чтобы sh-скрипт видел его в $1 и мог
    // выбрать правильную ветку.
    for (const name of ["systemctl", "journalctl", "sqlite3"]) {
      const link = path.join(fakeBin, name);
      writeFileSync(link, `#!/bin/sh\nexec sh ${name} "$@"\n`);
      chmodSync(link, 0o755);
    }
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;

    // Своя папка для автобэкапа и снимков, чтобы тесты не оседали
    // рядом с боевой БД и не зависели от прод-каталога.
    backupDir = mkdtempSync(path.join(tmpdir(), "taskflow-ocmd-backup-"));
    process.env.OWNER_COMMAND_BACKUP_DIR = backupDir;
    process.env.OWNER_COMMAND_SERVICE_WHITELIST = "taskflow-server.service,watchdog.service";

    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Owner", email: "owner-ocmd@test", password: "password123" },
    });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Agent", email: "agent-ocmd@test", password: "password123" },
    });
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentReg.json().user.id);
    const apiResp = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agentReg.json().token}` },
    });
    agentToken = apiResp.json().api_token;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    delete process.env.OWNER_COMMAND_BACKUP_DIR;
    delete process.env.OWNER_COMMAND_SERVICE_WHITELIST;
    await app.close();
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  });

  it("401 без токена", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      payload: { action: "service.status", command: "sh status", params: { service: "taskflow-server.service" } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 на запрос не от владельца", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action: "service.status", command: "sh status", params: { service: "taskflow-server.service" } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/владельца/);
  });

  it("белый список service.status выполняется без confirm", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "service.status",
        command: "systemctl --user is-active taskflow-server.service",
        params: { service: "taskflow-server.service" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("ok");
    // stdout: "active\n" — `echo` добавляет перевод строки. trim() для
    // сравнения человеческим глазом.
    expect(body.stdout.trim()).toBe("active");
    expect(body.exitCode).toBe(0);
    expect(typeof body.requestId).toBe("string");
  });

  it("service.restart из белого списка", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "service.restart",
        command: "systemctl --user restart taskflow-server.service",
        params: { service: "taskflow-server.service" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout.trim()).toBe("restart ok");
  });

  it("journal.tail из белого списка с N строками", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "journal.tail",
        // command здесь не используется для белого списка: роут строит
        // args из params сам, но поле должно быть непустой строкой
        // (валидация на верхнем уровне).
        command: "journalctl --user -u taskflow-server.service -n 5 --no-pager",
        params: { service: "taskflow-server.service", lines: 5 },
      },
    });
    expect(res.statusCode).toBe(200);
    // stdout: "taskflow-server.service line 1\n...\nline 5\n" — split('\n')
    // даст 6 элементов, последний пустой из-за финального \n.
    expect(res.json().stdout.split("\n").filter(Boolean).length).toBe(5);
  });

  it("вне белого списка без confirm — 400 и rejected в журнале", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "custom.thing",
        command: "sh restart",
        confirm: false,
        params: {},
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().whitelist).toEqual([...WHITELIST].sort());
    const row = logRows()[0]; // свежайшая запись: ORDER BY rowid DESC, [0] = последняя
    expect(row?.outcome).toBe("rejected");
    expect(row?.confirm).toBe(0);
    expect(row?.who).toBe(ownerId);
    expect(row?.error).toMatch(/confirm=true/);
  });

  it("вне белого списка с confirm=true — выполняется (и пишется в журнал)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "custom.thing",
        command: "sh status",
        confirm: true,
        params: {},
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("ok");
    expect(res.json().stdout.trim()).toBe("active");
    const row = logRows()[0];
    expect(row?.outcome).toBe("ok");
    expect(row?.confirm).toBe(1);
    expect(row?.exit_code).toBe(0);
  });

  it("bash preserves quotes pipes and nonzero exit with captured output", async () => {
    const res = await app.inject({ method: "POST", url: "/api/owner-command/run", headers: {authorization: `Bearer ${ownerToken}`}, payload: {action: "chat.bash", command: "printf 'two words' | /usr/bin/tr 'a-z' 'A-Z'; printf 'failure' >&2; exit 7", confirm: true}});
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout).toBe("TWO WORDS");
    expect(res.json().stderr).toBe("failure");
    expect(res.json().exitCode).toBe(7);
    expect(logRows()[0].exit_code).toBe(7);
  });

  it("db.snapshot делает файл и возвращает путь в backup.path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "db.snapshot",
        command: "db.snapshot",
        params: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe("ok");
    expect(body.backup?.path).toMatch(/db-.*\.sqlite3$/);
    // Файл существует и не пустой — better-sqlite3 backup не пишет 0 байт.
    const stat = (await import("node:fs")).statSync(body.backup.path);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("тайм-аут: 504, outcome=timeout, exec убит", async () => {
    // Короткий тайм-аут на прогон этого теста — ENV читается при exec,
    // так что достаточно выставить переменную ДО запроса.
    process.env.OWNER_COMMAND_TIMEOUT_MS = "2000";
    const TIMEOUT_MS = 2000;
    try {
      const start = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/api/owner-command/run",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          // Произвольное действие с confirm=true: роут возьмёт
          // command = "sh sleep" и повиснет на 60 с — мы его убьём
          // по тайм-ауту. Белый список здесь не годится: каждое его
          // действие завершается ok за миллисекунды.
          action: "custom.timeout",
          command: "sh sleep",
          confirm: true,
          params: {},
        },
      });
      expect(res.statusCode).toBe(504);
      const elapsed = Date.now() - start;
      // Прошло не меньше тайм-аута и не больше тайм-аут + SIGTERM_GRACE_MS.
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(TIMEOUT_MS + 10_000);
      const body = res.json();
      expect(body.outcome).toBe("timeout");
      expect(body.stdout).toBeDefined();
      const row = logRows()[0];
      expect(row?.outcome).toBe("timeout");
    } finally {
      delete process.env.OWNER_COMMAND_TIMEOUT_MS;
    }
  }, 20_000);

  it("журнал содержит who/what/when/outcome для каждого вызова", () => {
    // Берём все строки, что накопились к этому тесту (включая 401/403 —
    // те отвергаются до журнала, потому что auth не проходит, и в
    // owner_command_log их нет). Проверяем, что каждая строка имеет
    // полный набор полей.
    const rows = logRows();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.who).toBe(ownerId);
      expect(typeof row.action).toBe("string");
      expect(typeof row.command).toBe("string");
      expect(typeof row.started_at).toBe("string");
      expect(["ok", "rejected", "timeout", "error", "backup_failed"]).toContain(row.outcome);
      // request_id — uuid
      expect(String(row.request_id)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("service не из белого списка сервисов — 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/owner-command/run",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "service.restart",
        command: "sh restart",
        params: { service: "nginx.service" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/белом списке сервисов/);
  });

  it("BACKUP_REQUIRED пуст (белый список не пишет в БД) — это и зафиксировано в архитектуре", () => {
    // Тест-напоминание: добавление пишущего действия требует отдельной
    // задачи и явного занесения в BACKUP_REQUIRED в роуте. Сейчас там
    // пусто, и архитектура готова (функция snapshotDb уже умеет делать
    // бэкап под ENV OWNER_COMMAND_BACKUP_DIR).
    expect(BACKUP_REQUIRED.size).toBe(0);
  });
});