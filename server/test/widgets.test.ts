// Виджет погоды для чата (владелец 01.10.2026): сервер отдаёт готовый JSON
// виджета из Open-Meteo, роль вставляет его в ответ как есть.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { weatherCondition } from "../src/routes/widgets.js";

describe("виджеты чата: погода", () => {
  let app: FastifyInstance;
  let auth: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Weather", email: `weather-${Date.now()}@test`, password: "password123" },
    });
    auth = { authorization: `Bearer ${reg.json().token}` };
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (app) await app.close();
  });

  it("город → готовый виджет: сейчас, сегодня и четыре дня вперёд", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("geocoding-api")) {
        return new Response(JSON.stringify({
          results: [{ name: "Москва", country: "Россия", latitude: 55.75, longitude: 37.62 }],
        }));
      }
      return new Response(JSON.stringify({
        current: {
          time: "2026-10-01T12:00",
          temperature_2m: 11.6,
          apparent_temperature: 9.2,
          relative_humidity_2m: 71,
          weather_code: 61,
          wind_speed_10m: 4.4,
          is_day: 1,
        },
        daily: {
          time: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"],
          weather_code: [61, 0, 3, 71, 95],
          temperature_2m_max: [13.1, 15, 12, 4, 9],
          temperature_2m_min: [6.9, 7, 5, 0, 3],
        },
      }));
    }));

    const res = await app.inject({
      method: "GET",
      url: `/api/widgets/weather?city=${encodeURIComponent("Москва")}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const w = res.json().widget;
    expect(w).toMatchObject({
      type: "weather",
      location: "Москва, Россия",
      temperature: 12,
      feels_like: 9,
      humidity: 71,
      wind: "4 м/с",
      condition: "Дождь",
      icon: "rain",
      is_day: true,
      high: 13,
      low: 7,
    });
    expect(w.forecast).toEqual([
      { day: "Пт", icon: "clear", high: 15, low: 7 },
      { day: "Сб", icon: "cloudy", high: 12, low: 5 },
      { day: "Вс", icon: "snow", high: 4, low: 0 },
      { day: "Пн", icon: "storm", high: 9, low: 3 },
    ]);
    expect(calls[1]).toContain("latitude=55.75");
  });

  it("неизвестный город — 404, недоступный сервис — 502 с причиной", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}))));
    const missing = await app.inject({ method: "GET", url: "/api/widgets/weather?city=Нигде", headers: auth });
    expect(missing.statusCode).toBe(404);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const down = await app.inject({ method: "GET", url: "/api/widgets/weather?city=Москва", headers: auth });
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toContain("HTTP 503");
  });

  it("коды WMO → подпись и значок", () => {
    expect(weatherCondition(0)).toEqual({ condition: "Ясно", icon: "clear" });
    expect(weatherCondition(45).icon).toBe("fog");
    expect(weatherCondition(81).icon).toBe("rain");
  });
});
