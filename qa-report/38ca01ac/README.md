# QA-проверка срока задачи — материалы

Карточка: 38ca01ac-c71d-45d0-bd91-5bacb82101d3, шаг executor (роль qa).
Дата прогона: 23.10.2026, копия приложения + живой сервер 192.168.1.110:5180.

## Кадры

- `zhivoy-420-planirovanie.png` — живой сервер, экран «Планирование», ширина телефона 420: вместо календаря экран ошибки «Что-то пошло не так» (в консоли `ReferenceError: MarkdownInline is not defined`).
- `zhivoy-1280-planirovanie.png` — тот же экран на ширине 1280: открывается нормально (дефект только на мобильной ширине).
- `01-zhivoy-planiрование-420.png` — первый кадр того же падения.
- `kopiya-metka-s-zadachey.png` — копия приложения, экран метки «Важно».

## Найденные дефекты

1. Кликом мыши день в календаре срока не выбирается (тап и Enter работают).
   Причина: `src/components/TaskFields.tsx:759` — `setPointerCapture` в обработчике касания календаря.
2. Экран «Планирование» (/upcoming) на ширине 420 падает: `MarkdownInline is not defined`
   (`src/components/UpcomingCalendar.tsx:173`, `src/screens/LabelTasksScreen.tsx:164` — нет импорта).

Шаг на починку: builder_2 в плане карточки.
