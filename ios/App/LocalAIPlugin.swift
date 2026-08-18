// LocalAIPlugin — on-device распознавание речи и разбор диктовки на
// подзадачи, без похода на сервер .110 (18.08.2026, прямая просьба:
// «мне задержка не нравится очень долгая»). Сейчас оба шага идут через
// сеть до .110 (ASR :1235 faster-whisper + Ollama :11434 27B) — весь
// сетевой round-trip тут и есть основная задержка, не сама модель.
//
// Требует iOS 26+ (FoundationModels) и устройство с Apple Intelligence
// (Neural Engine соответствующего поколения — не любой iPhone). Именно
// поэтому deployment target всего проекта поднят с 15.0 — но каждый вызов
// внутри этого файла ЕЩЁ РАЗ проверяет доступность в рантайме
// (SystemLanguageModel.default.availability) и кидает явную ошибку, если
// модели нет — JS-сторона обязана ловить её и падать обратно на серверный
// путь (useTranscribeAudio/useSuggestSubtasksForDraft), не показывать
// пользователю голый краш. Один и тот же бинарник должен продолжать
// работать и на устройствах без Apple Intelligence — деградация тихая.
//
// ВАЖНО: этот файл не компилировался и не запускался в этой сессии — нет
// доступа к Xcode/симулятору/реальному устройству из headless-окружения.
// API названы по спецификации Apple (WWDC25 «Meet the Foundation Models
// framework») настолько точно, насколько возможно без живой сборки, но
// первый реальный прогон в Xcode — обязателен, не «наверное сработает».

import Capacitor
import Foundation
import Speech
#if canImport(FoundationModels)
  import FoundationModels
#endif

@objc(LocalAIPlugin)
public class LocalAIPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "LocalAIPlugin"
  public let jsName = "LocalAI"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "suggestSubtasks", returnType: CAPPluginReturnPromise),
  ]

  private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "ru-RU"))

  // ═══ Доступность — JS спрашивает ДО того, как пробовать, чтобы решить,
  // предлагать ли пользователю on-device путь вообще (или сразу идти на
  // сервер молча, без лишнего запроса разрешений на пустом месте). ═══
  @objc func isAvailable(_ call: CAPPluginCall) {
    var llmAvailable = false
    var llmReason = "iOS < 26 или сборка без FoundationModels"
    #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available:
          llmAvailable = true
          llmReason = ""
        case .unavailable(let reason):
          llmReason = "\(reason)"
        }
      }
    #endif

    let asrStatus = SFSpeechRecognizer.authorizationStatus()
    call.resolve([
      "llm": llmAvailable,
      "llmReason": llmReason,
      // ASR технически «доступен» и до granted — реальный prompt всплывёт
      // при первом transcribe(). notDetermined тоже считаем true: право
      // ещё можно запросить, не значит «нет».
      "asr": asrStatus != .denied && asrStatus != .restricted,
    ])
  }

  // ═══ Распознавание речи — SFSpeechRecognizer, requiresOnDeviceRecognition
  // = true явно (без этого флага движок иногда уходит на серверное
  // распознавание Apple же — тихо, без предупреждения — и тогда весь смысл
  // «без сети» теряется молча).
  //
  // Принимает base64, не путь к файлу — без доп. зависимости на
  // @capacitor/filesystem (её нет в проекте, заводить ради одного
  // temp-файла не стоит). Сама пишет во временный файл и удаляет его
  // после — тот же Blob, что раньше уходил на /api/audio/transcribe,
  // только закодированный на JS-стороне перед вызовом. ═══
  @objc func transcribe(_ call: CAPPluginCall) {
    guard let base64 = call.getString("audioBase64"),
      let data = Data(base64Encoded: base64)
    else {
      call.reject("audioBase64 обязателен — та же запись, что раньше шла на /api/audio/transcribe")
      return
    }

    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("m4a")
    do {
      try data.write(to: url)
    } catch {
      call.reject("Не удалось сохранить временный файл: \(error.localizedDescription)")
      return
    }
    // Не defer здесь — вся остальная работа (requestAuthorization,
    // recognitionTask) асинхронная callback-based, defer сработал бы
    // немедленно при выходе из этой функции, ДО того как распознаватель
    // реально прочитает файл (гонка: файл исчезал бы раньше, чем
    // используется). Удаление — в самих терминальных ветках callback'а
    // ниже, каждая из них последняя для этого запроса.

    guard let recognizer = speechRecognizer, recognizer.isAvailable else {
      try? FileManager.default.removeItem(at: url)
      call.reject("SFSpeechRecognizer недоступен для ru-RU на этом устройстве")
      return
    }
    guard recognizer.supportsOnDeviceRecognition else {
      try? FileManager.default.removeItem(at: url)
      call.reject("On-device распознавание русского недоступно на этом устройстве/версии iOS — путь только через сеть")
      return
    }

    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        try? FileManager.default.removeItem(at: url)
        call.reject("Нет разрешения на распознавание речи (Настройки → Конфиденциальность → Речь)")
        return
      }

      let request = SFSpeechURLRecognitionRequest(url: url)
      request.requiresOnDeviceRecognition = true
      request.shouldReportPartialResults = false

      recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
          try? FileManager.default.removeItem(at: url)
          call.reject("Распознавание не удалось: \(error.localizedDescription)")
          return
        }
        guard let result = result, result.isFinal else { return }
        try? FileManager.default.removeItem(at: url)
        call.resolve(["text": result.bestTranscription.formattedString])
      }
    }
  }

  // ═══ Разбор диктовки на подзадачи — FoundationModels вместо Ollama.
  // Guided Generation (@Generable), не просьба вернуть JSON текстом:
  // серверный путь (server/src/routes/ai.ts, SYSTEM_PROMPT) вынужден
  // просить модель ответить «строго валидным JSON» и потом хрупко его
  // парсить (stripCodeFences/stripThinkTags/regex-фоллбек на первую [ и
  // последнюю ]) — потому что обычные chat-модели могут обвязать ответ
  // markdown-фенсами или think-тегами. FoundationModels даёт типобезопасный
  // вывод нативно — не тот же приём «в лоб», а более правильный для этого
  // конкретно API. Смысл промпта (3-6 шагов, по-русски, конкретно) держать
  // согласованным с серверным при правке любого из двух мест — сам
  // механизм получения ответа осознанно разный.
  #if canImport(FoundationModels)
    @available(iOS 26.0, *)
    @Generable
    struct SubtaskList {
      @Guide(description: "От 3 до 6 конкретных выполнимых шагов по-русски, каждый — короткая фраза с глагола")
      let subtasks: [String]
    }
  #endif

  @objc func suggestSubtasks(_ call: CAPPluginCall) {
    guard let text = call.getString("text"), !text.isEmpty else {
      call.reject("text обязателен")
      return
    }

    #if canImport(FoundationModels)
      guard #available(iOS 26.0, *) else {
        call.reject("Требуется iOS 26+")
        return
      }
      guard case .available = SystemLanguageModel.default.availability else {
        call.reject("Apple Intelligence недоступен на этом устройстве")
        return
      }

      Task {
        do {
          let session = LanguageModelSession(instructions: """
            Ты помогаешь разбить надиктованный текст задачи на подзадачи.
            Дан заголовок/текст задачи — разбей на 3-6 конкретных,
            выполнимых шагов на русском языке.
            """)
          let response = try await session.respond(
            to: "Задача: \(text)",
            generating: SubtaskList.self
          )
          call.resolve(["subtasks": response.content.subtasks])
        } catch {
          call.reject("Разбор не удался: \(error.localizedDescription)")
        }
      }
    #else
      call.reject("Сборка без FoundationModels (нужен Xcode 26+ SDK)")
    #endif
  }
}
