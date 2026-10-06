# MAK-49 — кнопки как TFButton / TFIconButton (2026-10-06)

Веб-аналоги нативных `TFButton` / `TFIconButton` (DESIGN-SYSTEM.md §2.1)
сведены в общие компоненты `Button` / `IconButton` в `src/components/UI.tsx`,
локальные копипасты иконок-кнопок и ручные `<Icon size={16}>` внутри кнопок
убраны, `DESIGN.md` дополнен разделом «Кнопки».

## Что сделано

| §2.1 | Реализация |
| --- | --- |
| primary — `red-solid`, белый текст, 48, радиус 12, на всю ширину, иконка 16 | `Button variant="primary"`, `h-control-md r-control-lg`, проп `icon` (16px) |
| secondary — `card2` + рамка | `Button variant="secondary"` |
| outline — прозрачная + рамка, текст `sub` | `Button variant="outline"` |
| недоступная — 0.5 | `.tap-*:disabled { opacity:.5 }` в `index.css` |
| кнопка-иконка — прозрачная, тап-зона 44×44, обязательный aria-label | новый `IconButton` (`label` — обязательный проп, `w-11 h-11`) |
| отклик: сжатие 0.94 / подсветка строки 4% / прозрачность 0.85 | `.tap-scale` / `.tap-row` / `.tap-fade` в `index.css` |

Подпись кнопки переведена на 15px/600 (`.tf-body font-semibold`) — как в
нативном `TFButton` и `.auth-btn` из mockup-reference. Иконка теперь
задаётся пропом `icon`, а не вложенным `<Icon>`: 16 мест
(TaskDetailScreen ×6, TaskJournal ×9, LabelsScreen ×1) переведены на проп,
включая одну, что стояла 18px (LabelsScreen — теперь 16 по системе).

`IconButton` уже применена в: крестике `SheetHeader` (обе формы),
`BackButton`, `TaskFilterButton` (шапки «Входящие / Сегодня / Предстоящее /
Активность») и «Ещё» в шапке «Сегодня».

## Кадры

`scripts/screenshot-mak49.mjs`, layout 402×874, DSR=2 (804×1748),
обе темы через persist `taskflow-ui` v4. В `web/light/` и `web/dark/`:

| Кадр | Что видно | §2.1 |
| --- | --- | --- |
| `01-task-detail-buttons.png` | primary (red-solid, ☑), secondary (card2+рамка), outline (рамка, `sub`), иконки 16 | три варианта |
| `02-today-header-iconbuttons.png` | шапка «Сегодня»: фильтр + «Ещё» — `IconButton` 44×44 | кнопка-иконка |
| `03-filter-sheet.png` | `SheetHeader`: крестик-`IconButton` + `textAction` «Сбросить» | кнопка-иконка в шторке |
| `04-register.png` | `BackButton` (chevronLeft) и primary-кнопка «Создать аккаунт» | кнопка-иконка + primary |

Запуск (dev-сервер должен отдавать worktree):

```
npx vite --host 0.0.0.0 --port 5221 --strictPort
node scripts/screenshot-mak49.mjs
```

Требует backend :3001 с `TASKFLOW_LAN_NO_AUTH=1` (RequireAuth сам логинится
через `/api/auth/lan` настоящим chromium, UA Mozilla/*).

## Проверки

- `npx tsc --noEmit -p tsconfig.app.json` — 6 pre-existing ошибок в файлах,
  которые эта задача не трогала (AttachmentViewerSheet, CollaborationPlanPanel,
  DayHours, UpcomingCalendar, LabelTasksScreen); новых нет.
- `npx vitest run` — 12 файлов / 168 тестов, зелёные.
- `npx vite build` — успех (CSS 100.04 КБ).

## Ограничения

- Полная замена всех инлайновых `tap-scale`-кнопок (≈74) не делалась: правка
  затронула общие и шапки; остальные экраны — по мере их правки (тот же
  подход, что у MAK-54 для полей/шторок).
- Сверка «рядом с iOS» — задача MAK-56 (приёмка по кадрам); в этом runtime
  iOS-эталон доступен только на MacBook владельца.
