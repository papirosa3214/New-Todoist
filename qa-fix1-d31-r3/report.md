# Отчёт живой проверки
Приложение: http://127.0.0.1:4101 · экран 320×568@2 · chromium
Шагов: 11, упало: 1. Ошибок консоли: 10, pageerror: 0, ответов ≥400: 10.

✅ 1. goto "/task/451bb597-0f3d-407a-baa8-b226ce404fff" — Дочерняя 451bb597 — узкий 320×568 (КП №6)
✅ 2. wait 1500
✅ 3. snap "20-narrow-child"
   кадр: 01-20-narrow-child.png
   раскладка: за краем экрана: button.relative.w-[40px] «» x=303..343; svg «» x=315..331; path «» x=319..327 | мельче 44×44: button.tap-scale.w-[40px] «Вывести в Dynamic Island» 40×44; button.tap-scale.w-[40px] «Сохранить как шаблон» 40×44; button.tap-scale.w-[40px] «Удалить задачу» 40×44; button.flex-1.min-w-0 «Независимая проверка результат» 223×42; button.flex-1.min-w-0 «Реализация» 223×21; button.flex-1.min-w-0 «Проверенные сценарии и дефекты» 223×42; button.flex-1.min-w-0 «Доработка 1: Реализация» 223×21; button.flex-1.min-w-0 «Доработка 1: Проверенные сцена» 223×42
   текст экрана: "451bb597\nTaskFlow - NewTodoist\nВеб: одно действие — одна иконка и один размер \\(Linear MAK\\-55\\)\n\n## Работа\n\nПо `audit-2026-10-05/AUDIT-BUTTONS-ICONS-SIZES-2026-10-05.md` и §5 AUDIT\\-COMPONENTS: словарь действий \\(удалить, закрыть, принять, вернуть на доработку, добавить шаг, структурировать с AI, фильтр, ещё\\) — одна иконка/размер/носитель; где iOS расходится — вариант\\-лидер из аудита\\. Таблица в `DESIGN.md`\\. Открытые вопросы §7 — оркестратору\\.\n\nЭталон \\(только чтение\\): `max@MacBook-Pro-Maksim.local:/Users/max/Documents/deepseek-harness/default-workspace/taskflow-design-system/DESIGN-SYSTEM.md` и `/Users/max/Проекты/TaskFlowNativeBuild/Sources/DesignSystem/`\\. Веб: `~/Проекты/New-Todois"
✅ 4. expect_visible "[data-testid=plan-frame-divider]"
✅ 5. goto "/task/2b130833-31c8-4e35-8f17-19e3f0c4c4a4" — Сама карточка 2b130833 — родительская этой задачи, без approved плана (КП №7)
✅ 6. wait 1500
✅ 7. snap "21-task-self-no-plan"
   кадр: 02-21-task-self-no-plan.png
   раскладка: за краем экрана: button.relative.w-[40px] «» x=303..343; svg «» x=315..331; path «» x=319..327 | мельче 44×44: button.tap-scale.w-[40px] «Вывести в Dynamic Island» 40×44; button.tap-scale.w-[40px] «Сохранить как шаблон» 40×44; button.tap-scale.w-[40px] «Удалить задачу» 40×44; button.flex-1.min-w-0 «Итоговая проверка результата» 223×21; button.flex-1.min-w-0 «Повторная итоговая проверка 1» 223×42; button.flex-1.min-w-0 «Повторная итоговая проверка 2» 223×42; button.flex-1.min-w-0 «Техническое решение и риски» 223×21; button.flex-1.min-w-0 «Итоговый вердикт» 223×21
   текст экрана: "2b130833\nTaskFlow - NewTodoist\nГраф плана: рамка «Раз·QA·Критик» в дочерних \\+ пульс родительской\n\n## Работа\n\nРеализовать в TaskFlow \\(New\\-Todoist\\) два изменения по спеке `doc f0b39de5-6711-4d93-b0a7-b95ecd50a1cb` в проекте TaskFlow \\- NewTodoist:\n\n1. `src/components/CollaborationPlanPanel.tsx` — дополнить существующий компонент\\. Под уникальными узлами добавить секцию «рамка»: тонкий разделитель `var(--border)`, подпись «всегда есть» 9 px серым, и три пустых кружка 10 px с обводкой `var(--frame)` \\(новый токен в `index.css`, светлая: `#a78bfa`, тёмная: `#a78bfa`\\)\\. Подписи: «Раз», «QA», «Критик»\\. Цвет обводки = одинаковый для всех трёх\\.\n\n1. `src/components/ParentPlanPulse.tsx` \\(новый\\"
❌ 8. expect_no_text "Всегда есть"
   ошибка: текст «Всегда есть» найден на странице (3)
   кадр: 03-ошибка-шаг-8.png
   раскладка: за краем экрана: button.relative.w-[40px] «» x=303..343; svg «» x=315..331; path «» x=319..327 | мельче 44×44: button.tap-scale.w-[40px] «Вывести в Dynamic Island» 40×44; button.tap-scale.w-[40px] «Сохранить как шаблон» 40×44; button.tap-scale.w-[40px] «Удалить задачу» 40×44; button.flex-1.min-w-0 «Итоговая проверка результата» 223×21; button.flex-1.min-w-0 «Повторная итоговая проверка 1» 223×42; button.flex-1.min-w-0 «Повторная итоговая проверка 2» 223×42; button.flex-1.min-w-0 «Техническое решение и риски» 223×21; button.flex-1.min-w-0 «Итоговый вердикт» 223×21
   текст экрана: "2b130833\nTaskFlow - NewTodoist\nГраф плана: рамка «Раз·QA·Критик» в дочерних \\+ пульс родительской\n\n## Работа\n\nРеализовать в TaskFlow \\(New\\-Todoist\\) два изменения по спеке `doc f0b39de5-6711-4d93-b0a7-b95ecd50a1cb` в проекте TaskFlow \\- NewTodoist:\n\n1. `src/components/CollaborationPlanPanel.tsx` — дополнить существующий компонент\\. Под уникальными узлами добавить секцию «рамка»: тонкий разделитель `var(--border)`, подпись «всегда есть» 9 px серым, и три пустых кружка 10 px с обводкой `var(--frame)` \\(новый токен в `index.css`, светлая: `#a78bfa`, тёмная: `#a78bfa`\\)\\. Подписи: «Раз», «QA», «Критик»\\. Цвет обводки = одинаковый для всех трёх\\.\n\n1. `src/components/ParentPlanPulse.tsx` \\(новый\\"
✅ 9. goto "/task/424de175-1cef-4127-ac99-258e80ea6e0e" — Карточка без плана и без дочерних (КП №8) — может быть любая
✅ 10. wait 1500
✅ 11. snap "22-no-children-no-plan"
   кадр: 04-22-no-children-no-plan.png
   раскладка: за краем экрана: button.relative.w-[40px] «» x=303..343; svg «» x=315..331; path «» x=319..327 | мельче 44×44: button.tap-scale.w-[40px] «Вывести в Dynamic Island» 40×44; button.tap-scale.w-[40px] «Сохранить как шаблон» 40×44; button.tap-scale.w-[40px] «Удалить задачу» 40×44; button.relative.w-[40px] «Приложить файл» 40×40; button.relative.w-[40px] «» 40×40
   текст экрана: "424de175\nTaskFlow - NewTodoist\nПульт управления сервером: параметры запуска и реакций меняются из Настроек → Сервер\n\n## Работа\nСо слов владельца (06.10.2026): все серверные параметры, которые мы сегодня вводили (кто кого и через какое время будит или перезапускает, лимиты, пороги, режимы), должны отражаться в «Настройки → Сервер» как пульт управления: владелец заходит и сам выставляет значения. Сейчас они зашиты константами. Сделать: (1) реестр серверных параметров: таблица `server_settings` (ключ, значение, тип, значение по умолчанию, мин/макс, группа, описание по-русски, кем и когда изменено), единая функция чтения `getServerSetting(ключ)` с кешем и запасом на значение по умолчанию; журнал"

## Ошибки страницы
- pageerror: нет
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- сеть: 404 GET /api/avatars/7d875c54-7f21-4af8-9853-b84b6b5483a5.png
- сеть: 404 GET /api/avatars/e3cc4e21-e6b7-40df-bad7-53b206b951d9.png
- сеть: 404 GET /api/avatars/79b74c0f-cd62-46dc-986c-08dff5965ae6.png
- сеть: 404 GET /api/avatars/e3cc4e21-e6b7-40df-bad7-53b206b951d9.png
- сеть: 404 GET /api/avatars/79b74c0f-cd62-46dc-986c-08dff5965ae6.png
- сеть: 404 GET /api/avatars/7d875c54-7f21-4af8-9853-b84b6b5483a5.png
- сеть: 404 GET /api/avatars/82bc1bf9-f513-42a1-a1cc-b089fc5dc0d9.png
- сеть: 404 GET /api/avatars/33d648fb-b509-4580-a1cc-5e6e64d4f02f.png
- сеть: 404 GET /api/avatars/e4c6df04-60a1-4e36-b6ee-7fb26660236a.png
- сеть: 404 GET /api/avatars/23f32a7c-059e-4484-8726-1513cc5c9bf7.png

## Финальный экран (05-финал.png)
```
424de175
TaskFlow - NewTodoist
Пульт управления сервером: параметры запуска и реакций меняются из Настроек → Сервер

## Работа
Со слов владельца (06.10.2026): все серверные параметры, которые мы сегодня вводили (кто кого и через какое время будит или перезапускает, лимиты, пороги, режимы), должны отражаться в «Настройки → Сервер» как пульт управления: владелец заходит и сам выставляет значения. Сейчас они зашиты константами. Сделать: (1) реестр серверных параметров: таблица `server_settings` (ключ, значение, тип, значение по умолчанию, мин/макс, группа, описание по-русски, кем и когда изменено), единая функция чтения `getServerSetting(ключ)` с кешем и запасом на значение по умолчанию; журнал изменений в ленту; (2) `GET /api/server-settings` (список по группам) и `PATCH /api/server-settings/:key` — только владелец, значение проверяется по типу и границам; (3) вынести в реестр существующие и новые константы (с текущими значениями по умолчанию): порог затишья хода роли и число авто-перезапусков (карточка 71651ad0), период технических снимков слота (5 мин) и сколько снимков хранить (20), порог сокращения длинных сообщений (600 знаков) и лимит вызовов роли за попытку, режим приёма (`task_intake_mode`: ручной/автоматический), период и выключатель автоимпорта из Linear (5 мин), выключатель и период обратной записи статусов в Linear, порог тишины для сигнала владельцу (15 мин, `tf_stall_check`), таймаут базы знаний в сборке контекста (8 с), сколько шагов одновременно допускается и пр
```