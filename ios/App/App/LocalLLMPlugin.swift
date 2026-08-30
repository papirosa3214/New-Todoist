// LocalLLMPlugin — языковая модель НА УСТРОЙСТВЕ, через MLX.
//
// Зачем ещё один движок, когда рядом есть LocalAIPlugin.suggestSubtasks:
// тот работает на Apple Intelligence (FoundationModels), а его в России
// нет вообще — ни на каком устройстве. Владелец 25.08.2026: «нет у меня
// Apple Intelligence, в России нету». Значит модель нужна своя, скачиваемая,
// и крутиться она должна на телефоне, а не на сервере .110 — «из телефона
// эта модель все и расшифровывает, не с сервера».
//
// Задача у неё узкая: по техническому куску (какой файл правит агент и что
// именно) выдать ОДНУ фразу по-русски, что он делает. Не диалог, не
// рассуждения — пересказ. Для этого 3B хватает, а больше на телефон и не
// стоит тащить.
//
// Модель НЕ входит в приложение и НЕ качается сама: это ~1.8 ГБ, решение о
// трафике и месте принимает владелец — тот же принцип, что у Whisper в
// LocalAIPlugin (downloadModel только по явной команде из настроек).
//
// MLX работает только на реальном железе Apple Silicon: на симуляторе Metal
// недоступен, поэтому там честно отвечаем «не поддерживается», а не падаем.
import Capacitor
import Foundation

#if canImport(MLXLLM) && !targetEnvironment(simulator)
  import MLXLLM
  import MLXLMCommon
  import Hub
#endif

/// Что качаем. mlx-community публикует уже квантованные веса — 4bit даёт
/// ~1.8 ГБ вместо ~6 ГБ у полной точности, при заметной, но приемлемой
/// потере качества на такой узкой задаче.
private let kModelId = "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit"

/// Одна фраза — значит и токенов немного. Ограничение жёсткое: без него
/// модель на телефоне может писать минуту и греть устройство.
private let kMaxTokens = 60

@objc(TFLocalLLMPlugin)
public class TFLocalLLMPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TFLocalLLMPlugin"
  public let jsName = "TFLocalLLM"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "explain", returnType: CAPPluginReturnPromise),
  ]

  #if canImport(MLXLLM) && !targetEnvironment(simulator)
    /// Контейнер держим один на процесс: загрузка весов в память занимает
    /// секунды и сотни мегабайт, повторять её на каждую фразу нельзя.
    private static var container: ModelContainer?
    private static var loading = false

    /// Куда Hub кладёт веса. Нужно знать, чтобы ответить «скачана ли» без
    /// сети и чтобы уметь удалить — по факту наличия папки, а не по флагу в
    /// настройках: флаг рассинхронизируется при прерванной загрузке (та же
    /// грабля, что описана в LocalAIPlugin про Whisper).
    private static var modelDirectory: URL {
      let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      return docs
        .appendingPathComponent("huggingface/models/\(kModelId)", isDirectory: true)
    }

    private static var isDownloaded: Bool {
      let dir = modelDirectory
      guard let items = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
        return false
      }
      // Пустая папка остаётся после прерванной загрузки — считать её
      // скачанной моделью нельзя.
      return items.contains { $0.hasSuffix(".safetensors") }
    }
  #endif

  @objc func isAvailable(_ call: CAPPluginCall) {
    #if canImport(MLXLLM) && !targetEnvironment(simulator)
      call.resolve(["available": true, "model": kModelId])
    #else
      call.resolve([
        "available": false,
        "reason": "MLX работает только на реальном устройстве",
      ])
    #endif
  }

  @objc func status(_ call: CAPPluginCall) {
    #if canImport(MLXLLM) && !targetEnvironment(simulator)
      call.resolve([
        "model": kModelId,
        "downloaded": Self.isDownloaded,
        "ready": Self.container != nil,
        "loading": Self.loading,
      ])
    #else
      call.resolve(["model": kModelId, "downloaded": false, "ready": false, "loading": false])
    #endif
  }

  @objc func download(_ call: CAPPluginCall) {
    #if canImport(MLXLLM) && !targetEnvironment(simulator)
      Task {
        do {
          try await Self.load { fraction in
            // Скачивание идёт минуты — молча ждать промис нельзя, экран
            // должен показывать полосу (так же сделано у Whisper).
            self.notifyListeners(
              "llmProgress", data: ["progress": fraction], retainUntilConsumed: false)
          }
          call.resolve(["downloaded": true, "ready": true])
        } catch {
          call.reject("Не удалось скачать модель: \(error.localizedDescription)")
        }
      }
    #else
      call.reject("MLX работает только на реальном устройстве")
    #endif
  }

  @objc func deleteModel(_ call: CAPPluginCall) {
    #if canImport(MLXLLM) && !targetEnvironment(simulator)
      Self.container = nil
      try? FileManager.default.removeItem(at: Self.modelDirectory)
      call.resolve(["downloaded": Self.isDownloaded])
    #else
      call.resolve(["downloaded": false])
    #endif
  }

  /// Главный метод: техническое описание действия -> одна фраза по-русски.
  @objc func explain(_ call: CAPPluginCall) {
    guard let action = call.getString("action"), !action.isEmpty else {
      call.reject("action обязателен")
      return
    }
    let step = call.getString("step") ?? ""

    #if canImport(MLXLLM) && !targetEnvironment(simulator)
      guard Self.isDownloaded else {
        call.reject("Модель не скачана")
        return
      }
      Task {
        do {
          let container = try await Self.load(progress: nil)
          let text = try await Self.generate(
            container: container, action: action, step: step)
          call.resolve(["text": text])
        } catch {
          call.reject("Не удалось разобрать: \(error.localizedDescription)")
        }
      }
    #else
      call.reject("MLX работает только на реальном устройстве")
    #endif
  }

  #if canImport(MLXLLM) && !targetEnvironment(simulator)
    @discardableResult
    private static func load(progress: ((Double) -> Void)?) async throws -> ModelContainer {
      if let container { return container }
      loading = true
      defer { loading = false }
      let container = try await LLMModelFactory.shared.loadContainer(
        configuration: ModelConfiguration(id: kModelId)
      ) { p in
        progress?(p.fractionCompleted)
      }
      Self.container = container
      return container
    }

    private static func generate(
      container: ModelContainer, action: String, step: String
    ) async throws -> String {
      // Инструкция намеренно жёсткая: 3B охотно уходит в рассуждения и
      // markdown, а нам нужна строка, которая влезет в одну строчку карточки.
      let system = """
        Ты объясняешь коротко и по-русски, чем занят программист.
        По техническому действию напиши ОДНУ фразу до 60 символов о том, что
        он делает — без кавычек, без markdown, без пояснений.
        Если из текста видно, что программист столкнулся с ошибкой (blocked) или сдал работу на проверку (review), добавь в конец ответа тег: [NOTIFY: краткая суть проблемы или успеха].
        """
      let user = step.isEmpty ? action : "Задача: \(step)\nДействие: \(action)"

      // Тип замыкания указан явно: у perform есть и синхронная перегрузка
      // с (model, tokenizer), и async с ModelContext — без аннотации
      // компилятор выбирает первую, а нам нужен весь контекст (процессор
      // для шаблона чата живёт именно там).
      return try await container.perform { (context: ModelContext) async throws -> String in
        // Формат сообщений — словарями, как принимает UserInput в этой
        // версии MLXLMCommon (см. UserInput.init(messages:)); типизированного
        // Chat.Message здесь ещё нет.
        let input = try await context.processor.prepare(
          input: UserInput(messages: [
            ["role": "system", "content": system],
            ["role": "user", "content": user],
          ])
        )
        // Длину режем счётчиком в didGenerate: в этой версии
        // GenerateParameters не принимает maxTokens, а без ограничения 3B на
        // телефоне может писать минуту и греть устройство.
        let result = try MLXLMCommon.generate(
          input: input,
          parameters: GenerateParameters(temperature: 0.2),
          context: context
        ) { tokens in
          tokens.count >= kMaxTokens ? .stop : .more
        }
        let out = result.output
        // Модель всё равно иногда добавляет кавычки или перевод строки —
        // подчищаем здесь, а не на клиенте: клиент печатает как есть.
        return
          out
          .trimmingCharacters(in: .whitespacesAndNewlines)
          .trimmingCharacters(in: CharacterSet(charactersIn: "\"«»"))
          .components(separatedBy: .newlines)
          .first ?? ""
      }
    }
  #endif
}
