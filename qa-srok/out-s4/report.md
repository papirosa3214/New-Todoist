# Отчёт живой проверки
Приложение: http://127.0.0.1:4109 · экран 420×912@2 · chromium
Шагов: 8, упало: 2. Ошибок консоли: 2, pageerror: 0, ответов ≥400: 0.

✅ 1. goto "/upcoming"
✅ 2. wait 1500
✅ 3. snap "planirovanie-nachalo"
   кадр: 01-planirovanie-nachalo.png
   раскладка: замечаний нет
   текст экрана: "Что-то пошло не так\n\nЭкран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.\n\nНазад\nПерезагрузить"
✅ 4. scroll 500
✅ 5. wait 800
✅ 6. snap "planirovanie-prokrutka"
   кадр: 02-planirovanie-prokrutka.png
   раскладка: замечаний нет
   текст экрана: "Что-то пошло не так\n\nЭкран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.\n\nНазад\nПерезагрузить"
❌ 7. expect_text "QA-срок-завтра"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 03-ошибка-шаг-7.png
   раскладка: замечаний нет
   текст экрана: "Что-то пошло не так\n\nЭкран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.\n\nНазад\nПерезагрузить"
❌ 8. expect_text "Октябрь"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 04-ошибка-шаг-8.png
   раскладка: замечаний нет
   текст экрана: "Что-то пошло не так\n\nЭкран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.\n\nНазад\nПерезагрузить"

## Ошибки страницы
- pageerror: нет
- console.error: %o

%s

%s
 ReferenceError: MarkdownInline is not defined
    at TaskChip (http://127.0.0.1:4109/src/components/UpcomingCalendar.tsx:167:39)
    at Object.react_stack_bottom_frame (http://127.0.0.1:4109/node_modules/.vite/deps/react-dom_client.js?v=354e551e:12864:12)
    at renderWithHooks (http://127.0.0.1:4109/node_modules/.vite/deps/react-dom_client.js?v=354e551e:4211:19)
    at updateFunctionC
- console.error: [ErrorBoundary] Непойманная ошибка: ReferenceError: MarkdownInline is not defined
    at TaskChip (http://127.0.0.1:4109/src/components/UpcomingCalendar.tsx:167:39)
    at Object.react_stack_bottom_frame (http://127.0.0.1:4109/node_modules/.vite/deps/react-dom_client.js?v=354e551e:12864:12)
    at renderWithHooks (http://127.0.0.1:4109/node_modules/.vite/deps/react-dom_client.js?v=354e551e:4211:19
- сеть ≥400: нет

## Финальный экран (05-финал.png)
```
Что-то пошло не так

Экран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.

Назад
Перезагрузить
```