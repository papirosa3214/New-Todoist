# Отчёт живой проверки
Приложение: http://127.0.0.1:4101 · экран 420×912@2 · chromium
Шагов: 3, упало: 0. Ошибок консоли: 5, pageerror: 0, ответов ≥400: 5.

✅ 1. goto "/task/2b130833-31c8-4e35-8f17-19e3f0c4c4a4" — карточка без детей
✅ 2. wait 1500
✅ 3. snap "02-no-children"
   кадр: 01-02-no-children.png
   раскладка: мельче 44×44: button.tap-scale.w-[40px] «Вывести в Dynamic Island» 40×44; button.tap-scale.w-[40px] «Сохранить как шаблон» 40×44; button.tap-scale.w-[40px] «Удалить задачу» 40×44; button.flex-1.min-w-0 «feature_spec: scope, out_of_sc» 323×42; button.flex-1.min-w-0 «implementation_pack: изменения» 323×42; button.flex-1.min-w-0 «feature_ux_spec: экраны, state» 323×42; button.flex-1.min-w-0 «feature_test_report: acceptanc» 323×42; button.flex-1.min-w-0 «Итоговая проверка результата» 323×21
   текст экрана: "2b130833\nTaskFlow - NewTodoist\nГраф плана: рамка «Раз·QA·Критик» в дочерних \\+ пульс родительской\n\n## Работа\n\nРеализовать в TaskFlow \\(New\\-Todoist\\) два изменения по спеке `doc f0b39de5-6711-4d93-b0a7-b95ecd50a1cb` в проекте TaskFlow \\- NewTodoist:\n\n1. `src/components/CollaborationPlanPanel.tsx` — дополнить существующий компонент\\. Под уникальными узлами добавить секцию «рамка»: тонкий разделитель `var(--border)`, подпись «всегда есть» 9 px серым, и три пустых кружка 10 px с обводкой `var(--frame)` \\(новый токен в `index.css`, светлая: `#a78bfa`, тёмная: `#a78bfa`\\)\\. Подписи: «Раз», «QA», «Критик»\\. Цвет обводки = одинаковый для всех трёх\\.\n\n1. `src/components/ParentPlanPulse.tsx` \\(новый\\"

## Ошибки страницы
- pageerror: нет
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- сеть: 404 GET /api/avatars/e3cc4e21-e6b7-40df-bad7-53b206b951d9.png
- сеть: 404 GET /api/avatars/79b74c0f-cd62-46dc-986c-08dff5965ae6.png
- сеть: 404 GET /api/avatars/7d875c54-7f21-4af8-9853-b84b6b5483a5.png
- сеть: 404 GET /api/avatars/e4c6df04-60a1-4e36-b6ee-7fb26660236a.png
- сеть: 404 GET /api/avatars/23f32a7c-059e-4484-8726-1513cc5c9bf7.png

## Финальный экран (02-финал.png)
```
2b130833
TaskFlow - NewTodoist
Граф плана: рамка «Раз·QA·Критик» в дочерних \+ пульс родительской

## Работа

Реализовать в TaskFlow \(New\-Todoist\) два изменения по спеке `doc f0b39de5-6711-4d93-b0a7-b95ecd50a1cb` в проекте TaskFlow \- NewTodoist:

1. `src/components/CollaborationPlanPanel.tsx` — дополнить существующий компонент\. Под уникальными узлами добавить секцию «рамка»: тонкий разделитель `var(--border)`, подпись «всегда есть» 9 px серым, и три пустых кружка 10 px с обводкой `var(--frame)` \(новый токен в `index.css`, светлая: `#a78bfa`, тёмная: `#a78bfa`\)\. Подписи: «Раз», «QA», «Критик»\. Цвет обводки = одинаковый для всех трёх\.

1. `src/components/ParentPlanPulse.tsx` \(новый\) — компонент пульса для родительской с дочерними\. Использует `useCollaborationPlans` \+ `useRoleSlots` для каждой дочерней \(через цикл `taskIds.map`\)\. Содержимое: 4 метрики состояний \(в работе / на ревью / принято / готов\), прогресс\-бары по дочерним, список «кто сейчас активен» \(роль \+ ID дочерней, не больше 5 строк, остальное «\+N»\)\. Каждая строка дочерней кликабельна — открывает её карточку\.

1. `src/screens/TaskDetailScreen.tsx` — переключатель: если `task.children.length > 0`, рисовать `ParentPlanPulse`; иначе `CollaborationPlanPanel` как сейчас\. Без дочерних и без `approved` плана — ничего не рисуем\.

## Результат

- В карточке дочерней задачи `CollaborationPlanPanel` показывает: уникальные шаги как крупные залитые круги 14–16 px по цвету состояния, ниже разделитель с п
```