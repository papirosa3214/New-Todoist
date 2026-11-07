#!/usr/bin/env node
// Точка входа демона. launchd запускает `node dist/index.js`; руками —
// `npm start` или `npm run dev`. Демон не должен падать при обрыве: всю
// переподключающую логику держит HostClient, здесь только конфиг, ключ и
// корректное завершение по сигналу.
import { describeConfig, ConfigError, configPath, loadConfig } from "./config.js";
import { HostClient, HOST_VERSION } from "./client.js";
import { KeychainError, resolveKeyReader } from "./keychain.js";
import { createLog } from "./log.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--version")) {
    process.stdout.write(`taskflow-host ${HOST_VERSION}\n`);
    return;
  }

  // Конфиг читаем до лога: неизвестный флаг должен сказать о себе сам.
  const config = loadConfig(argv);
  const log = createLog("taskflow-host", { level: config.logLevel });

  if (argv.includes("--print-config")) {
    // Без ключа: печатать секрет в stdout демона незачем.
    log.info("конфигурация хоста", { file: configPath(argv) });
    process.stdout.write(describeConfig(config) + "\n");
    return;
  }

  const reader = resolveKeyReader(config);
  const key = await reader.read();
  log.info("запускаюсь", { version: HOST_VERSION, platform: process.platform, keychain: reader.source, roots: config.roots.join(",") });

  const client = new HostClient({ config, key, log });
  client.on("phase", (phase: string) => log.debug("состояние", { phase }));

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("останавливаюсь", { signal });
    void client.stop().then(() => process.exit(0));
    // Страховка: если сокет завис и не закрылся — выходим по таймауту.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  client.start();
}

main().catch((error) => {
  // Пишем в stderr, а не через лог: лог ещё не собран, а именно эту строку
  // владелец видит в launchd-логе при первом же падении.
  const message = error instanceof Error ? error.message : String(error);
  const kind = error instanceof ConfigError ? "ошибка конфигурации" : error instanceof KeychainError ? "ошибка ключа" : "хост не запустился";
  process.stderr.write(`${kind}: ${message}\n`);
  process.exitCode = 1;
});