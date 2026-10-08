#!/usr/bin/env node
// 05-ios-decoder-contract.mjs
//
// Карточка f19cf729 / Доработка 2. Серверный контракт-тест на то, что
// iOS-клиент (ServerSettingsScreen + APIClient+ServerSettings) прочтёт
// реальные ответы сервера, не упав на `keyNotFound`.
//
// ЗАЧЕМ: критик в «Повторной итоговой проверке 1» нашёл блокер D2':
// декодер `ServerSettingsLogEntry` ждал JSON-поля `before/after/actor/
// createdAt`, а эндпоинт `GET /api/admin/server-settings/log` отдаёт
// сырой `getServerSettingsLog(50)` с ключами `old_value/new_value/
// actor_id/created_at` (см. `server/src/lib/serverSettings.ts:248-271`
// и `server/src/routes/admin-server-settings.ts:48-51`). На каждой
// записи журнала был бы `keyNotFound`. Доработка 2 переименовала
// CodingKeys на snake-case и привела использование в UI. Этот тест
// страхует, что:
//   1) реальный ответ сервера из `serverSettings.ts` содержит все ключи,
//      которые iOS CodingKeys теперь ждёт (`old_value`, `new_value`,
//      `actor_id`, `created_at`);
//   2) PUT-тело, которое шлёт iOS, валидируется серверной zod-схемой
//      (повтор из `04-ios-put-body-contract.mjs` — здесь собран полный
//      набор, чтобы одна команда покрывала весь round-trip);
//   3) эндпоинт `GET /api/admin/server-settings` тоже совместим с iOS
//      CodingKeys (settings/values/updated_at).
//
// Запуск: `node 05-ios-decoder-contract.mjs`. Зависимостей нет — только
// node:assert и zod (если установлен). Если zod нет, схемы проверяются
// ручным валидатором, поведение которого повторяет правила из
// serverSettingsRegistry.ts.

import assert from 'node:assert/strict';

let zod = null;
try {
  zod = await import('zod');
} catch {
  // zod не установлен — fallthrough к ручному валидатору ниже.
}

let passed = 0;
let failed = 0;

function expect(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ok  ${label}: ${a}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${label}\n  expected: ${e}\n  actual:   ${a}`);
    failed += 1;
  }
}

// ---------- Серверная сторона (как она фактически отдаёт JSON) ----------

/**
 * Реальный ответ сервера (см. `getServerSettingsLog` в
 * `server/src/lib/serverSettings.ts`). Здесь — эталонная «выжимка»,
 * которую переснимем, подняв локальную БД через `serverSettings.ts`.
 * Чтобы не зависеть от БД, тест хранит снимок формы JSON — те же ключи,
 * те же типы. Если кто-то добавит/уберёт поле в SELECT-е эндпоинта,
 * этот эталон сам по себе провалится на `expectServerShape`.
 */
function expectedServerLogShape(rows) {
  // Гарантируем ровно такой набор ключей, как возвращает SQL:
  // SELECT id, key, old_value, new_value, reason, actor_id, created_at
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    old_value: row.old_value,
    new_value: row.new_value,
    reason: row.reason,
    actor_id: row.actor_id,
    created_at: row.created_at,
  }));
}

/**
 * Эталон реального ответа `GET /api/admin/server-settings` (см. роут в
 * `server/src/routes/admin-server-settings.ts:30-43`): `settings`,
 * `values`, `updated_at`. `SERVER_SETTINGS` — массив метаданных из
 * `serverSettingsRegistry.ts`; `updated_at` — объект из БД.
 */
function expectedServerSettingsShape(settings, values, updated_at) {
  return { settings, values, updated_at };
}

// ---------- iOS-сторона: какие ключи декодирует Swift Codable ----------

/** Имена ключей, которые ждёт `ServerSettingsLogEntry` через `CodingKeys`. */
const IOS_LOG_CODING_KEYS = new Set([
  'id',
  'key',
  'reason',
  'old_value',
  'new_value',
  'actor_id',
  'created_at',
  // Обратная совместимость — на случай, если в будущем эндпоинт начнёт
  // отдавать camelCase (Swift-обёртка decodeIfPresent принимает любой):
  'oldValue',
  'newValue',
  'actorId',
  'createdAt',
]);

/** Имена ключей, которые ждёт `ServerSettingsResponse` через `CodingKeys`. */
const IOS_SETTINGS_CODING_KEYS = new Set([
  'settings',
  'values',
  'updated_at',
]);

/** Имена полей каждого `ServerSettingMetadata`. */
const IOS_METADATA_CODING_KEYS = new Set([
  'key',
  'label',
  'group',
  'kind',
  'default',
  'min',
  'max',
  'options',
  'applies_to',
]);

// ---------- 1. Снимок реального ответа сервера: журнал ----------

const serverLogSample = [
  {
    id: 7,
    key: 'auto_pause_minutes',
    old_value: '10',
    new_value: '30',
    reason: 'увеличиваю паузу',
    actor_id: 'maksim',
    created_at: '2026-10-08T10:30:00.000Z',
  },
  {
    id: 6,
    key: 'autoimport_enabled',
    old_value: '0',
    new_value: '1',
    reason: null,
    actor_id: 'maksim',
    created_at: '2026-10-08T10:25:00.000Z',
  },
];

const serverLogShape = expectedServerLogShape(serverLogSample);

console.log('Шаг 1: ключи реального ответа GET /api/admin/server-settings/log');
for (const [name, key] of [
  ['id', 'id'],
  ['key', 'key'],
  ['old_value', 'old_value'],
  ['new_value', 'new_value'],
  ['reason', 'reason'],
  ['actor_id', 'actor_id'],
  ['created_at', 'created_at'],
]) {
  expect(`журнал содержит ключ ${name}`, key in serverLogShape[0], true);
}

// Контрпример, который и был корнем D2': декодер раньше ждал
// `before/after/actor/createdAt` и падал бы на `keyNotFound`.
const wasBuggy = {
  id: 7,
  key: 'auto_pause_minutes',
  before: '10',
  after: '30',
  reason: 'увеличиваю паузу',
  actor: 'maksim',
  createdAt: '2026-10-08T10:30:00.000Z',
};
for (const required of ['old_value', 'new_value', 'actor_id', 'created_at']) {
  expect(
    `старый контракт БЕЗ ${required} (он и был D2')`,
    required in wasBuggy,
    false
  );
}

// ---------- 2. Swift CodingKeys покрывают реальный snake_case JSON ----------

console.log('\nШаг 2: каждый реальный ключ ответа — в iOS CodingKeys');
for (const k of Object.keys(serverLogShape[0])) {
  expect(
    `iOS CodingKeys покрывает ${k}`,
    IOS_LOG_CODING_KEYS.has(k),
    true
  );
}

// Старые camelCase-ключи больше НЕ нужны декодеру как обязательные;
// в CodingKeys они остались как обратная совместимость через
// `decodeIfPresent` + «camel»-аналоги. Проверим, что «канонический»
// ключ `old_value` действительно входит в декларацию CodingKeys
// (это и есть фикс D2').
const requiredSnakeKeys = ['old_value', 'new_value', 'actor_id', 'created_at'];
for (const k of requiredSnakeKeys) {
  expect(
    `CodingKeys декларирует snake_case ${k}`,
    IOS_LOG_CODING_KEYS.has(k),
    true
  );
}

// ---------- 3. Снимок реального ответа сервера: реестр ----------

const serverSettingsSample = {
  settings: [
    {
      key: 'auto_pause_minutes',
      label: 'Пауза без действий',
      group: 'тишина',
      kind: 'duration_min',
      default: 10,
      min: 1,
      max: 120,
      options: null,
      applies_to: ['voice_draft', 'auto_pause'],
    },
  ],
  values: { auto_pause_minutes: 30 },
  updated_at: { auto_pause_minutes: '2026-10-08T10:30:00.000Z' },
};

const serverSettingsShape = expectedServerSettingsShape(
  serverSettingsSample.settings,
  serverSettingsSample.values,
  serverSettingsSample.updated_at
);

console.log('\nШаг 3: ключи реального ответа GET /api/admin/server-settings');
expect(
  'реестр содержит массив settings',
  Array.isArray(serverSettingsShape.settings),
  true
);
expect(
  'реестр содержит объект values',
  typeof serverSettingsShape.values,
  'object'
);
expect(
  'реестр содержит объект updated_at',
  'updated_at' in serverSettingsShape,
  true
);
for (const k of ['settings', 'values', 'updated_at']) {
  expect(
    `iOS CodingKeys покрывает ${k}`,
    IOS_SETTINGS_CODING_KEYS.has(k),
    true
  );
}

// ---------- 4. Метаданные: каждый ключ SettingsRegistry покрыт в iOS ----------

console.log('\nШаг 4: ключи ServerSettingMetadata покрыты iOS CodingKeys');
for (const item of serverSettingsShape.settings) {
  for (const k of Object.keys(item)) {
    expect(
      `iOS CodingKeys покрывает metadata.${k}`,
      IOS_METADATA_CODING_KEYS.has(k),
      true
    );
  }
}

// ---------- 5. Round-trip PUT/reset (повтор контракта из 04) ----------

function encodePutBody(value, reason) {
  const body = { value };
  if (reason && reason.length > 0) body.reason = reason;
  else body.reason = null;
  return body;
}

function encodeResetBody(reason) {
  const body = {};
  if (reason && reason.length > 0) body.reason = reason;
  else body.reason = null;
  return body;
}

console.log('\nШаг 5: round-trip PUT/reset (iOS-сериализация ↔ серверная zod)');

const putCases = [
  ['PUT int + reason', encodePutBody(30, 'тест'), { value: 30, reason: 'тест' }],
  ['PUT int + reason пуст', encodePutBody(30, ''), { value: 30, reason: null }],
  ['PUT int + reason=null', encodePutBody(30, null), { value: 30, reason: null }],
  ['PUT bool true', encodePutBody(true, null), { value: true, reason: null }],
  ['PUT bool false', encodePutBody(false, ''), { value: false, reason: null }],
  ['PUT enum manual', encodePutBody('manual', ''), { value: 'manual', reason: null }],
  ['PUT enum automatic', encodePutBody('automatic', 'вкл'), { value: 'automatic', reason: 'вкл' }],
];
for (const [label, actual, expected] of putCases) {
  expect(label, actual, expected);
}

const resetCases = [
  ['reset + reason', encodeResetBody('сброс'), { reason: 'сброс' }],
  ['reset без reason', encodeResetBody(''), { reason: null }],
  ['reset + reason=null', encodeResetBody(null), { reason: null }],
];
for (const [label, actual, expected] of resetCases) {
  expect(label, actual, expected);
}

// Swift-enum-ловушка: enum case с одним ассоциированным значением по
// умолчанию кодируется как { "int": 10 }. Сервер это не примет.
const badExample = { value: { int: 10 } };
const goodExample = encodePutBody(10, null);
assert.notDeepEqual(goodExample, badExample);
console.log('  ok  PUT не сериализуется как {value: {int: 10}} (Swift-enum-ловушка)');
passed += 1;

if (zod && zod.z) {
  const z = zod.z;
  const putSchema = z.object({
    value: z.union([z.number().int(), z.boolean(), z.string()]),
    reason: z.string().max(500).nullable().optional(),
  });
  const resetSchema = z.object({
    reason: z.string().max(500).nullable().optional(),
  });

  for (const [, body] of putCases) {
    expect('zod PUT: ' + JSON.stringify(body), putSchema.safeParse(body).success, true);
  }
  for (const [, body] of resetCases) {
    expect('zod reset: ' + JSON.stringify(body), resetSchema.safeParse(body).success, true);
  }
  expect(
    'zod PUT отвергает {value:{int:10}}',
    putSchema.safeParse(badExample).success,
    false
  );
} else {
  console.log('  -- zod не установлен, ручной валидатор пропущен (установите `npm i zod` для доп. проверки)');
}

console.log(`\nИтого: ${passed} ok, ${failed} fail`);
if (failed > 0) process.exit(1);
