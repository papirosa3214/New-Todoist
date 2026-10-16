import { test, expect, type BrowserContext } from "@playwright/test";
import { setupApp, openScreen } from "./helpers";

// Экран «Оценщик JEV» (16.10.2026). Ответы /api/jev/* подменены: живой
// TypeSafe не зовём и ключ владельца не трогаем — проверяется сам экран:
// поле ключа не показывает значение, галочка сценария без ключа заперта,
// проверка подключения рассказывает результат словами.

type S = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasApiKey: boolean;
  planProfileEnabled: boolean;
  planProfileMinConfidence: number;
  updatedAt: string;
};

async function mockJev(context: BrowserContext, initial: Partial<S> = {}) {
  let state: S = {
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    timeoutMs: 10000,
    hasApiKey: false,
    planProfileEnabled: false,
    planProfileMinConfidence: 0.6,
    updatedAt: "2026-10-16 10:00:00",
    ...initial,
  };
  const puts: any[] = [];
  await context.route("**/api/jev/**", async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.endsWith("/api/jev/test")) {
      return route.fulfill({
        json: { ok: true, models: ["jev-latest"], ms: 140 },
      });
    }
    if (req.method() === "PUT") {
      const body = req.postDataJSON();
      puts.push(body);
      const { apiKey, ...rest } = body;
      state = {
        ...state,
        ...rest,
        hasApiKey: state.hasApiKey || Boolean(apiKey),
      };
    }
    return route.fulfill({ json: state });
  });
  return puts;
}

test("без ключа сценарий заперт; ключ сохраняется и не показывается", async ({
  page,
  context,
}) => {
  await setupApp(context);
  const puts = await mockJev(context);
  await openScreen(page, "/settings/jev");

  await expect(page.getByText("Оценщик JEV").first()).toBeVisible();
  const toggle = page.getByRole("switch", {
    name: "JEV для выбора шаблона плана",
  });
  await expect(toggle).toBeDisabled();
  await expect(page.getByText("Сначала сохраните ключ")).toBeVisible();

  const key = page.getByLabel("Ключ API");
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("ts-secret-1234567890");
  await page.getByRole("button", { name: "Сохранить" }).click();

  expect(puts[0]).toMatchObject({
    apiKey: "ts-secret-1234567890",
    model: "jev-latest",
    timeoutMs: 10000,
  });
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("placeholder", /Ключ сохранён/);
  await expect(toggle).toBeEnabled();
});

test("галочка включает сценарий, проверка подключения отвечает словами", async ({
  page,
  context,
}) => {
  await setupApp(context);
  const puts = await mockJev(context, { hasApiKey: true });
  await openScreen(page, "/settings/jev");

  const toggle = page.getByRole("switch", {
    name: "JEV для выбора шаблона плана",
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(puts.at(-1)).toEqual({ planProfileEnabled: true });

  await page.getByRole("button", { name: "Проверить подключение" }).click();
  await expect(
    page.getByText("Подключено за 140 мс. Модели: jev-latest"),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/jev-settings.png",
    fullPage: true,
  });
});

test("строка в настройках ведёт на экран", async ({ page, context }) => {
  await setupApp(context);
  await mockJev(context);
  await openScreen(page, "/settings");
  await page.getByText("Оценщик JEV", { exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/jev$/);
});
