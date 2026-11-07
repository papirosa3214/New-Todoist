# Падение хода в чате: слой навыка отдавал null другой роли

Дата: 31.10.2026. Ветка: `roles/fix-compose-layer-null`.

## Что было

Ходы в чате у ролей `researcher` и `secretary` падали с
«Cannot read properties of null (reading 'effective')» — в
`server/dev-server.log` шесть записей `[chats] startChatRun не удался`.

## Причина

`LAYER_CATALOG` (`server/src/lib/roleContextResolver.ts`) — модульный
глобальный список, а `registerInstructionBlock` пушил spec только если
ключа ещё нет, вместе с его полем `roles`. Ключ ресурса — `keyFor(path)`,
хеш пути файла, одинаковый для ролей. Помощник владельца подключает навыки
Исследователя (`skillPathsFor`: для `secretary` добавляется
`roleHome('researcher').skills`), поэтому слои этих навыков регистрировались
с `roles:["secretary"]`. Ход Исследователя читал `composeLayer('researcher',
тот же ключ)` → `spec.roles` не содержит роль → `null`, а код брал
`.effective` через `!` без проверки.

Небезопасные места: `server/src/runtime/instructionResources.ts` (строки 57,
58, 75, 79, 185, 213, 243, 244) и `server/src/runtime/inProcessRun.ts:403`;
починены также `server/src/runtime/roleRunAccess.ts`,
`server/src/runtime/secretaryVoiceBridge.ts`,
`server/src/routes/runtime-context.ts`,
`server/src/lib/roleContextResolver.ts` (`applyOverride`, `effectiveRules`).

## Что сделано

- `registerInstructionBlock`: при повторной регистрации того же ключа список
  ролей объединяется, а не остаётся от первой регистрации. Слой, общий для
  двух ролей, виден обеим; чужая роль его по-прежнему не получает.
- Доступ к тексту слоя везде null-safe с понятным откатом: описание
  инструмента — из кода, текст навыка и файла роли — с диска, пустой блок
  слоя — пустая строка. `applyOverride` при отсутствии слоя бросает
  «слой не принадлежит роли», а не TypeError.
- Удаление слоя из каталога проверяет файл на диске: общий навык не
  исчезает из каталога, потому что его нет в списке другой роли.

## Проверки

- `server/test/composeLayerNullSafe.test.ts` (новый): 4 теста. На старом
  коде — 3 падения, включая ровно «Cannot read properties of null (reading
  'effective')»; с правкой — 4/4 зелёные. Тест проверяет, что слой,
  зарегистрированный двумя ролями, виден обеим, что ход в чате у
  Помощницы и Исследователя не падает, а инструменты роли собираются даже
  без слоя описания.
- `composeLayerNullSafe`, `agentRulesManifest`, `roleBehavior`,
  `chatPanelContract` — 38/39 зелёные. Единственное падение —
  `instructionRuntime.test.ts` («CUSTOM_SYSTEM»): падает и на коде без этой
  правки, то есть это существующий дефект теста, а не регрессия.
- `tsc --noEmit` — чисто.

## Ограничение

Сервер не пересобирался и не перезапускался: выкладка — работа Инженера .110
по команде владельца. Живой ход в чате после деплоя не проверялся.
