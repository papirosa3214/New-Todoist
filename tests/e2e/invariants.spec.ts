import { test, expect } from "@playwright/test";
import { setupApp, openScreen, collectErrors } from "./helpers";

// Общие инварианты: то, что должно быть верно на КАЖДОМ экране, независимо
// от того, чем этот экран занят. Отдельным файлом, а не по одной проверке в
// каждом спеке: правило одно, и когда оно нарушится, чинить надо один раз.
//
// Почему именно эти три:
//  • ошибки консоли — тихий краш экрана уже случался (19.08.2026, namespace-
//    коллизия: экран пустой, тестам «всё хорошо»);
//  • горизонтальная прокрутка страницы — верный признак, что что-то вылезло
//    за 420pt: у владельца телефон, и «уехало вбок» он видит сразу;
//  • сохранённый вид (список/доска/часы) обязан пережить переход на другой
//    экран и обратно — это то, ради чего вид вообще хранится.
// 09.09.2026: был "/inbox" — экран заменён на «Обзор» ещё 30.08.2026
// (коммит 0cc4d0f1), маршрута с таким адресом в приложении нет. Тест от
// этого не краснел: страница «Не найдено» ошибок консоли не даёт и вбок
// не уезжает, так что проверка молча шла по несуществующему экрану и
// поймать на нём ничего не могла.
const SCREENS = [
  "/overview",
  "/today",
  "/upcoming",
  "/projects",
  "/labels",
  "/activity",
  "/notifications",
  "/search",
  "/settings",
  "/agents",
];

test.describe("Общие инварианты экранов", () => {
  test("ни один экран не даёт ошибок консоли и не уезжает вбок", async ({
    page,
    context,
  }) => {
    // Свой таймаут вместо общих 45 секунд: обход десяти ЖИВЫХ экранов с
    // ожиданием сети — это около полутора минут. В общий бюджет проверка
    // укладывалась, только пока первым в списке стоял несуществующий
    // адрес: страница «Не найдено» открывается мгновенно и данных не ждёт.
    test.setTimeout(150_000);
    await setupApp(context);
    const errors = collectErrors(page);
    const wide: string[] = [];

    for (const path of SCREENS) {
      await openScreen(page, path);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => {
        const d = document.documentElement;
        // 1px допуск: субпиксельная ширина рамок иногда даёт 420.5 при
        // честной вёрстке в 420.
        return d.scrollWidth - d.clientWidth;
      });
      if (overflow > 1) wide.push(`${path}: +${overflow}px`);
    }

    expect(wide).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("выбранный вид переживает уход на другой экран и возврат", async ({
    page,
    context,
  }) => {
    // Вид доски проверяем на «Сегодня»: у «Входящих» с 30.08.2026 нет
    // ни экрана, ни маршрута, а taskLayout.today читает TodayScreen и
    // рисует ту же доску (TaskBoard).
    await setupApp(context, { today: "board", upcoming: "month" });

    await openScreen(page, "/today");
    expect(await page.locator("[data-board-strip]").count()).toBe(1);

    await openScreen(page, "/settings");
    await page.waitForTimeout(300);
    await openScreen(page, "/today");
    await page.waitForTimeout(500);
    // Вид доски сохранён — а не сброшен на список при возврате.
    expect(await page.locator("[data-board-strip]").count()).toBe(1);

    await openScreen(page, "/upcoming");
    await page.waitForTimeout(500);
    const monthCells = await page
      .locator("[data-month-grid], [data-week-grid]")
      .count();
    expect(monthCells).toBeGreaterThan(0);
  });
});
