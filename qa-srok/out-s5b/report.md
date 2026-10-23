# Отчёт живой проверки
Приложение: http://127.0.0.1:4109 · экран 420×912@2 · chromium
Шагов: 7, упало: 1. Ошибок консоли: 2, pageerror: 0, ответов ≥400: 0.

✅ 1. goto "/labels"
✅ 2. wait 1200
✅ 3. snap "metki-spisok"
   кадр: 01-metki-spisok.png
   раскладка: замечаний нет
   текст экрана: "Метки\nВажно\nСДЕЛКА\nUX/UI\nПриложение\nДом\nРобота\nIT\nOpus\nSonnet\nHaiku\nFable\nСоздать метку\nЗадача\nСо сроком и шагами\nЗаметка\nЗапись в дневнике\nПроект\nЗадачи и документация\n23\n1"
✅ 4. click "text=\"Важно\""
✅ 5. wait 1500
✅ 6. snap "metka-zadachi"
   кадр: 02-metka-zadachi.png
   раскладка: замечаний нет
   текст экрана: "Что-то пошло не так\n\nЭкран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.\n\nНазад\nПерезагрузить"
❌ 7. expect_text "QA-срок-завтра"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 03-ошибка-шаг-7.png
   раскладка: замечаний нет
   текст экрана: "Что-то пошло не так\n\nЭкран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.\n\nНазад\nПерезагрузить"

## Ошибки страницы
- pageerror: нет
- console.error: %o

%s

%s
 ReferenceError: MarkdownInline is not defined
    at http://127.0.0.1:4109/src/screens/LabelTasksScreen.tsx:164:45
    at Array.map (<anonymous>)
    at LabelTasksScreen (http://127.0.0.1:4109/src/screens/LabelTasksScreen.tsx:129:21)
    at Object.react_stack_bottom_frame (http://127.0.0.1:4109/node_modules/.vite/deps/react-dom_client.js?v=354e551e:12864:12)
    at renderWithHooks (htt
- console.error: [ErrorBoundary] Непойманная ошибка: ReferenceError: MarkdownInline is not defined
    at http://127.0.0.1:4109/src/screens/LabelTasksScreen.tsx:164:45
    at Array.map (<anonymous>)
    at LabelTasksScreen (http://127.0.0.1:4109/src/screens/LabelTasksScreen.tsx:129:21)
    at Object.react_stack_bottom_frame (http://127.0.0.1:4109/node_modules/.vite/deps/react-dom_client.js?v=354e551e:12864:12)
   
- сеть ≥400: нет

## Финальный экран (04-финал.png)
```
Что-то пошло не так

Экран не смог отрисоваться. Попробуйте вернуться назад или перезагрузить приложение — если ошибка повторится, опишите шаги в чате.

Назад
Перезагрузить
```