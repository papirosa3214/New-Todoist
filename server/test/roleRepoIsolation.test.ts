// Изоляция пользователя ролей (tfrole) от основного репозитория.
// Аудит 24.10.2026.
//
// ЧТО БЫЛО: на каталогах репозитория висел ACL `u:tfrole:rwx`. Роли
// работают в СВОИХ рабочих копиях (~/.local/state/taskflow-runs/worktrees/
// <task_id>, ветка roles/<task_id>), и доступ к ним выдаётся отдельно
// (grantRoleAccess в localRoleOperations.ts). Доступа к основному
// репозиторию у роли быть не должно — но был.
//
// ЧТО ЭТО ДАВАЛО:
//  1. Запись в server/src/** и server/dist/** — dist это исполняемый код
//     сервера (systemd запускает `node dist/index.js`).
//  2. Запись в .git/config → подмена core.hooksPath → выполнение кода роли
//     при следующем коммите владельца (идёт от maksim, с его секретами).
//  3. Запись в .git/refs/heads/** → попытка сдвинуть ветку main.
//  4. Чтение server/taskflow.db (mode 674) → api_token владельца,
//     password_hash всех пользователей, вся переписка чатов.
//
// Тест НЕ трогает боевое окружение напрямую: права проверяются на
// отдельной копии репозитория (tmp), куда скрипт применяется тем же
// кодом. Боевой репозиторий скрипт чинит при старте сервера
// (hardenRepoAccess в env.ts).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "harden-repo-access.sh");
const ROLE_USER = process.env.TASKFLOW_ROLE_USER ?? "tfrole";

function sh(cmd: string, cwd?: string): string {
  return execFileSync("/bin/bash", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Есть ли пользователь ролей в системе. Если нет — тесты изоляции не применимы. */
const roleUserExists = (() => {
  try {
    execFileSync("/usr/bin/id", [ROLE_USER], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** setfacl доступен? */
const setfaclExists = (() => {
  try {
    execFileSync("/usr/bin/setfacl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const applicable = roleUserExists && setfaclExists;

/** Собирает репозиторий-клон с веткой роли и боевым ACL. */
function buildFixture(): { repo: string; roleWorktree: string } {
  // Именно /tmp: os.tmpdir() в этом окружении указывает на ~/.hermes/cache/
  // scratch, а у него закрытые права на родителя — роль (tfrole) не может
  // туда зайти. Фикстуре нужен путь, доступный роли.
  const base = fs.mkdtempSync(path.join("/tmp", "tf-acl-"));
  // mkdtemp создаёт каталог с правами 700 — роль (tfrole) в него не войдёт.
  // Фикстура имитирует боевой репозиторий, где у роли есть доступ на
  // чтение, поэтому обход (x) на каталогах обязателен.
  fs.chmodSync(base, 0o755);
  const repo = path.join(base, "main");
  fs.mkdirSync(repo);
  fs.chmodSync(repo, 0o755);
  fs.mkdirSync(path.join(base, "roles"), { recursive: true });
  fs.chmodSync(path.join(base, "roles"), 0o755);
  sh("git init -q . && git config user.email t@t && git config user.name t", repo);
  fs.mkdirSync(path.join(repo, "server", "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "server", "dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
  fs.writeFileSync(path.join(repo, "server", "src", "i.ts"), "export const i = 1;\n");
  fs.writeFileSync(path.join(repo, "server", "dist", "i.js"), "console.log(1);\n");
  sh("git add -A && git commit -qm init && git branch -f main HEAD", repo);

  // Рабочая копия роли — как её создаёт grantRoleAccess.
  const roleWorktree = path.join(base, "roles", "probe");
  sh(`git worktree add -q -b roles/probe "${roleWorktree}" HEAD`, repo);
  fs.chmodSync(roleWorktree, 0o755);
  sh(
    `setfacl -R -m "u:${ROLE_USER}:rwX,d:u:${ROLE_USER}:rwX,u:${os.userInfo().username}:rwX,d:u:${os.userInfo().username}:rwX" "${roleWorktree}"`,
  );

  // Боевой ACL на основном репозитории: роль пишет везде.
  sh(`setfacl -R -m u:${ROLE_USER}:rwX . || true`, repo);
  sh(`setfacl -R -m d:u:${ROLE_USER}:rwX . || true`, repo);
  return { repo, roleWorktree };
}

/**
 * Команда от пользователя ролей: возвращает true, если она УСПЕШНА.
 *
 * Окружение очищается от GIT_CONFIG_* : test/setup.ts подставляет
 * core.hooksPath через переменные окружения (защита тестов от коммита в
 * живой репозиторий). Если эти переменные дойдут до git внутри проверки,
 * git будет читать hooksPath из защищённого набора тестов, и проверки
 * core.hooksPath в этом файле станут бессмысленными. Здесь нужен ЧИСТЫЙ
 * git — ровно как у настоящей роли.
 */
function asRole(cmd: string, cwd: string): boolean {
  const env = { ...process.env };
  const n = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (let i = 0; i < n; i += 1) {
    delete env[`GIT_CONFIG_KEY_${i}`];
    delete env[`GIT_CONFIG_VALUE_${i}`];
  }
  delete env.GIT_CONFIG_COUNT;
  try {
    execFileSync("sudo", ["-n", "-u", ROLE_USER, "/bin/bash", "-c", cmd], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!applicable)("Изоляция ролей от основного репозитория (аудит 24.10.2026)", () => {
  it("роль НЕ пишет в server/src основного репозитория", () => {
    const { repo } = buildFixture();
    execFileSync("/bin/bash", [SCRIPT, repo], { stdio: "ignore" });
    const ок = asRole(`printf x >> server/src/i.ts`, repo);
    expect(ок, "роль смогла записать в server/src — изоляция не работает").toBe(false);
  });

  it("роль НЕ пишет в server/dist (исполняемый код сервера)", () => {
    const { repo } = buildFixture();
    execFileSync("/bin/bash", [SCRIPT, repo], { stdio: "ignore" });
    const ок = asRole(`printf x >> server/dist/i.js`, repo);
    expect(ок, "роль смогла подменить dist").toBe(false);
  });

  it("роль НЕ пишет в .git/config (подмена core.hooksPath)", () => {
    const { repo } = buildFixture();
    execFileSync("/bin/bash", [SCRIPT, repo], { stdio: "ignore" });
    const ок = asRole(`printf "[core]\\n\\thooksPath = /tmp/evil\\n" >> .git/config`, repo);
    expect(ок, "роль смогла подменить .git/config").toBe(false);
    // Проверяем, что hooksPath не появился. Читаем БЕЗ окружения тестов
    // (setup.ts подставляет свой hooksPath через GIT_CONFIG_*).
    const значение = execFileSync(
      "/bin/bash",
      ["-c", "git config --get core.hooksPath || true"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: "0" } },
    ).trim();
    expect(значение).toBe("");
  });

  it("роль НЕ сдвигает ветку main", () => {
    const { repo } = buildFixture();
    execFileSync("/bin/bash", [SCRIPT, repo], { stdio: "ignore" });
    const до = sh("git rev-parse main", repo).trim();
    asRole(`git update-ref refs/heads/main HEAD`, repo);
    const после = sh("git rev-parse main", repo).trim();
    expect(после, "роль сдвинула main").toBe(до);
  });

  it("роль МОЖЕТ коммитить в свою ветку (работа не сломана)", () => {
    const { repo, roleWorktree } = buildFixture();
    execFileSync("/bin/bash", [SCRIPT, repo], { stdio: "ignore" });
    const ок = asRole(
      `echo y > y.txt && git add y.txt && git -c user.name=R -c user.email=r@x commit -qm "role commit" && git log --oneline -1`,
      roleWorktree,
    );
    expect(ок, "роль не может коммитить в свою ветку — сломали работу ролей").toBe(true);
    const лог = sh("git log --oneline -1", roleWorktree).trim();
    expect(лог).toContain("role commit");
  });

  it("роль МОЖЕТ читать репозиторий (контекст задачи)", () => {
    const { repo } = buildFixture();
    execFileSync("/bin/bash", [SCRIPT, repo], { stdio: "ignore" });
    const ок = asRole(`cat a.txt > /dev/null && git log --oneline -1 > /dev/null`, repo);
    expect(ок, "роль не может читать репозиторий — сломали чтение контекста").toBe(true);
  });

  it("база данных закрыта от роли (600)", () => {
    const { repo } = buildFixture();
    const db = path.join(repo, "server", "taskflow.db");
    fs.writeFileSync(db, "x");
    fs.chmodSync(db, 0o674);
    execFileSync("/bin/bash", [SCRIPT, repo], { stdio: "ignore" });
    const права = fs.statSync(db).mode & 0o777;
    expect(права & 0o077, "база доступна группе/остальным").toBe(0);
  });
});

describe("Скрипт harden-repo-access.sh (без применения)", () => {
  it("скрипт существует и синтаксически корректен", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    expect(() => execFileSync("/bin/bash", ["-n", SCRIPT], { stdio: "pipe" })).not.toThrow();
  });

  it("на не-репозитории выходит без ошибки", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-acl-empty-"));
    const вывод = execFileSync("/bin/bash", [SCRIPT, tmp], { encoding: "utf8" });
    expect(вывод).toContain("не похож на git-репозиторий");
  });
});
