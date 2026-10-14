import { execFile } from "node:child_process";

/**
 * Ключ машины лежит в Keychain мака (D7): не в файле рядом с программой и не в
 * коде. Читается утилитой `security`, которая на Linux и в тестах есть не
 * всегда — поэтому исполнение подменяется, а не ветвится по платформе.
 */
export interface KeyReader {
  /** Где взят ключ — попадает в лог при старте, чтобы было видно, откуда он. */
  readonly source: string;
  read(): Promise<string>;
}

export class KeychainError extends Error {}

export interface ExecRunner {
  (file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

const defaultExec: ExecRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") {
        reject(new KeychainError(`не запустилась ${file}: ${error.message}`));
        return;
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });

/**
 * `security find-generic-password -w` печатает пароль в stdout и кодом 44
 * отвечает «не найдено». Ключ не должен быть пустым или короче 16 символов:
 * иначе это не ключ машины, а мусор в конфиге.
 */
export function macKeychainReader(
  options: { service: string; account: string; exec?: ExecRunner; minLength?: number },
): KeyReader {
  const exec = options.exec ?? defaultExec;
  const minLength = options.minLength ?? 16;
  return {
    source: `keychain:${options.service}/${options.account}`,
    async read() {
      const { code, stdout, stderr } = await exec("security", [
        "find-generic-password",
        "-a",
        options.account,
        "-s",
        options.service,
        "-w",
      ]);
      if (code !== 0) {
        const detail = stderr.trim().split("\n")[0] || `код ${code}`;
        throw new KeychainError(
          `ключ машины не найден в Keychain (${options.service}/${options.account}): ${detail}. Выпусти ключ на .110 и положи его командой install-keychain.sh`,
        );
      }
      const key = stdout.trim();
      assertKey(key, minLength, `keychain:${options.service}/${options.account}`);
      return key;
    },
  };
}

function assertKey(key: string, minLength: number, source: string): void {
  if (!key) throw new KeychainError(`ключ пустой (${source})`);
  if (key.length < minLength) throw new KeychainError(`ключ короче ${minLength} символов (${source}) — это не ключ машины`);
}

/**
 * Запасной источник для разработки и тестов. Включается только явным
 * TASKFLOW_HOST_ALLOW_ENV_KEY=1: в боевом режиме молчаливый обход Keychain
 * означал бы, что ключ уехал в окружение процесса.
 */
export function envKeyReader(name = "TASKFLOW_HOST_KEY", minLength = 16, env: NodeJS.ProcessEnv = process.env): KeyReader {
  return {
    source: `env:${name}`,
    async read() {
      const key = env[name] ?? "";
      assertKey(key, minLength, `env:${name}`);
      return key.trim();
    },
  };
}

export interface KeyReaderOptions {
  exec?: ExecRunner;
  env?: NodeJS.ProcessEnv;
}

/**
 * Выбор источника ключа. По умолчанию — Keychain. Переменная окружения
 * допускается только при явном разрешении.
 */
export function resolveKeyReader(
  config: { keychainService: string; keychainAccount: string },
  options: KeyReaderOptions = {},
): KeyReader {
  const env = options.env ?? process.env;
  if (env["TASKFLOW_HOST_ALLOW_ENV_KEY"] === "1") {
    return envKeyReader("TASKFLOW_HOST_KEY", 16, env);
  }
  return macKeychainReader({ service: config.keychainService, account: config.keychainAccount, exec: options.exec });
}

/**
 * Команда для записи ключа в Keychain. Значение намеренно не передаётся
 * аргументом: `security` сам спросит его, иначе ключ на секунду мелькнул бы в
 * выводе `ps`. Используется скриптом install-keychain.sh.
 */
export function keychainAddCommand(service: string, account: string): { file: string; args: string[] } {
  return {
    file: "security",
    args: ["add-generic-password", "-U", "-a", account, "-s", service, "-D", "user", "-j", "taskflow-host: ключ машины для шлюза TaskFlow"],
  };
}