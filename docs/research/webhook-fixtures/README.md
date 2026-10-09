# JSON fixtures для нативного Codex

Эти файлы — образцы запросов/ответов для интеграции нативного Codex
(внешний разработчик под канонический Mac-репозиторий `TaskFlowNativeBuild`).
Используются как референс при реализации UI подписок на iPhone.

- `create-request.json` — тело `POST /api/integrations/webhooks`.
- `create-response.json` — успешный ответ (содержит полный секрет;
  единственный момент, когда он доступен клиенту).
- `delivery-payload.json` — тело, которое сервер постит на URL подписки
  при срабатывании события. Подпись — `X-Webhook-Signature: sha256=<…>`.
- `test-response.json` — ответ `POST /:id/test`. Раздельные признаки
  HTTP и wake обязательны (это и есть контракт QA-сценария).
- `error-bad-project.json` — пример 400 при попытке подписаться на
  проект, отличный от `TaskFlow - NewTodoist`.

Контракт зафиксирован в `server/docs/webhook-subscriptions.md` и
`docs/research/2026-10-09-webhook-codex-wake-contract.md`.
