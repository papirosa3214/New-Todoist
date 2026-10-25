# Отчёт живой проверки
Приложение: http://127.0.0.1:4101 · экран 420×912@2 · chromium
Шагов: 8, упало: 2. Ошибок консоли: 4, pageerror: 0, ответов ≥400: 4.

✅ 1. goto "/login"
✅ 2. wait 800
❌ 3. fill ["[data-testid=login-name-input]","Максим"]
   ошибка: page.fill: Timeout 8000ms exceeded.
   кадр: 01-ошибка-шаг-3.png
   раскладка: мельче 44×44: input.tf-input.flex-1 «» 318×24; input.tf-input.flex-1 «» 254×24
   текст экрана: "TaskFlow\nДобро пожаловать!\n\nВойдите в свой аккаунт\n\nВойти"
❌ 4. click "[data-testid=login-submit]"
   ошибка: page.click: Timeout 8000ms exceeded.
   кадр: 02-ошибка-шаг-4.png
   раскладка: мельче 44×44: input.tf-input.flex-1 «» 318×24; input.tf-input.flex-1 «» 254×24
   текст экрана: "TaskFlow\nДобро пожаловать!\n\nВойдите в свой аккаунт\n\nВойти"
✅ 5. wait 1500
✅ 6. goto "/projects/c2fcbcdb-951f-449f-a1bd-123ea2a46a58"
✅ 7. wait 2000
✅ 8. snap "02d-project-tasks"
   кадр: 03-02d-project-tasks.png
   раскладка: за краем экрана: span «Граф плана: рамка «Раз·QA·Крит» x=16..513; span «В импорте Linear скрыть заверш» x=16..516; span «Пульт управления сервером: пар» x=16..665; span «Самовосстановление зависших ша» x=16..688; span «Удаление проекта = архивация; » x=16..485; span «Обратная синхронизация: статус» x=16..570; span «Автоимпорт из Linear: завёл за» x=16..547; span «Роль на старте шага получает к» x=16..725 | мельче 44×44: button.w-full.flex «TaskFlow - NewTodoist
182» 388×42; button.w-full.flex «implementation_pack · v1» 388×42; button.w-full.flex «implementation_pack · v2 (дора» 388×42; button.w-full.flex «Итог: Граф плана: рамка «Раз·Q» 388×42; button.w-full.flex «feature_test_report · v1» 388×42; button.w-full.flex «QA-отчёт · карточка 2b130833 «» 388×42; button.w-full.flex «Implementation pack · граф пла» 388×42; button.w-full.flex «feature_ux_spec · v1» 388×42 | обрезано: span.tf-body.text-text «Итог: Граф плана: рамка «Раз·Q» (обрезан: 537>336); span.tf-body.text-text «QA-отчёт · карточка 2b130833 «» (обрезан: 723>336); span.tf-body.text-text «Implementation pack · граф пла» (обрезан: 707>336); span.tf-body.text-text «feature_ux_spec · граф плана: » (обрезан: 534>336); span.tf-body.text-text «Граф плана командной работы — » (обрезан: 431>336); span.tf-body.text-text «Итог: В импорте Linear скрыть » (обрезан: 539>336); span.tf-body.text-text «Итог: Самовосстановление завис» (обрезан: 712>336); span.tf-body.text-text «Отчёт по задаче 71651ad0 — Сам» (обрезан: 475>336)
   текст экрана: "TaskFlow - NewTodoist\nГраф плана: рамка «Раз·QA·Критик» в дочерних \\+ пульс родительской\n## Работа Реализовать в TaskFlow \\(New\\-Todoist\\) два изменения по спеке doc f0b39de5-6711-4d93-b0a7-b95ecd50a1cb в проекте TaskFlow \\- NewTodoist: 1. src/components/CollaborationPlanPanel.tsx — дополнить существующий компонент\\. Под уникальными узлами добавить секцию «рамка»: тонкий разделитель var(--border), подпись «всегда есть» 9 px серым, и три пустых кружка 10 px с обводкой var(--frame) \\(новый токен в index.css, светлая: #a78bfa, тёмная: #a78bfa\\)\\. Подписи: «Раз», «QA», «Критик»\\. Цвет обводки = одинаковый для всех трёх\\. 1. src/components/ParentPlanPulse.tsx \\(новый\\) — компонент пульса для роди"

## Ошибки страницы
- pageerror: нет
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- сеть: 404 GET /api/avatars/47dd22be-a122-4feb-a24d-dc850ba79c66.png
- сеть: 404 GET /api/avatars/e3cc4e21-e6b7-40df-bad7-53b206b951d9.png
- сеть: 404 GET /api/avatars/e4c6df04-60a1-4e36-b6ee-7fb26660236a.png
- сеть: 404 GET /api/avatars/79b74c0f-cd62-46dc-986c-08dff5965ae6.png

## Финальный экран (04-финал.png)
```
TaskFlow - NewTodoist
Граф плана: рамка «Раз·QA·Критик» в дочерних \+ пульс родительской
## Работа Реализовать в TaskFlow \(New\-Todoist\) два изменения по спеке doc f0b39de5-6711-4d93-b0a7-b95ecd50a1cb в проекте TaskFlow \- NewTodoist: 1. src/components/CollaborationPlanPanel.tsx — дополнить существующий компонент\. Под уникальными узлами добавить секцию «рамка»: тонкий разделитель var(--border), подпись «всегда есть» 9 px серым, и три пустых кружка 10 px с обводкой var(--frame) \(новый токен в index.css, светлая: #a78bfa, тёмная: #a78bfa\)\. Подписи: «Раз», «QA», «Критик»\. Цвет обводки = одинаковый для всех трёх\. 1. src/components/ParentPlanPulse.tsx \(новый\) — компонент пульса для родительской с дочерними\. Использует useCollaborationPlans \+ useRoleSlots для каждой дочерней \(через цикл taskIds.map\)\. Содержимое: 4 метрики состояний \(в работе / на ревью / принято / готов\), прогресс\-бары по дочерним, список «кто сейчас активен» \(роль \+ ID дочерней, не больше 5 строк, остальное «\+N»\)\. Каждая строка дочерней кликабельна — открывает её карточку\. 1. src/screens/TaskDetailScreen.tsx — переключатель: если task.children.length > 0, рисовать ParentPlanPulse; иначе CollaborationPlanPanel как сейчас\. Без дочерних и без approved плана — ничего не рисуем\. ## Результат - В карточке дочерней задачи CollaborationPlanPanel показывает: уникальные шаги как крупные залитые круги 14–16 px по цвету состояния, ниже разделитель с подписью «всегда есть», и три маленьких пустых круж
```