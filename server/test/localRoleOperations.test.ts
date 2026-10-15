// Изоляция роли на .110 (16.10.2026): bash от tfrole, файлы — только в рабочей
// копии. Тесты на bash пропускаются, если на машине нет tfrole/sudoers.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { guardPath, isolatedLocalOperations, roleRoots, ROLE_USER } from "../src/runtime/localRoleOperations.js";

const work = fs.mkdtempSync(path.join(os.homedir(), ".local", "state", "taskflow-runs", "worktrees", "iso-test-"));
const roleReady = (() => {
  try { execFileSync("sudo", ["-n", "-u", ROLE_USER, "/bin/bash", "-c", "true"]); return true; } catch { return false; }
})();

async function run(cmd: string): Promise<{ code: number | null; out: string }> {
  const ops = isolatedLocalOperations(work);
  let out = "";
  const r = await ops.bash.exec(cmd, work, { onData: (b) => { out += b.toString(); } });
  return { code: r.exitCode, out };
}

describe("файловые инструменты роли", () => {
  it("пускают в рабочую копию и не пускают в ~/.ssh", async () => {
    const ops = isolatedLocalOperations(work);
    await ops.write.writeFile(path.join(work, "a.txt"), "ok");
    expect((await ops.read.readFile(path.join(work, "a.txt"))).toString()).toBe("ok");
    await expect(ops.read.readFile(path.join(os.homedir(), ".ssh", "id_rsa"))).rejects.toThrow(/запрещено/);
    await expect(ops.write.writeFile(path.join(os.homedir(), "x.txt"), "x")).rejects.toThrow(/запрещено/);
  });

  it("не выпускают наружу через символическую ссылку", () => {
    const link = path.join(work, "ssh-link");
    fs.symlinkSync(path.join(os.homedir(), ".ssh"), link);
    expect(() => guardPath(path.join(link, "id_rsa"), roleRoots(work).read, "чтение")).toThrow(/запрещено/);
  });
});

describe.skipIf(!roleReady)("bash роли", () => {
  it("исполняется от tfrole в рабочей копии", async () => {
    const r = await run("whoami; pwd");
    expect(r.out).toContain(ROLE_USER);
    expect(r.out).toContain(fs.realpathSync(work));
  });

  it("не читает ключ ssh и ключ vault владельца", async () => {
    const r = await run(`cat ${os.homedir()}/.ssh/id_rsa >/dev/null 2>&1 && echo SSH-OPEN; cat ${os.homedir()}/.claude/age-key.txt >/dev/null 2>&1 && echo VAULT-OPEN; echo done`);
    expect(r.out).not.toContain("SSH-OPEN");
    expect(r.out).not.toContain("VAULT-OPEN");
    expect(r.out).toContain("done");
  });

  it("не видит секреты из окружения сервера", async () => {
    process.env.TF_TEST_SECRET = "s3cr3t";
    const r = await run("echo [$TF_TEST_SECRET]");
    expect(r.out).toContain("[]");
  });
});
