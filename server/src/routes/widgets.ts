// Данные для виджетов в чате (владелец 01.10.2026: «на вопрос какая погода
// агент скидывает виджет в чат»).
//
// Виджет — блок ```widget с JSON в тексте ответа роли; рисует его клиент
// (iOS: ChatWidgetView). Роль не должна выдумывать цифры, поэтому данные,
// которых у неё нет, отдаёт сервер: GET /api/widgets/weather возвращает
// готовый JSON виджета погоды, MCP-инструмент taskflow_weather вкладывает
// его в ответ как есть.
//
// Источник погоды — Open-Meteo: без ключа, геокодинг и прогноз одним
// провайдером, ответ на русском.
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 10_000;

/** Код погоды WMO → подпись по-русски и ключ значка для клиента. */
export function weatherCondition(code: number): { condition: string; icon: string } {
  if (code === 0) return { condition: "Ясно", icon: "clear" };
  if (code === 1) return { condition: "Преимущественно ясно", icon: "partly_cloudy" };
  if (code === 2) return { condition: "Переменная облачность", icon: "partly_cloudy" };
  if (code === 3) return { condition: "Пасмурно", icon: "cloudy" };
  if (code === 45 || code === 48) return { condition: "Туман", icon: "fog" };
  if (code >= 51 && code <= 57) return { condition: "Морось", icon: "drizzle" };
  if (code >= 61 && code <= 67) return { condition: "Дождь", icon: "rain" };
  if (code >= 71 && code <= 77) return { condition: "Снег", icon: "snow" };
  if (code >= 80 && code <= 82) return { condition: "Ливень", icon: "rain" };
  if (code === 85 || code === 86) return { condition: "Снегопад", icon: "snow" };
  if (code >= 95) return { condition: "Гроза", icon: "storm" };
  return { condition: "—", icon: "cloudy" };
}

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Погода для города — готовый JSON виджета. null — город не найден. */
export async function weatherWidget(city: string): Promise<Record<string, unknown> | null> {
  const geo = await getJson(
    `${GEOCODE_URL}?${new URLSearchParams({ name: city, count: "1", language: "ru", format: "json" })}`,
  );
  const place = geo?.results?.[0];
  if (!place) return null;

  const forecast = await getJson(
    `${FORECAST_URL}?${new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min",
      wind_speed_unit: "ms",
      timezone: "auto",
      forecast_days: "5",
    })}`,
  );
  const current = forecast?.current ?? {};
  const daily = forecast?.daily ?? {};
  const now = weatherCondition(Number(current.weather_code ?? 3));
  const round = (v: unknown) => (typeof v === "number" ? Math.round(v) : null);

  const days: string[] = Array.isArray(daily.time) ? daily.time : [];
  return {
    type: "weather",
    location: [place.name, place.country].filter(Boolean).join(", "),
    temperature: round(current.temperature_2m),
    feels_like: round(current.apparent_temperature),
    humidity: round(current.relative_humidity_2m),
    wind: typeof current.wind_speed_10m === "number" ? `${Math.round(current.wind_speed_10m)} м/с` : null,
    condition: now.condition,
    icon: now.icon,
    is_day: current.is_day !== 0,
    high: round(daily.temperature_2m_max?.[0]),
    low: round(daily.temperature_2m_min?.[0]),
    forecast: days.slice(1, 5).map((date, i) => ({
      day: WEEKDAYS[new Date(`${date}T12:00:00`).getDay()],
      icon: weatherCondition(Number(daily.weather_code?.[i + 1] ?? 3)).icon,
      high: round(daily.temperature_2m_max?.[i + 1]),
      low: round(daily.temperature_2m_min?.[i + 1]),
    })),
    updated_at: typeof current.time === "string" ? current.time : null,
  };
}

export async function registerWidgetsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { city?: string } }>(
    "/api/widgets/weather",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      const city = String(req.query?.city ?? "").trim().slice(0, 100);
      if (!city) return reply.code(400).send({ error: "нужен city" });
      try {
        const widget = await weatherWidget(city);
        if (!widget) return reply.code(404).send({ error: `город «${city}» не найден` });
        return { widget };
      } catch (error) {
        return reply.code(502).send({
          error: `погода недоступна: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  );
}
