// Владелец 06.11.2026: роль builder в чате прибирала за своей пробой и
// выполнила `pkill -f "dist/index.js" -u maksim` — под шаблон попал рабочий
// сервер (тот же `node dist/index.js` того же пользователя), и он упал посреди
// работы: у владельца «Не удалось загрузить чаты». Bash чатового хода
// исполняется от пользователя сервера, поэтому опасные остановки отсекаются
// до запуска команды.
import { describe, expect, it } from "vitest";
import { roleBashKillError, withRoleBashKillGuard } from "../src/runtime/roleBashGuard.js";

const SERVER_PID = 4242;

describe("bash роли не может остановить сервер", () => {
  it("остановка по шаблону отклоняется", () => {
    for (const command of [
      'pkill -f "dist/index.js" -u maksim',
      "sleep 1; pkill node",
      "killall node",
      "cd /tmp && killall -9 tsx",
      "fuser -k 3001/tcp",
      "fuser -n tcp -k 3099",
      "ss -ltn | grep 3099; pkill -f tgstub/server",
    ]) {
      expect(roleBashKillError(command, SERVER_PID), command).toMatch(/номер/);
    }
  });

  it("kill самого сервера и широкие kill отклоняются", () => {
    for (const command of [
      `kill ${SERVER_PID}`,
      `kill -9 ${SERVER_PID}`,
      `kill -TERM ${SERVER_PID} 123`,
      "kill -9 -1",
      "kill 0",
      "kill -s KILL -1",
    ]) {
      expect(roleBashKillError(command, SERVER_PID), command).toMatch(/номер|сервер/);
    }
  });

  it("свой процесс по номеру и обычные команды проходят", () => {
    for (const command of [
      "kill $PID",
      'kill "$!"',
      "kill 12345",
      "kill -9 12345 12346",
      "npm test -- --maxWorkers=4",
      "grep -rn pkill docs/",
      "echo 'не используйте killall'",
      "ps aux | grep node",
    ]) {
      expect(roleBashKillError(command, SERVER_PID), command).toBeNull();
    }
  });

  it("обёртка bash не запускает запрещённую команду и пропускает обычную", async () => {
    const ran: string[] = [];
    const bash = withRoleBashKillGuard({ name: "bash", execute: async (_id: string, p: any) => { ran.push(p.command); return "ok"; } });
    await expect(bash.execute("t1", { command: 'pkill -f "dist/index.js"' })).rejects.toThrow(/номер/);
    await expect(bash.execute("t2", { command: "ls" })).resolves.toBe("ok");
    expect(ran).toEqual(["ls"]);
    const read = { name: "read", execute: async () => "r" };
    expect(withRoleBashKillGuard(read)).toBe(read);
  });
});
