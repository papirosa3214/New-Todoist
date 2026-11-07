import { test, expect } from "@playwright/test";
import { setupApp, openScreen } from "./helpers";

// Два канала чата (28.08.2026, карточка 41ed0019). Проверяется то, ради
// чего задача заводилась: в первой ленте владельца нет исполнителей, а
// служебная переписка — рядом, отдельной вкладкой, и втянуть его в неё нечем.
//
// 10.09.2026, карточка 4396f8c9: первая лента перестала быть разговором с
// оркестратором и стала окном постановки задач, а её собеседник называется
// «Секретарь» — это учётка скрипта, который собирает карточку из надиктовки.
// Правило «в этой ленте только владелец и его собеседник» от смены смысла не
// изменилось, поменялось лишь имя.
//
// Набор открывает экран под учёткой владельца (вход по домашней сети — см.
// helpers.ts) и глушит любые записи, поэтому смотреть его вид можно, ничего
// в базе не меняя.

test("в окне постановки задач нет исполнителей", async ({ page, context }) => {
  await setupApp(context);
  await openScreen(page, "/chat");

  // Вкладки на месте, первая названа именем собеседника.
  const draftTab = page.getByRole("button", {
    name: "Секретарь",
    exact: true,
  });
  const agentsTab = page.getByRole("button", { name: "Агенты", exact: true });
  await expect(draftTab).toBeVisible();
  await expect(agentsTab).toBeVisible();

  // Ни одного исполнителя в его ленте — проверяем по АВТОРАМ сообщений, а
  // не по тексту экрана: имена агентов сплошь и рядом упоминаются внутри
  // самих сообщений («две уже раздал DeepSeek»), и поиск по странице ловил
  // бы разговор о них как участие их в разговоре.
  const feed = await page.evaluate(async () => {
    const token = localStorage.getItem("taskflow_token");
    const res = await fetch("/api/chat?channel=owner", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return (await res.json()).messages as Array<{
      channel: string;
      from_user_name: string;
    }>;
  });
  expect(feed.length).toBeGreaterThan(0);
  for (const m of feed) {
    expect(m.channel).toBe("owner");
    // «Оркестратор Claude» остаётся в списке ради истории: его прежние
    // сообщения из этой ленты никуда не делись, и учётка из чата не убрана —
    // она лишь перестала быть адресатом поручений.
    expect(["Максим", "Оркестратор Claude", "Секретарь"]).toContain(
      m.from_user_name,
    );
  }

  // Адресат в этом канале не выбирается — вместо кнопки-робота стоит лицо
  // собеседника, и кнопки «Кому? адресат не выбран» здесь быть не должно.
  await expect(
    page.getByRole("button", { name: "Кому? адресат не выбран" }),
  ).toHaveCount(0);
  await expect(page.getByLabel(/^Кому: Секретарь/)).toBeVisible();

  // Писать сюда можно — это и есть постановка задачи.
  await expect(page.getByPlaceholder(/Секретарь/)).toBeVisible();

  // Снимок для карточки: владелец смотрит работу глазами, а не по списку
  // пройденных проверок.
  await page.screenshot({ path: "/tmp/chat-owner-channel.png" });
});

test("служебная лента открыта владельцу и на чтение, и на запись", async ({
  page,
  context,
}) => {
  await setupApp(context);
  await openScreen(page, "/chat");

  await page.getByRole("button", { name: "Агенты", exact: true }).click();
  await page.waitForTimeout(1200);

  // Переписку исполнителей он видит…
  const feed = await page.locator("body").innerText();
  expect(feed).toMatch(/DeepSeek|Hermes|Claude_Bot|Antigravity/);

  // …и может написать в неё сам, выбрав конкретного исполнителя. Первый
  // заход прятал здесь строку ввода, и владелец это отменил (28.08.2026):
  // разгружали его от чужой переписки, а не отбирали доступ.
  const picker = page.getByRole("button", { name: "Кому? адресат не выбран" });
  await expect(picker).toBeVisible();
  await picker.click();

  // В списке адресатов и «Всем», и поимённо роли (15.09.2026 скрыли
  // шесть исторических учёток — Hermes/DeepSeek/Claude_Bot и др., теперь
  // видны только 8 смысловых ролей через Pi-agent harness) — выбираем
  // одну конкретную роль, ровно тот случай, ради которого владелец просил
  // доступ вернуть: «мало ли мне приспичит кого-то конкретно озадачить».
  // Пункты меню объявлены как menuitem (ActionsMenu), роль button их не ловит.
  await expect(
    page.getByRole("menuitem", { name: "Всем", exact: true }),
  ).toBeVisible();
  const someone = page
    .getByRole("menuitem")
    .filter({ hasText: /Разработчик|Архитектор/ })
    .first();
  await expect(someone).toBeVisible();
  // force: меню всплывает с анимацией масштаба, и webkit считает его
  // «нестабильным» ровно столько, сколько длится проверка. Видимость уже
  // подтверждена строкой выше, ждать неподвижности незачем.
  await someone.click({ force: true });
  await expect(page.getByLabel(/^Кому: /)).toBeVisible();

  await page.screenshot({ path: "/tmp/chat-agents-channel.png" });
});
