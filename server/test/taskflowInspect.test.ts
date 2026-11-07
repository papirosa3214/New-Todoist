import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInspectCommand, truncateOutput, runStagesLocal, createInspectTool, secretPathReason, pickMac, SECRET_EXCLUDE_GLOBS } from "../src/runtime/taskflowInspect.js";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";

migrate(); runMigrations();

const ok = (c: string) => expect(parseInspectCommand(c), c).toMatchObject({ ok: true });
const no = (c: string, why?: RegExp) => {
  const r = parseInspectCommand(c);
  expect(r.ok, c).toBe(false);
  if (why && !r.ok) expect(r.reason).toMatch(why);
};

describe("taskflow_inspect: белый список", () => {
  it("пропускает команды чтения", () => {
    for (const c of [
      "git status", "git log --oneline -n 5", "git diff HEAD~1", "git show abc123", "git branch --list 'roles/*'", "git branch -a",
      "git rev-parse HEAD", "git ls-files server", "git blame -L1,5 a.ts", "git remote -v",
      "rg -n 'foo|bar' src", "grep -rn foo .", "find . -name '*.ts'", "ls -la", "cat a.txt", "head -n 5 a", "tail -n 5 a", "wc -l a", "sort -u a",
      "uniq -c", "cut -d, -f1", "jq .a x.json", "stat a", "file a", "du -sh .", "df -h", "ps aux", "ps -ef", "pgrep -f node", "uptime", "free -m", "nvidia-smi", "nvidia-smi --query-gpu=name --format=csv",
      "systemctl --user status taskflow-server.service", "systemctl is-active x", "systemctl show x -p MainPID", "systemctl list-units --type=service",
      "journalctl --user -u taskflow-server -n 50 --no-pager", "sqlite3 -readonly db.sqlite 'select count(*) from tasks'", "sqlite3 -readonly db .tables",
      "curl -s http://127.0.0.1:3001/api/health", "curl -X GET http://x", "curl -sXGET http://x", "xcodebuild -list", "xcodebuild -showBuildSettings -scheme A",
      "ss -ltn", "ip addr", "sed -n '1,50p' file", "sed -E 's/a+/b/g' file", "sed -n '/foo/p' file | head -3", "sed '2d' a.txt", "sed -n -e '1p' -e '$p' a.txt", "awk '{print $1}' file", "awk -F, '{print $2}' file", "awk '$3 < 5 {print}' file", "awk '$3 > 100 {print $1}' file", "awk '$3 >= 100 && $2 != 0 {print $1, ($3 > 7)}' file", "awk '{ if ($1 > $2) print $1; else print $2 }' file", "awk '/a>b/ {print}' file", "ip -br addr show", "ping -c 3 127.0.0.1",
      "git log --oneline | head -5", "rg foo | sort | uniq -c | sort -rn | head", 'rg "a;b" src',
    ]) ok(c);
  });
  it("отказывает в изменяющих и опасных командах", () => {
    for (const c of [
      "rm -rf x", "mv a b", "cp a b", "touch a", "tee a", "bash -c ls", "sh -c ls", "python3 x.py", "node -e 1", "sudo ls", "kill 1", "env", "printenv", "/bin/ls",
      "git commit -m x", "git push", "git checkout x", "git reset --hard", "git -c core.pager=x log", "git config a b", "git remote add a b", "git remote", "git branch newone", "git branch -D x",
      "git diff --output=f", "git log --ext-diff",
      "find . -delete", "find . -exec rm {} +", "find . -execdir ls {} ;", "find . -fprint f",
      "tail -f a", "tail -F a", "sort -o out a", "journalctl -f", "journalctl --vacuum-size=1M", "journalctl --rotate",
      "systemctl restart x", "systemctl --user stop x", "systemctl daemon-reload", "systemctl enable x",
      "sqlite3 db 'select 1'", "sqlite3 -readonly db '.shell ls'", "sqlite3 -readonly db '.output f'", "sqlite3 -readonly db '.import a b'", "sqlite3 -readonly db 'attach \"x\" as y'", "sqlite3 -readonly db 'vacuum into \"f\"'", "sqlite3 -readonly db '.backup f'",
      "curl -X POST http://x", "curl -d a http://x", "curl --data-raw a http://x", "curl -F a=b http://x", "curl -T f http://x", "curl -o f http://x", "curl -O http://x", "curl --upload-file f http://x", "curl -sd a http://x", "curl --request=DELETE http://x",
      "xcodebuild build", "xcodebuild -scheme A test", "ip addr add 1.2.3.4 dev eth0", "ip link set x down", "ping 127.0.0.1", "ping -c 100 x", "ping -f -c 1 x",
      "sed -i 's/a/b/' file", "sed -i.bak 's/a/b/' file", "sed -ni '1p' file", "sed --in-place 's/a/b/' file", "sed -n -i '1p' file", "sed 's/a/b/w out' file", "sed 's/a/b/gw out' file", "sed -n 'w out' file", "sed 'e ls' file", "sed 's/a/b/e' file", "sed 'r .env' file", "sed -f script.sed file", "sed -s -n 'w x' a b",
      "awk 'BEGIN{system(\"ls\")}' file", "awk '{print > \"out\"}' file", "awk '{print >> \"out\"}' file", "awk '{print | \"sh\"}' file", "awk 'BEGIN{\"ls\" | getline x}' file", "awk -f prog.awk file", "awk '{getline < \".env\"}' file", "sed -n '1p' .env", "awk '{print}' .env",
      "nvidia-smi -pm 1", "ss -K", "uniq a b", "jq env x", "ps auxe", "cat /proc/1/environ",
    ]) no(c);
  });
  it("запрещает операторы shell", () => {
    no("ls; rm a", /;/); no("ls && ls", /&/); no("ls || ls", /\|\|/); no("ls > f", /перенаправ/); no("ls >> f"); no("cat < f"); no("ls &"); no("echo `id`", /подстановка/); no("ls $(id)", /подстановка/);
    no("ls | tee f"); no("ls |"); no("| ls"); no("ls\nrm a"); no("ls 2>&1"); no("ls 'abc"); no("ls | rm a");
  });
  it("конвейер допустим только между командами из списка", () => {
    ok("cat a | grep x | wc -l"); no("cat a | xargs rm"); no("cat a | sh");
  });
});

describe("taskflow_inspect: вывод и выполнение", () => {
  it("обрезает голову и хвост", () => {
    const text = Array.from({ length: 200 }, (_, i) => "l" + i).join("\n");
    const r = truncateOutput(text, 10);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(200);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("l0"); expect(lines[4]).toBe("l4"); expect(lines[5]).toContain("пропущено строк: 190"); expect(lines.at(-1)).toBe("l199");
    expect(truncateOutput("a\nb", 10)).toMatchObject({ truncated: false, text: "a\nb" });
  });
  it("запускает конвейер без shell и не интерпретирует метасимволы", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-"));
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "b\na\nb\n");
      const r = parseInspectCommand("cat a.txt | sort | uniq -c");
      expect(r.ok).toBe(true);
      const out = await runStagesLocal((r as any).stages, dir);
      expect(out.output.trim().split("\n").map(s => s.trim())).toEqual(["1 a", "2 b"]);
      const g = parseInspectCommand("grep -c '$HOME' a.txt");
      expect((await runStagesLocal((g as any).stages, dir)).output.trim()).toBe("0");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("инструмент: отказ без запуска, полный вывод — в файл рабочей папки роли", async () => {
    const roles = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-roles-"));
    const prev = process.env.TASKFLOW_ROLES_DIR;
    process.env.TASKFLOW_ROLES_DIR = roles;
    try {
      const tool = createInspectTool("builder");
      expect(tool.name).toBe("taskflow_inspect");
      await expect(tool.execute("1", { command: "rm -rf /tmp/x" })).rejects.toThrow(/команда не входит в список чтения: /);
      fs.mkdirSync(path.join(roles, "builder", "workspace"), { recursive: true });
      fs.writeFileSync(path.join(roles, "builder", "workspace", "big.txt"), Array.from({ length: 300 }, (_, i) => "row" + i).join("\n"));
      const res: any = await tool.execute("2", { command: "cat big.txt", max_lines: 20 });
      const text: string = res.content[0].text;
      expect(text).toContain("row0"); expect(text).toContain("row299"); expect(text).not.toContain("row150");
      const file = /полный вывод \(300 строк\): ([^\]\s]+)/.exec(text)![1];
      expect(fs.readFileSync(file, "utf8")).toContain("row150");
    } finally { if (prev === undefined) delete process.env.TASKFLOW_ROLES_DIR; else process.env.TASKFLOW_ROLES_DIR = prev; fs.rmSync(roles, { recursive: true, force: true }); }
  });
});

describe("taskflow_inspect: секреты, глобы, симлинки", () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "inspect-sec-"));
  it("имена секретов", () => {
    for (const p of [".env", ".env.local", "a/b.pem", "x.key", "id_rsa", "id_ed25519.pub", "/home/u/.ssh/config", "~/.gnupg/x", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
      "/home/u/.aws/credentials", "/home/u/.config/gh/hosts.yml", "credentials.json", "secrets.yaml", "my-token.txt", "/proc/123/environ", "/home/u/.claude/age-key.txt", "/home/u/.claude/vault-run.py", "/home/u/.claude/memory/secrets.age"])
      expect(secretPathReason(p), p).not.toBeNull();
    for (const p of ["src/a.ts", "README.md", "environment.md", "a/b/c.txt"]) expect(secretPathReason(p), p).toBeNull();
  });
  it("любая команда списка не читает секреты, включая cwd и rev:путь", () => {
    const dir = mk();
    try {
      for (const c of ["cat .env", "head -n 3 .env.local", "tail -n 2 id_rsa", "rg foo .env", "grep x credentials.json", "find .ssh -type f", "jq . secrets.json", "sqlite3 -readonly my-token.db .tables",
        "stat server.pem", "file a.key", "git show HEAD:.env", "git log -- .env", "cat /proc/1/environ", "cat ~/.ssh/id_rsa", "curl file:///etc/passwd", "ls ~/.aws"])
        expect(parseInspectCommand(c, { cwd: dir, expand: true }).ok, c).toBe(false);
      const r = parseInspectCommand("ls", { cwd: path.join(dir, ".ssh") });
      expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toMatch(/рабочая папка/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("шаблон поиска, похожий на секрет, не путь", () => {
    expect(parseInspectCommand("rg token src", { cwd: os.tmpdir(), expand: true }).ok).toBe(true);
    expect(parseInspectCommand("rg '.env' src", { cwd: os.tmpdir(), expand: true }).ok).toBe(true);
    expect(parseInspectCommand("git log --grep token", { cwd: os.tmpdir() }).ok).toBe(true);
  });
  it("rg и grep получают исключающие glob, а не отказ", () => {
    const rg: any = parseInspectCommand("rg foo", { cwd: os.tmpdir() });
    expect(rg.ok).toBe(true);
    const a: string[] = rg.stages[0];
    for (const g of SECRET_EXCLUDE_GLOBS) expect(a).toContain("!" + g);
    const gr: any = parseInspectCommand("grep -r foo . -- x", { cwd: os.tmpdir() });
    expect(gr.stages[0]).toContain("--exclude=.env*"); expect(gr.stages[0]).toContain("--exclude-dir=.ssh");
    expect(gr.stages[0].indexOf("--exclude=.env*")).toBeLessThan(gr.stages[0].indexOf("--"));
    expect(parseInspectCommand("rg -L foo", { cwd: os.tmpdir() }).ok).toBe(false);
  });
  it("обход через симлинк закрыт по realpath", () => {
    const dir = mk();
    try {
      fs.writeFileSync(path.join(dir, ".env"), "A=1");
      fs.symlinkSync(path.join(dir, ".env"), path.join(dir, "link.txt"));
      const r = parseInspectCommand("cat link.txt", { cwd: dir, expand: true });
      expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toMatch(/симлинк/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("глобы раскрываются сами, секреты внутри раскрытия отклоняются, лимит 500", async () => {
    const dir = mk();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n"); fs.writeFileSync(path.join(dir, "b.txt"), "2\n"); fs.writeFileSync(path.join(dir, "c.log"), "x\n");
      const r: any = parseInspectCommand("cat *.txt", { cwd: dir, expand: true });
      expect(r.stages[0]).toEqual(["cat", "a.txt", "b.txt"]);
      expect(parseInspectCommand("cat [ab].txt", { cwd: dir, expand: true })).toMatchObject({ ok: true, stages: [["cat", "a.txt", "b.txt"]] });
      expect((await runStagesLocal(r.stages, dir)).output).toBe("1\n2\n");
      expect((parseInspectCommand("cat nomatch*", { cwd: dir, expand: true }) as any).stages[0]).toEqual(["cat", "nomatch*"]);
      fs.writeFileSync(path.join(dir, "my-token.txt"), "s");
      expect(parseInspectCommand("cat *token*", { cwd: dir, expand: true }).ok).toBe(false);
      for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(dir, "f" + i + ".dat"), "");
      const big = parseInspectCommand("ls *.dat", { cwd: dir, expand: true });
      expect(big.ok).toBe(false); if (!big.ok) expect(big.reason).toMatch(/500/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("mac: без host нет «первой попавшейся» машины", () => {
    expect(() => pickMac()).toThrow(/онлайн|Онлайн/);
    expect(() => pickMac("no-such-machine")).toThrow(/не найдена/);
  });
});
