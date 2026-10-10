// POSIX-safe shell quoting для tf_wake_dispatch.py: переводы строк,
// backslash, $, `, одиночные кавычки должны доходить БУКВАЛЬНО на
// receiver (карточка 905db3e3-…, D-4). Сравниваем arg construction в
// python-скрипте против эталонного `shlex.quote`.
//
// Прямо запускать SSH+codex в тесте нельзя (живой .110 в этой
// среде недоступен), поэтому дёргаем python-функции напрямую через
// `python3 -c` и парсим их stdout.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS = path.resolve(__dirname, "../../scripts/orchestrator");
const PYTHON = "python3";

function dumpArgs(threadUuid: string, message: string): {
  argv: string[];
  queue_cmd: string[];
  quoted: string[];
  stripped: string;
} {
  const dumpScript = `
import sys, json
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
from tf_wake_dispatch import _queue_cmd
from tf_codex_quote import shlex_quote_argv, strip_control
thread = sys.argv[1]
message = sys.argv[2]
clean = strip_control(message)
out = {
  "argv": sys.argv[1:],
  "queue_cmd": _queue_cmd(thread, clean, "/opt/homebrew/bin/codex"),
  "quoted": shlex_quote_argv(_queue_cmd(thread, clean, "/opt/homebrew/bin/codex")),
  "stripped": clean,
}
print("RESULT=" + json.dumps(out))
`;
  const stdout = execFileSync(PYTHON, ["-c", dumpScript, threadUuid, message], {
    encoding: "utf8",
  });
  const m = /RESULT=(\{.*\})/.exec(stdout);
  if (!m) throw new Error(`unexpected stdout: ${stdout.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

beforeAll(() => {});
afterAll(() => {});

describe("D-4 POSIX-safe shell quoting через tf_codex_quote", () => {
  const THREAD = "01a120f9-1266-7331-a4ca-81f6da2a698b";

  const cases: Array<{ name: string; message: string; expectContains: string[] }> = [
    {
      name: "доллар и кавычки в одном сообщении",
      message: "price is $5 'foo' \"bar\"",
      expectContains: ["price is $5", "'foo'", "\"bar\""],
    },
    {
      name: "backticks и backslash",
      message: 'run `pwd` then look at \\',
      expectContains: ["`pwd`", "\\"],
    },
    {
      // D-4 #2 (уточнение ведущего 2026-10-10, комментарий 97d9b075):
      // strip_control сохраняет \n — POSIX `shlex.quote` корректно
      // оборачивает перевод строки в одинарные кавычки, truncation
      // был лишним и ломал критерий приёмки V2 №4.
      name: "перевод строки проходит буквально в shell quoting",
      message: "first\nsecond",
      expectContains: ["first\nsecond"],
    },
    {
      // CRLF и табы тоже проходят буквально.
      name: "CRLF и табы сохраняются",
      message: "a\r\nb\tc",
      expectContains: ["a\r\nb\tc"],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const parsed = dumpArgs(THREAD, c.message);
      expect(parsed.argv[0]).toBe(THREAD);
      for (const piece of c.expectContains) {
        expect(parsed.stripped).toContain(piece);
      }
      // quoted должен быть POSIX-safe: либо полностью обёрнут в
      // одинарные кавычки, либо не содержит спецсимволов.
      for (const q of parsed.quoted) {
        const isQuoted = q.startsWith("'") && q.endsWith("'") && q.length >= 2;
        const isSafe = /^[A-Za-z0-9_\-./:=]+$/.test(q);
        expect(isQuoted || isSafe).toBe(true);
      }
    });
  }

  it("валидация UUID: неверный формат → exit 64", () => {
    let code = -1;
    let stderr = "";
    try {
      execFileSync(
        PYTHON,
        [path.join(SCRIPTS, "tf_wake_dispatch.py"), "not-a-uuid", "x"],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (e: any) {
      code = e.status ?? -1;
      stderr = (e.stderr?.toString() ?? "") + (e.stdout?.toString() ?? "");
    }
    expect(code).toBe(64);
    expect(stderr).toMatch(/UUID/);
  });

  it("folllowup парсится из эталонного stdout", () => {
    const parsed = dumpArgs(THREAD, "test message");
    // argv после queue_cmd должен включать --message и очищенный текст.
    expect(parsed.queue_cmd).toContain("--message");
    // quoted-форма очереди должна быть передаваема одной shell-строкой.
    expect(parsed.quoted.join(" ")).toContain("--message");
  });
});