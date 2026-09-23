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

// Управляемый список участников — мок регистрируется ПОСЛЕ setupApp, чтобы
// его pass-through для GET не ушёл в сеть (playwright применяет route в
// обратном порядке регистрации, и наш fulfill перебивает continue).
const MENTION_PARTICIPANTS_BODY = JSON.stringify([
  {
    id: "u-secretary",
    name: "Секретарь",
    type: "ai",
    role: "viewer",
    avatar_color: "#A6A6A6",
    initials: "С",
  },
  {
    id: "u-alice",
    name: "Alice",
    type: "human",
    role: "agent",
    avatar_color: "#A6A6A6",
    initials: "A",
  },
  {
    id: "u-bob",
    name: "Bob",
    type: "human",
    role: "agent",
    avatar_color: "#A6A6A6",
    initials: "B",
  },
  {
    id: "u-carol",
    name: "Carol",
    type: "human",
    role: "agent",
    avatar_color: "#A6A6A6",
    initials: "C",
  },
]);

// Главная проверка карточки eb4759ea: при вводе @ в строке чата появляется
// выпадающий список участников, фильтр по подстроке, выбор через Enter
// вставляет @Имя в текст, и сообщение уходит именно с этим упоминанием.
test("выбор агента через @ вставляет упоминание и уходит с ним", async ({
  page,
  context,
}) => {
  const written = await setupApp(context);
  await context.route("**/api/chat/participants", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: MENTION_PARTICIPANTS_BODY,
    });
  });
  await openScreen(page, "/chat");

  const input = page.getByPlaceholder(/Секретарь/);
  await input.click();

  // 1) Сразу после @ — весь список из трёх «агентов». Секретарь в нём
  // НЕТ: композер фильтрует viewer+ai (миграция 028).
  await input.type("@");
  const listbox = page.getByRole("listbox", { name: /Упоминание/ });
  await expect(listbox).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Alice/ }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: /Bob/ })).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Carol/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Секретарь/ }),
  ).toHaveCount(0);

  // 2) Фильтр — префикс «bo» оставляет только Bob.
  await input.type("bo");
  await expect(
    page.getByRole("option", { name: /Alice/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("option", { name: /Bob/ })).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Carol/ }),
  ).toHaveCount(0);

  // 3) Enter по выбранному — в тексте появляется @Bob с пробелом, дропдаун
  // закрывается, курсор стоит после пробела.
  await input.press("Enter");
  await expect(listbox).toHaveCount(0);
  await expect(input).toHaveValue("@Bob ");

  // 4) Дописываем сообщение и отправляем.
  await input.type("посмотри пожалуйста");
  await input.press("Enter");
  await page.waitForTimeout(400);

  const chatPost = written.find(
    (w) =>
      w.method === "POST" &&
      w.url.includes("/api/chat") &&
      !w.url.includes("/read") &&
      !w.url.includes("/typing"),
  );
  expect(chatPost).toBeTruthy();
  expect((chatPost?.body as any)?.text).toBe(
    "@Bob посмотри пожалуйста",
  );
  // Адресат — Секретарь, как и в других тестах владельца: фиксированный
  // собеседник канала «owner» идёт из counterpart, а не из упоминания.
  expect((chatPost?.body as any)?.to_user_id).toBe("u-secretary");
  await expect(input).toHaveValue("");
});

// Альтернативный путь: клавиатура показала дропдаун, но выбор пошёл мышью
// (владелец привык к «тапнуть, не отпуская стрелку»). Та же вставка @Имя.
test("выбор агента через @ мышью по пункту дропдауна", async ({
  page,
  context,
}) => {
  const written = await setupApp(context);
  await context.route("**/api/chat/participants", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: MENTION_PARTICIPANTS_BODY,
    });
  });
  await openScreen(page, "/chat");

  const input = page.getByPlaceholder(/Секретарь/);
  await input.click();
  await input.type("@car");
  await expect(
    page.getByRole("option", { name: /Alice/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("option", { name: /Bob/ })).toHaveCount(0);
  const carol = page.getByRole("option", { name: /Carol/ });
  await expect(carol).toBeVisible();
  await carol.click();

  await expect(
    page.getByRole("listbox", { name: /Упоминание/ }),
  ).toHaveCount(0);
  // В самом input пробел остаётся — он нужен, чтобы следующий символ
  // шёл уже после упоминания, а не слипался с @Carol.
  await expect(input).toHaveValue("@Carol ");

  await input.type("глянь");
  await input.press("Enter");
  await page.waitForTimeout(400);
  const chatPost = written.find(
    (w) =>
      w.method === "POST" &&
      w.url.includes("/api/chat") &&
      !w.url.includes("/read") &&
      !w.url.includes("/typing"),
  );
  expect((chatPost?.body as any)?.text).toBe("@Carol глянь");
});

// Escape в активном дропдауне — закрывает его, текст @… остаётся в поле.
// Это «отмена без потери»: пользователь может стереть @ руками и набрать
// заново, не отправляя лишнего.
test("Escape закрывает @-дропдаун без вставки", async ({
  page,
  context,
}) => {
  const written = await setupApp(context);
  await context.route("**/api/chat/participants", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: MENTION_PARTICIPANTS_BODY,
    });
  });
  await openScreen(page, "/chat");

  const input = page.getByPlaceholder(/Секретарь/);
  await input.click();
  await input.type("@");
  const listbox = page.getByRole("listbox", { name: /Упоминание/ });
  await expect(listbox).toBeVisible();

  await input.press("Escape");
  await expect(listbox).toHaveCount(0);
  // Текст не исчез — только дропдаун закрылся.
  await expect(input).toHaveValue("@");

  // Enter после Escape — это уже отправка формы, а не вставка.
  await input.press("Enter");
  await page.waitForTimeout(400);
  const chatPost = written.find(
    (w) =>
      w.method === "POST" &&
      w.url.includes("/api/chat") &&
      !w.url.includes("/read") &&
      !w.url.includes("/typing"),
  );
  // Сообщение из одного символа @ уйдёт (текст.trim() === "@" — не пусто),
  // но это уже работа существующего submit, не дропдауна. Здесь это даже
  // полезно: проверяем, что Enter после Escape не выбирает пункт.
  expect(chatPost).toBeTruthy();
  expect((chatPost?.body as any)?.text).toBe("@");
});
