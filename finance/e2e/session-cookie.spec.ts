/**
 * Регрессия: cookie сессии ставится по схеме запроса, а не по NODE_ENV.
 *
 * Дефект, который здесь закрыт (13.10.2026): флаг Secure выставлялся по
 * `NODE_ENV === "production"`. Приложение запускается через `next start`
 * (NODE_ENV=production) и открывается по http, браузер такую cookie
 * отбрасывал — вход возвращал на форму логина.
 *
 * Проверка идёт НАСТОЯЩИМ браузером, а не curl: curl присылает заголовки
 * Set-Cookie как есть и никогда не применяет правила хранения cookie,
 * поэтому curl-тест на этом дефекте был зелёным. Проверяем то, что важно
 * владельцу: браузер cookie принял, сохранил и сам отправил обратно.
 *
 * Тесты ходят по сетевому адресу хоста, а не по 127.0.0.1: браузер считает
 * loopback безопасным контекстом и хранит Secure-cookie по http, из-за чего
 * дефект на localhost не проявляется. По локальной сети (как заходит
 * владелец с телефона) Secure-cookie выбрасывается.
 *
 * Оба сценария гоняются в двух движках (webkit — браузер телефона
 * владельца, chromium) и в production-сборке, где дефект и жил.
 */
import { expect, test, type BrowserContext, type Page, type Response } from "@playwright/test";

const CREDENTIALS = { username: "e2e-owner", password: "e2e-password" };
const COOKIE_NAME = "finance_session";
const HTTPS_BASE_URL = `https://${process.env.FINANCE_E2E_HOST ?? "192.168.1.110"}:${
  Number(process.env.FINANCE_E2E_PORT ?? 3931) + 1
}`;

/** Заголовки Set-Cookie ответа — по отдельности, а не одной склеенной строкой. */
async function setCookieHeaders(res: Response): Promise<string[]> {
  const all = await res.headersArray();
  return all.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
}

async function sessionCookie(context: BrowserContext) {
  const all = await context.cookies();
  return all.find((c) => c.name === COOKIE_NAME);
}

/** Вход через настоящую форму — как это делает владелец с телефона. */
async function loginThroughForm(page: Page): Promise<string[]> {
  await page.goto("/login");
  await page.getByLabel("Имя пользователя").fill(CREDENTIALS.username);
  await page.getByLabel("Пароль").fill(CREDENTIALS.password);

  const loginResponse = page.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Войти" }).click();
  return setCookieHeaders(await loginResponse);
}

test.describe("вход по http (как владелец открывает приложение)", () => {
  test("cookie сессии приходит без Secure и браузер её хранит", async ({ page, context }) => {
    const setCookie = await loginThroughForm(page);
    const sessionHeader = setCookie.find((v) => v.startsWith(`${COOKIE_NAME}=`));
    expect(sessionHeader, `Set-Cookie сессии не найден. Получено: ${JSON.stringify(setCookie)}`)
      .toBeTruthy();

    // Первым идёт то, что видит владелец: на дефекте после входа его
    // возвращало на форму логина, потому что браузер выбросил cookie.
    await expect(page).toHaveURL(/\/dashboard$/);

    // Главная проверка дефекта: по http флага Secure быть не должно,
    // иначе браузер cookie выбросит.
    expect(
      /;\s*Secure/i.test(sessionHeader!),
      `Secure на http ломает вход, браузер такую cookie не хранит: ${sessionHeader}`,
    ).toBe(false);

    const stored = await sessionCookie(context);
    expect(stored, "браузер не сохранил cookie сессии").toBeTruthy();
    expect(stored!.secure, "cookie сохранена как Secure на http-странице").toBe(false);

    // Самое важное: cookie пережила смену страницы — значит браузер её
    // отправил. На старом коде здесь был редирект на /login.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe("вход по https (за обратным прокси)", () => {
  test.use({ baseURL: HTTPS_BASE_URL });

  test("cookie сессии приходит с Secure и по-прежнему работает", async ({ page, context }) => {
    const setCookie = await loginThroughForm(page);
    const sessionHeader = setCookie.find((v) => v.startsWith(`${COOKIE_NAME}=`));

    expect(sessionHeader, `Set-Cookie сессии не найден. Получено: ${JSON.stringify(setCookie)}`)
      .toBeTruthy();
    // На https флаг Secure обязан остаться, иначе cookie утекает на http.
    expect(
      /;\s*Secure/i.test(sessionHeader!),
      `Secure потерялся на https: ${sessionHeader}`,
    ).toBe(true);

    await expect(page).toHaveURL(/\/dashboard$/);

    const stored = await sessionCookie(context);
    expect(stored, "браузер не сохранил cookie сессии на https").toBeTruthy();
    expect(stored!.secure, "cookie по https сохранена без флага Secure").toBe(true);

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});