# Финансы — личный веб-кабинет

Веб-приложение для учёта личных финансов. Реализует сценарии MVP:

- ручной ввод операций (расход/доход, счёт, категория, дата, описание);
- импорт операций через провайдеров `BankProvider` (CSV 1С / Сбербанк / generic и OFX/QFX);
- аналитика: дашборд (балансы, расходы по категориям, кэш-флоу, net worth);
- управление счетами и категориями.

Стек — Next.js 15 (App Router) + TypeScript + SQLite (better-sqlite3) + Drizzle ORM + Tailwind + Recharts. Архитектурный документ: `docs/architecture/2026-10-13-finance-app-architecture.md`.

## Запуск

```bash
cd finance
npm install
cp .env.example .env
# (опционально) задайте FINANCE_INITIAL_USER и FINANCE_INITIAL_PASSWORD
npm run db:migrate
npm run db:seed
npm run dev
```

По умолчанию приложение слушает `http://localhost:3011`.

Логин: значение `FINANCE_INITIAL_USER` (по умолчанию `owner`), пароль — `FINANCE_INITIAL_PASSWORD` (по умолчанию `changeme`). Смените пароль сразу после первого входа.

## Проверки

```bash
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run build        # production build
```

Юнит-тесты покрывают парсеры CSV (1С, Сбербанк, generic) и OFX, а также дедупликацию по хешу (см. `tests/`).

## Структура

- `src/app/` — страницы и API routes (Next.js App Router).
- `src/db/` — Drizzle ORM схема и миграции (SQLite).
- `src/importers/` — реализации `BankProvider`: `csv.ts`, `ofx.ts`.
- `src/lib/` — утилиты: сессии (`session.ts`), аналитика (`analyze.ts`), формат (`format.ts`), дедупликация (`dedupe.ts`).
- `src/components/` — клиентские компоненты (формы, таблицы, графики).
- `scripts/` — миграции (`migrate.ts`) и начальные данные (`seed.ts`).

## Идемпотентность импорта

Дедупликация по `(account_id, source, external_id)`. Для файлов, не выдающих уникальных ID, считается детерминированный `external_id = hash(source, account_id, date, amount, description)`. Повторный импорт того же файла не создаёт дублей.

## Что не входит в MVP

- агрегаторы (Salt Edge / Enable Banking / Plaid) — через тот же интерфейс `BankProvider`, добавляются без правок UI/БД;
- TOTP/2FA — пароль в MVP, TOTP в roadmap (work_4);
- бюджеты по категориям — в roadmap;
- PDF-OCR / email-парсинг / SMS — в roadmap.

## Известные ограничения

- Один пользователь (таблица `users` готова к расширению, но UI под одного владельца).
- Сессионный токен в HTTP-only куке, 30 дней. Без refresh-токенов.
- Без структурного лога сервера; ошибки видны в консоли Next.