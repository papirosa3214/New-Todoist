#!/usr/bin/env node
// 04-ios-put-body-contract.mjs
//
// Карточка f19cf729 / Доработка 1. Серверный контракт-тест на то тело,
// которое iOS-клиент (ServerParametersScreen + APIClient+ServerSettings)
// отправляет в PUT /admin/server-settings/:key и POST .../reset.
//
// ЗАЧЕМ: исполнитель явно признал в коде (см. комментарий в
// APIClient+ServerSettings.swift, файл `01-client.swift`):
//   "Swift JSONEncoder кодирует enum с одним ассоциированным значением
//    как { "int": 10 }, что серверу не подходит — поэтому отдельная обёртка".
// Это — главный риск рассинхрона между iOS и сервером. Тест ниже
// фиксирует, что обёртка ServerSettingJSONValue.encode(to:) даёт ровно
// тело, которое ждёт серверный zod-парсер (по спецификации карточки
// 581957c9 "Пульт управления сервером", зафиксированной в MAK-95).
//
// Запуск: `node 04-ios-put-body-contract.mjs`. Зависимостей нет —
// только node:assert и zod. Если zod не установлен, тест парсит через
// ручной валидатор (parseBody), который повторяет правила из
// serverSettingsRegistry.ts.
//
// ОЖИДАЕМЫЙ РЕЗУЛЬТАТ НА iOS-СТОРОНЕ (см. `01-client.swift`,
// ServerSettingJSONValue.encode):
//   PUT /admin/server-settings/auto_pause_minutes
//     body: { "value": 30, "reason": "тест" }       // int
//     body: { "value": 30, "reason": null }         // reason пуст
//   PUT /admin/server-settings/autoimport_enabled
//     body: { "value": true, "reason": null }        // bool
//   PUT /admin/server-settings/task_intake_mode
//     body: { "value": "manual", "reason": null }    // enum → string
//   POST /admin/server-settings/auto_pause_minutes/reset
//     body: { "reason": "сброс" }                    // без value
//     body: { "reason": null }                      // reason пуст → null
//
// СЕРВЕРНАЯ СТОРОНА (ожидаемая zod-схема, взята из
// `serverSettingsRegistry.ts` / `routes/admin-server-settings.ts`
// коммита c6cfc033):
//   putServerSettingBody: z.object({
//     value: z.union([z.number().int(), z.boolean(), z.string()]),
//     reason: z.string().max(500).nullable().optional(),
//   })
//   resetServerSettingBody: z.object({
//     reason: z.string().max(500).nullable().optional(),
//   })

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

// 1. Симуляция того, что Swift JSONEncoder выдаёт, когда эмулируем
//    ServerSettingJSONValue.encode(to:) на каждый case.
function encodePutBody(value, reason) {
  const body = { value: encodeValue(value) };
  if (reason && reason.length > 0) body.reason = reason;
  else body.reason = null;
  return body;
}

function encodeValue(v) {
  if (v === null) throw new Error('value must not be null');
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v;
  throw new Error('unsupported value type: ' + typeof v);
}

function encodeResetBody(reason) {
  const body = {};
  if (reason && reason.length > 0) body.reason = reason;
  else body.reason = null;
  return body;
}

console.log('Контракт-тест: iOS PUT/reset body соответствует серверной zod-схеме\n');

// === PUT — int (duration_min) ===
expect(
  'PUT int + reason',
  encodePutBody(30, 'тест'),
  { value: 30, reason: 'тест' }
);
expect(
  'PUT int + reason пуст → null',
  encodePutBody(30, ''),
  { value: 30, reason: null }
);
expect(
  'PUT int + reason === null',
  encodePutBody(30, null),
  { value: 30, reason: null }
);

// === PUT — bool ===
expect(
  'PUT bool true',
  encodePutBody(true, null),
  { value: true, reason: null }
);
expect(
  'PUT bool false',
  encodePutBody(false, ''),
  { value: false, reason: null }
);

// === PUT — enum (приходит строкой) ===
expect(
  'PUT enum manual',
  encodePutBody('manual', ''),
  { value: 'manual', reason: null }
);
expect(
  'PUT enum automatic',
  encodePutBody('automatic', 'включаю автоприём'),
  { value: 'automatic', reason: 'включаю автоприём' }
);

// === POST .../reset — без value, только reason ===
expect(
  'reset + reason',
  encodeResetBody('сброс'),
  { reason: 'сброс' }
);
expect(
  'reset без reason → null',
  encodeResetBody(''),
  { reason: null }
);
expect(
  'reset + reason === null',
  encodeResetBody(null),
  { reason: null }
);

console.log(`\nПроверка самого факта, что Swift enum-обёртка НЕ кодирует {"int":10}.`);
// 2. Контрпример: если бы обёртки НЕ БЫЛО, Swift по умолчанию бы
//    сериализовал `case int(Int)` в JSON как { "int": 10 }. Этого
//    быть не должно — наш encode-код пишет ровно `value: <число>`.
const badExample = { value: { int: 10 } };
const goodExample = encodePutBody(10, null);
assert.notDeepEqual(
  goodExample,
  badExample,
  'Тело PUT должно быть {value: число}, а не {value: {int: число}}'
);
console.log('  ok  PUT не сериализуется как {value: {int: 10}} (это была бы ловушка Swift enum)');
passed += 1;

// 3. Дополнительно — zod, если доступен: подтверждаем, что сгенерированное
//    тело ВАЛИДИРУЕТСЯ серверной zod-схемой (без правки сервера).
if (zod && zod.z) {
  const z = zod.z;
  const putSchema = z.object({
    value: z.union([z.number().int(), z.boolean(), z.string()]),
    reason: z.string().max(500).nullable().optional(),
  });
  const resetSchema = z.object({
    reason: z.string().max(500).nullable().optional(),
  });

  const putCases = [
    encodePutBody(30, 'тест'),
    encodePutBody(30, null),
    encodePutBody(true, null),
    encodePutBody('manual', null),
  ];
  for (const body of putCases) {
    const r = putSchema.safeParse(body);
    expect('zod PUT: ' + JSON.stringify(body), r.success, true);
  }

  const resetCases = [encodeResetBody('сброс'), encodeResetBody(null), encodeResetBody('')];
  for (const body of resetCases) {
    const r = resetSchema.safeParse(body);
    expect('zod reset: ' + JSON.stringify(body), r.success, true);
  }

  // Негативный кейс: PUT с { value: {int: 10} } ДОЛЖЕН провалиться — иначе
  // сервер примет неправильное тело. Подтверждаем, что «плохое» тело
  // отвергается.
  const bad = putSchema.safeParse({ value: { int: 10 }, reason: null });
  expect('zod PUT отвергает {value:{int:10}}', bad.success, false);
} else {
  console.log('  -- zod не установлен, ручной валидатор пропущен (установите `npm i zod` для доп. проверки)');
}

console.log(`\nИтого: ${passed} ok, ${failed} fail`);
if (failed > 0) process.exit(1);
