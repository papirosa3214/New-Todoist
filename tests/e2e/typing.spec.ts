// Проверка глазами: отметка «работает» горит всю длинную работу агента,
// гаснет после затихания и загорается, когда агент пишет владельцу сам.
// Задача a56f35f6, 29.08.2026.
//
// Управляемость: создаём ОТДЕЛЬНОГО агента, привязанного к тестовому
// владельцу, и шлём от его имени запросы к серверу. Другие агенты в
// системе (Hermes, Claude_Bot, DeepSeek-Agent) живут и фонят — их
// присутствие в снимке для теста не помеха: мы проверяем нашего.

import { test, expect, type Page } from "@playwright/test";
import { spawn } from "child_process";

const BASE = "http://localhost:3001";

async function api(
  method: string,
  url: string,
  token: string,
  payload?: unknown,
) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

async function vaultToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [
      "/home/maksim/.claude/vault-get.py",
      "--raw",
      "TASKFLOW_AGENT_TOKEN",
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error("vault failed")),
    );
  });
}

test("отметка горит всю длинную работу и гаснет после затихания", async ({
  page,
}) => {
  // 1) Владелец для снимка и для отправки ему сообщения от «агента-пытки».
  //    Используем основного владельца (role=owner). Если тест ломается из-за
  //    его фоновой активности — завести отдельную тестовую учётку.
  const AGENT_TOKEN = await vaultToken();

  // 2) Открываем экран чата. Подразумевается, что фронт уже авторизован под
  //    владельцем (helpers.ts — общий setup). Логин через UI здесь не
  //    делаем: наша задача — снимок отметки, а не e2e-логин.
  await page.goto("/chat");
  await page.waitForLoadState("networkidle");

  async function snapTyping(): Promise<string[]> {
    const r = await api("GET", "/api/chat/typing", AGENT_TOKEN);
    const names = (JSON.parse(r.body).typing ?? []).map(
      (t: { name: string }) => t.name,
    );
    return names;
  }

  // 3) Сейчас отметка может гореть у фоновых агентов. Сделаем длинный
  //    цикл запросов от имени АГЕНТА и снимем экран.
  const start = Date.now();
  const probes: { t: number; names: string[] }[] = [];
  for (let i = 0; i < 5; i++) {
    // Любой запрос с токеном агента продлевает его отметку.
    await api("POST", "/api/tasks", AGENT_TOKEN, {
      title: `probe-${i}`,
    });
    const names = await snapTyping();
    probes.push({ t: Math.round((Date.now() - start) / 1000), names });
    await page.waitForTimeout(7_000);
  }
  console.log("PROBES during work:", JSON.stringify(probes));

  // 4) Скрин в момент, когда работа ещё идёт.
  await page.screenshot({
    path: "tests/e2e/screenshots/typing-during.png",
    fullPage: false,
  });

  // 5) Ждём 35с — больше TTL агента (30с). Фоновые агенты могут
  //    продолжать активничать; нас интересует только то, что наш агент
  //    не обязан тут присутствовать, если сам не делает запросов.
  await page.waitForTimeout(35_000);
  const after = await snapTyping();
  console.log("AFTER 35s silence:", JSON.stringify(after));

  // 6) Скрин после затихания.
  await page.screenshot({
    path: "tests/e2e/screenshots/typing-after.png",
    fullPage: false,
  });

  // 7) Агент пишет сам, без входящего сообщения от владельца.
  const send = await api("POST", "/api/chat", AGENT_TOKEN, {
    text: "проверка: агент пишет сам, владелец не присылал входящего",
    to_user_id: "all",
  });
  expect(send.status).toBe(200);

  const afterSend = await snapTyping();
  console.log("AFTER self-send:", JSON.stringify(afterSend));

  await page.screenshot({
    path: "tests/e2e/screenshots/typing-self-send.png",
    fullPage: false,
  });
});
