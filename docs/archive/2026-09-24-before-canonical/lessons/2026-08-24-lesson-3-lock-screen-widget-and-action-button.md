# Урок 3: Виджет на экране блокировки, кнопка действия (Action Button) и мгновенный запуск голосовой диктовки

Подробное пошаговое руководство по настройке быстрого создания задач с экрана блокировки iPhone через виджеты, Deep Links и Action Button.

---

## 🎯 Архитектура решения

1. **Кастомная URL-схема (`Deep Link`)** — регистрация `taskflow://dictate` и `taskflow://create` в `Info.plist`.
2. **Capacitor URL Listener** — перехват URL при запуске приложения и автоматическое открытие окна диктовки с включением микрофона.
3. **App Intents (`TaskFlowAppIntents.swift`)** — регистрация нативных команд для приложения «Команды» (Shortcuts), Siri и кнопки действия Action Button.
4. **Lock Screen Widget** — виджет экрана блокировки, открывающий Deep Link в один тап.

---

## 💻 1. Регистрация Deep Link схемы в iOS (`Info.plist`)

В файле `ios/App/App/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLName</key>
        <string>com.maksim.taskflow</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>taskflow</string>
        </array>
    </dict>
</array>
```

Теперь открытие ссылки `taskflow://dictate` в Safari или виджете мгновенно поднимает приложение TaskFlow!

---

## 💻 2. Обработка URL и автозапуск диктовки в React

В главном компоненте `src/App.tsx`:

```tsx
import { useEffect } from "react";
import { App as CapApp } from "@capacitor/app";
import { useNavigate } from "react-router-dom";

export function App() {
  const navigate = useNavigate();

  useEffect(() => {
    // Слушатель входящих ссылок (при холодном старте и из фона)
    const sub = CapApp.addListener("appUrlOpen", (event) => {
      const url = new URL(event.url);
      
      // taskflow://dictate -> открываем создание задачи и включаем микрофон
      if (url.host === "dictate" || url.pathname.includes("dictate")) {
        navigate("/task/new?auto_dictate=1");
      }
      
      // taskflow://create -> обычное создание задачи
      if (url.host === "create" || url.pathname.includes("create")) {
        navigate("/task/new");
      }
    });

    return () => {
      sub.then((h) => h.remove());
    };
  }, [navigate]);

  return <Routes>...</Routes>;
}
```

В форме создания задачи `src/screens/TaskFormScreen.tsx`:

```tsx
export function TaskFormScreen() {
  const [searchParams] = useSearchParams();
  const autoDictate = searchParams.get("auto_dictate") === "1";
  const { startRecording } = useMicRecorder();

  useEffect(() => {
    if (autoDictate) {
      // Мгновенный запуск записи голоса при переходе по ссылке
      startRecording();
    }
  }, [autoDictate]);

  // ...
}
```

---

## 💻 3. App Intents для Action Button и Siri (`TaskFlowAppIntents.swift`)

Файл `ios/App/App/TaskFlowAppIntents.swift`:

```swift
import AppIntents
import Foundation

@available(iOS 16.0, *)
struct DictateTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Надиктовать задачу"
    static var description = IntentDescription("Открывает TaskFlow и сразу начинает запись задачи голосом.")
    
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: "taskflow://dictate") {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct TaskFlowShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: DictateTaskIntent(),
            phrases: [
                "Надиктовать задачу в \(.applicationName)",
                "Новая задача в \(.applicationName)",
                "Записать задачу в \(.applicationName)"
            ],
            shortTitle: "Диктовка задачи",
            systemImageName: "mic.fill"
        )
    }
}
```

---

## 📱 4. Настройка на iPhone:

### Вариант А: Кнопка действия (Action Button на iPhone 15 Pro / 16 / 16 Pro)
1. Откройте **«Настройки»** iOS → **«Кнопка действия»**.
2. Выберите раздел **«Быстрая команда»** (Shortcuts).
3. Выберите команду **«Надиктовать задачу»** (или создайте простую команду с открытием URL `taskflow://dictate`).
4. **Результат:** Зажатие кнопки действия в любой момент (даже при заблокированном телефоне) сразу включает запись голоса для новой задачи!

### Вариант Б: Виджет на экране блокировки (Lock Screen Widget)
1. Нажмите и удерживайте экран блокировки → нажмите **«Настроить»** → **«Экран блокировки»**.
2. В строке виджетов добавьте виджет приложения **«Быстрые команды»** с командой `taskflow://dictate` или виджет **TaskFlow**.
3. Выберите значок микрофона 🎙️.

---

## 🏆 Результат:
* **0 лишних нажатий:** зажали кнопку или коснулись виджета на экране блокировки → телефон разблокировался по Face ID и сразу слушает вашу речь!
* Офлайн-распознавание речи через Neural Engine на базе **WhisperKit CoreML** мгновенно превращает голос в текст и раскладывает по полям!
