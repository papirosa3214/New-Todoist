import { test, expect } from "@playwright/test";
import { setupApp, openScreen } from "./helpers";

// Чат агентов (/chat, 28.08.2026): точечная проверка формы отправки — то,
// что реально ломается тихо (текст не долетает, поле не чистится). Приход
// chat:new по сокету отдельно не эмулируется здесь (нет прецедента
// route.WebSocket в этом наборе, и риск нестабильного мока не стоит
// точечной цели) — тот путь проверен вручную живым обменом с Гермесом, см.
// комментарии задачи 76544f01.

test("сообщение из окна постановки уходит и чистит поле", async ({
  page,
  context,
}) => {
  // 28.08.2026, карточка 41ed0019: у владельца каналов два, и в своём он
  // адресата НЕ выбирает — вместо кнопки выбора стоит лицо собеседника.
  // Поэтому прежний шаг «сначала нажать „Кому?“» из этого теста ушёл:
  // нажимать больше нечего, и это не потеря проверки, а новое правило.
  // Выбор адресата остался у исполнителей — он проверяется следующим
  // тестом, под их учёткой.
  //
  // 10.09.2026, карточка 4396f8c9: собеседником в этой ленте стал
  // «Секретарь» вместо оркестратора — канал превратился в окно постановки
  // задач. Строка ввода по-прежнему подставляет адресата сама, но сервер
  // его в этом канале не слушает вовсе: у надиктовки адресата нет.
  const written = await setupApp(context);
  await openScreen(page, "/chat");

  const input = page.getByPlaceholder(/Секретарь/);
  await input.fill("проверка из e2e");
  // Кнопка отправки — иконка без accessible name, надёжный путь тут —
  // submit самой формы через Enter в поле.
  await input.press("Enter");
  await page.waitForTimeout(400);

  // /typing исключён явно: набор текста шлёт «печатает…» тем же префиксом
  // /api/chat, и без этого фильтра тест ловит его вместо самого сообщения.
  const chatPost = written.find(
    (w) =>
      w.method === "POST" &&
      w.url.includes("/api/chat") &&
      !w.url.includes("/read") &&
      !w.url.includes("/typing"),
  );
  expect(chatPost).toBeTruthy();
  expect((chatPost?.body as any)?.text).toBe("проверка из e2e");

  // Адресат проставлен сам, и это «Секретарь» — учётка скрипта, который
  // собирает карточку из надиктовки. Ищем его так же, как экран: машина
  // (type=ai), но не исполнитель (role=viewer).
  const secretaryId = await page.evaluate(async () => {
    const token = localStorage.getItem("taskflow_token");
    const res = await fetch("/api/chat/participants", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const people = (await res.json()) as Array<{
      id: string;
      role: string;
      type: string;
    }>;
    return people.find((p) => p.role === "viewer" && p.type === "ai")?.id;
  });
  expect(secretaryId).toBeTruthy();
  expect((chatPost?.body as any)?.to_user_id).toBe(secretaryId);
  await expect(input).toHaveValue("");
});

// Главная проверка задачи 7bdd1c9d: без адресата сообщение не уходит вовсе.
// Не «уходит и где-то теряется», а не отправляется — вместо этого
// раскрывается список, кому написать.
//
// Смотрим глазами ИСПОЛНИТЕЛЯ: с разделением каналов (41ed0019) выбор
// адресата остался только у них — у владельца в его канале собеседник один,
// а в служебную ленту он не пишет вовсе. Роль подменяется в ответе
// /api/auth/me: сама учётка остаётся владельцевой, меняется только то, чьими
// глазами экран себя рисует.
test("без выбранного адресата сообщение не отправляется", async ({
  page,
  context,
}) => {
  const written = await setupApp(context);
  await context.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.user.role = "agent";
    await route.fulfill({ response, json: body });
  });
  await openScreen(page, "/chat");

  const input = page.getByPlaceholder("Кому? выбери адресата");
  await input.fill("кому это вообще");
  await input.press("Enter");
  await page.waitForTimeout(400);

  const chatPost = written.find(
    (w) =>
      w.method === "POST" &&
      w.url.includes("/api/chat") &&
      !w.url.includes("/read") &&
      !w.url.includes("/typing"),
  );
  expect(chatPost).toBeFalsy();
  // Текст остался в поле — набранное не пропало, его есть кому адресовать.
  await expect(input).toHaveValue("кому это вообще");
  // И список адресатов открыт: отказ объясняет себя сам.
  await expect(page.getByRole("menuitem", { name: "Всем" })).toBeVisible();
});
