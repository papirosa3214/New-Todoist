# Каталог паттернов виджетов — 54 шт.

Источник: исследование для задачи 642dab51-006f-42db-b48e-aa3fa20be03f.
Базовые типы `widget` в TaskFlow: **metrics, progress, checklist, card, chart, weather** (плюс `html`-артефакт для интерактива).

## Сводная таблица

| № | Паттерн | Категория | Зачем (боль) | Источник | Ключевые элементы | TaskFlow-тип |
|---|---|---|---|---|---|---|
| 1 | Activity Rings | iOS | 3 кольца Move/Exercise/Stand | developer.apple.com/design/human-interface-guidelines/activity-rings | 3 концентрических кольца, % | new: rings |
| 2 | Commute Time | iOS | время в пути до работы/дома | applemagazine.com/apple-maps-routes-2026-1 | иконка транспорта, мин, статус | card |
| 3 | Now Playing Control | iOS | управление музыкой с экрана | apps.apple.com/us/app/widgetpod-music-widget/id1547172403 | обложка, кнопки play/pause/next | html |
| 4 | Live Activity Lock Screen | iOS | динамический статус (такси, доставка, спорт) | developer.apple.com/documentation/widgetkit | текст, прогресс-бар, статус-иконка | html, new: live-status |
| 5 | Inline Lock Screen | iOS | компактная инфо в строке уведомлений | developer.apple.com/design/human-interface-guidelines/widgets | иконка + короткий текст/число | metrics |
| 6 | StandBy Mode Clock | iOS | ночной режим с крупными часами | support.apple.com/en-us/118610 | часы + сменные мини-виджеты | card, html |
| 7 | Quick Action Button Grid | iOS | сетка 2×2 быстрых действий | flexibits.com/fantastical | кнопки 2×2 | html |
| 8 | Transit ETA | iOS | время до ближайшего автобуса/поезда | applemagazine.com/apple-maps-routes-2026-1 | мин, иконка транспорта | card |
| 9 | Large Format Calendar | iOS | крупный месяц с событиями | flexibits.com/fantastical | сетка дней с цветными маркерами | html |
| 10 | Interactive Toggle | Android | переключатель вкл/выкл прямо в виджете | culturedcode.com/things/blog | toggle switch | html |
| 11 | Glance System Widget | Android | нативный адаптивный виджет | Google Glance Docs | адаптивный контент | html |
| 12 | Smart Reply | Android | быстрые ответы Да/Нет | Android Glance | кнопки-ответы | html |
| 13 | KPI Metric Card | Web | 4 KPI с трендом и sparkline | 925studios.co/blog/stripe-dashboard-design-breakdown | число, % изменения, sparkline | metrics |
| 14 | Real-time Counter | Web | онлайн-счётчик, апдейт 30 сек | plausible.io/docs/metrics-definitions | текущее число, метка времени | metrics |
| 15 | Time Series Chart | Web | линейный график метрики | criticalcloud.ai/blog/datadog/interactive-dashboard-widgets-in-datadog | ось X/Y, линия тренда | chart |
| 16 | Stat Panel with Gauge | Web | цифра + цветовая шкала | grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/stat | число, шкала зелёный→красный | progress, metrics |
| 17 | Deployment Status | Web | Success/Fail/Pending бейдж | clemstation.com/deploy-status-for-vercel | бейдж, время деплоя, ссылка | card |
| 18 | Sparkline Trend | Web | мини-график внутри KPI карточки | artofstyleframe.com/blog/dashboard-design-patterns-web-apps | мини-график | metrics, chart |
| 19 | Top Sources List | Web | топ-5 источников трафика | plausible.io/real-time-web-analytics | таблица с числом | card |
| 20 | Heatmap Visualization | Web | 2D-плотность (запросы × время) | reintech.io/blog/visualizing-time-series-data-in-grafana | цветная сетка ячеек | new: heatmap |
| 21 | Log Stream Feed | Web | лента последних событий | docs.datadoghq.com/tracing/guide/apm_dashboard | строки логов | card, html |
| 22 | Empty State | Web | пустое состояние с CTA | 925studios.co/blog/stripe-dashboard-design-breakdown | иллюстрация, кнопка | card, html |
| 23 | Single Number Insight | Web | одна большая цифра | linear.app/docs/dashboards | число, дельта, сравнение | metrics |
| 24 | Kanban Board | Kanban | мини-доска с колонками | notion.com/help/boards | колонки, карточки | new: board |
| 25 | Gallery Card Grid | Kanban | сетка карточек с обложкой | notion.com/help/galleries | изображение, заголовок, описание | card |
| 26 | Task List Interactivity | Kanban | чекбоксы прямо в виджете | culturedcode.com/things/blog | чекбоксы, текст задачи | checklist |
| 27 | Sprint Burndown | Kanban | оставшаяся работа по спринту | linear.app/docs/dashboards | линия burndown | chart |
| 28 | Pinned Repos | Kanban | сетка закреплённых репо | github.com/sws2apps/github-contribution-heatmap | карточки репо | card |
| 29 | MR List | Kanban | открытые merge request | docs.gitlab.com/user/profile/contributions_calendar | строки с автором и статусом | card, checklist |
| 30 | Custom Field Card | Kanban | карточка с произвольными полями | trello.com/views | поля, значения | card |
| 31 | Streak Counter (Flame) | Metrics | огонёк дней подряд | blog.duolingo.com/how-duolingo-streak-builds-habit | иконка огня, число дней | metrics, card |
| 32 | Contribution Graph | Metrics | 52×7 сетка активности | medium.com/hackernoon/how-to-recreate-githubs-contribution-graph-a0a8d4d91011 | цветные ячейки | new: heatmap |
| 33 | Progress Ring Single | Metrics | круговой прогресс одной цели | apple.com/watch/close-your-rings | кольцо, % внутри | new: rings |
| 34 | Leaderboard Rank | Metrics | позиция в лиге, топ-3 | yukaichou.com/gamification-study | карточки с рангом | card |
| 35 | Daily Quest Checklist | Metrics | ежедневные квесты с галочками | blakecrosley.com/guides/design/duolingo | чекбоксы | checklist |
| 36 | Weekly Heatmap | Metrics | недельная тепловая карта | forum.obsidian.md/t/contribution-graph-generate-heatmap-charts-to-track-your-activity/73317 | сетка 7×N | new: heatmap |
| 37 | Spotify Wrapped Story | Media | story card с анимацией | uxplaybook.org/articles/spotify-wrapped-ux-design-lessons | крупная типографика, share | html |
| 38 | Trending Post Preview | Media | превью горячего поста | techcrunch.com/2022/09/14/apollos-app-brings-reddit-to-your-ios-16-lock-screen | аватар, текст, лайки | card |
| 39 | Audio Aura Visualizer | Media | визуализация аудиоауры | uxplaybook.org/articles/spotify-wrapped-ux-design-lessons | графическая композиция | html |
| 40 | Top Artist Profile Card | Media | карточка топ-артиста | newsroom.spotify.com/2025-12-03-2025-wrapped-user-experience | изображение, имя артиста | card |
| 41 | Listening Time Summary | Media | суммарное время прослушивания | vev.design/blog/year-end-review | число, мин/часы | metrics |
| 42 | Traffic Jam | Maps | пробки + время в пути | yandex.ru/support/m-maps/ru/jams | карта, балл пробок | card, html |
| 43 | Live Score | Maps | счёт матча в реальном времени | apps.apple.com/us/app/standings-live-score-widgets/id1533789849 | логотипы, счёт, таймер | card |
| 44 | Nearby Places | Maps | ближайшие кафе/магазины | applemagazine.com/apple-maps-routes-2026-1 | список мест с иконками | card |
| 45 | AQI Air Quality | Maps | качество воздуха | www.weathernow.app/guides/best-weather-widget-android | число, цветной статус | metrics |
| 46 | Up Next Event | Timeline | ближайшее событие из календаря | flexibits.com/fantastical | название, время, локация | card |
| 47 | Monthly Calendar Grid | Timeline | мини-календарь на месяц | macstories.net/reviews/fantasticals-widgets-pair-interactivity-with-superior-design | сетка дней, стрелки навигации | html |
| 48 | Upcoming Deadlines | Timeline | список ближайших дедлайнов | culturedcode.com/things/blog | список задач с датами | checklist, card |
| 49 | Unread Badge | Badges | mentions/непрочитанные | support.discord.com/hc/en-us/community/posts/360043326311-Disable-server-unread-count-badge | красный кружок, число | metrics |
| 50 | Reputation Badges | Badges | gold/silver/bronze набор | stackoverflow.design/system/components/badges | иконки, числа | card |
| 51 | Currency Converter | Util | конвертация + график курса | wise.com/gb/business-tools/fx-widget | ввод, результат, график | html |
| 52 | QR Code Generator | Util | генерация QR по ссылке | jotform.com/blog/best-free-qr-code-generator | ввод, изображение QR | html |
| 53 | Sticky Note | Util | заметка на рабочем столе | post-it.com/3M/en_US/post-it/ideas/app/faq | цветной фон, текст | card |
| 54 | Calculator | Util | калькулятор с дисплеем | apps.apple.com/us/app/calculator-widget-simple-calc/id6465680493 | дисплей, кнопки | html |

## Резюме по маппингу

**Закрываются текущими 6 типами widget** (~50%): KPI Metric Card, Real-time Counter, Time Series Chart, Stat Panel with Gauge, Deployment Status, Single Number Insight, Gallery Card Grid, Task List Interactivity, Pinned Repos, MR List, Custom Field Card, Streak Counter, Leaderboard Rank, Daily Quest Checklist, Trending Post Preview, Top Artist Profile Card, Listening Time Summary, Live Score, Nearby Places, AQI, Up Next Event, Upcoming Deadlines, Unread Badge, Reputation Badges, Sticky Note, Commute Time, Transit ETA, Inline Lock Screen, StandBy Mode Clock.

**Требуют html-артефакта** (~30%): Now Playing Control, Live Activity, Quick Action Button Grid, Large Format Calendar, Interactive Toggle, Glance System Widget, Smart Reply, Log Stream Feed, Empty State, Spotify Wrapped Story, Audio Aura Visualizer, Traffic Jam (для интерактивной карты), Monthly Calendar Grid, Currency Converter, QR Code Generator, Calculator.

**Требуют нового типа в TaskFlow** (~20%):
- `rings` — Activity Rings, Progress Ring Single (текущий `progress` только линейный, кольца не поддерживает)
- `heatmap` — Contribution Graph, Heatmap Visualization, Weekly Heatmap (нужна цветная 2D-сетка)
- `board` — Kanban Board (нужны колонки с вложенными карточками)
- `live-status` — Live Activity (динамическое обновление по событию, а не по таймеру)

## Ограничения и пробелы

1. **Coverage по источникам** — все 11 категорий из описания задачи покрыты. Сильнее всего: iOS WidgetKit, Web-дашборды, Notion/Trello (по 6+ паттернов). Слабее: Android Glance (Glance API не даёт примеров в открытом доступе, расширение будет через html-артефакт).
2. **Не проверено** — точные размеры и сетка для каждого паттерна (в pt/dp), а также accessibility (Dynamic Type, VoiceOver). Для финального документа Разработчику это нужно будет уточнять по Apple HIG и Material Design.
3. **Не выяснено** — какие из этих паттернов пользователь Максим действительно хочет видеть в Секретаре. Это нужно уточнять у владельца; сейчас каталог покрывает «всё подряд».
4. **Дубликаты** — Activity Rings и Progress Ring Single близки (одна — три кольца, другая — одно). Возможно, Разработчик сделает обоих на одном `rings`-типе с разным `count`.
5. **Спорное** — многие паттерны можно сделать через `card` + `html`-микс (например, AQI — это просто `metrics` с цветовым акцентом; Live Score — `card` с автообновлением). Финальный маппинг лучше делать вместе с Разработчиком.

## Ключевые источники (15)

1. developer.apple.com/design/human-interface-guidelines/widgets — Apple WidgetKit HIG
2. developer.apple.com/design/human-interface-guidelines/activity-rings — Apple Activity Rings
3. developer.apple.com/documentation/widgetkit — WidgetKit framework overview
4. apple.com/watch/close-your-rings — Apple Watch rings
5. applemagazine.com/apple-maps-routes-2026-1 — Apple Maps commute widget
6. culturedcode.com/things/blog — Things 3 (interactive widgets)
7. flexibits.com/fantastical — Fantastical widgets
8. macstories.net/reviews/fantasticals-widgets-pair-interactivity-with-superior-design — Fantastical review
9. 925studios.co/blog/stripe-dashboard-design-breakdown — Stripe Dashboard patterns
10. plausible.io/docs/metrics-definitions + plausible.io/real-time-web-analytics — Plausible
11. grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/stat — Grafana Stat
12. reintech.io/blog/visualizing-time-series-data-in-grafana — Grafana types overview
13. linear.app/docs/dashboards — Linear Insights/Dashboards
14. notion.com/help/boards, notion.com/help/galleries — Notion views
15. blog.duolingo.com/how-duolingo-streak-builds-habit + yukaichou.com/gamification-study — Duolingo streak
