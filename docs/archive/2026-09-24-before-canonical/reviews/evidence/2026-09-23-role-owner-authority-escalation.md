# Доказательство P0: эскалация полномочий через ключ роли `owner`

**Дата проверки:** 23 сентября 2026 года.  
**Проверенная серверная ревизия:** `8d1dbf3a5a1f98131d486ee5e973bfcf8d68e1b3`.  
**Автор проверки:** Manus AI.

**Статус:** исправлено в локальной ветке hardening, созданной по результатам
аудита. Скрипт оставлен как постоянный регрессионный probe и теперь завершает
выполнение ошибкой, если дефект возвращается. Точный commit фиксируется в
журнале реализации после прохождения полного набора проверок.

## Вывод

`POST /api/roles` принимает ключ `owner` и создаёт AI-учётную запись `role_owner` с полем `users.role='owner'`. JWT, выпущенный для этой учётной записи, проходит политику `ownerOrApiToken` и может выполнять owner-only мутации. Во время проверки запрос `PATCH /api/roles/owner` завершился HTTP `200`.

Это **эскалация authority**, потому что произвольный ключ бизнес-роли превращается в системную роль авторизации. То, что исходный `POST` выполняет владелец, не устраняет дефект: сервер создаёт дополнительную bearer identity с полномочиями владельца.

## Безопасность воспроизведения

Скрипт использует отдельную временную SQLite-базу, не обращается к production-БД и удаляет временные файлы после выполнения. В нём нет рабочих токенов или секретов.

## Команда

Требуется Node.js `22.19.0` или новее, как требует используемая версия Pi. На Node `22.13.0` в sandbox наблюдался `SIGSEGV` при загрузке приложения; на Node `22.19.0` проверка стабильно завершилась и воспроизвела дефект.

Из корня `taskflow-server`:

```bash
nvm use 22.19.0
cd server
node --import tsx ../docs/reviews/evidence/2026-09-23-role-owner-authority-escalation.ts
```

## Исторический результат до исправления

```json
{
  "createStatus": 201,
  "account": {
    "id": "role_owner",
    "role": "owner",
    "type": "ai"
  },
  "privilegedMutationStatus": 200
}
```

Существенные поля — `createStatus=201`, `account.role=owner` и `privilegedMutationStatus=200`. Тело ответа может меняться вместе с представлением Role API и не является условием воспроизведения.

## Ожидаемый результат после исправления

```json
{
  "createStatus": 422,
  "account": null,
  "privilegedMutationStatus": 403,
  "escalationPossible": false
}
```

`owner` (как и `agent`, `viewer`, `orchestrator`, `service`) отклоняется до
создания строки роли или пользователя. Поэтому `role_owner` отсутствует, а JWT
с вымышленным идентификатором не получает owner authority: owner-only `PATCH`
возвращает `403`.

## Реализованное исправление

Privileged и внутренние ключи запрещены в API и БД. `users.role` теперь хранит
только системную authority, `users.role_key` — бизнес-роль; canonical role
account имеет `id='role_<key>'`, `type='ai'`, `is_system_bot=1` и
`role='agent'`. Migration 058 backfill-ит legacy accounts без смены id/token,
а partial unique index и triggers закрепляют инварианты.

## Связанные материалы

- [Канонический план](../../2026-09-23-roles-in-server-plan.md)
- [Полный отчёт ревью](../2026-09-23-roles-in-server-plan-review.md)
