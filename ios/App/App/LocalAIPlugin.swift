// LocalAIPlugin — распознавание речи на устройстве и разбор диктовки на
// подзадачи, без похода на сервер .110 (18.08.2026, прямая просьба:
// «мне задержка не нравится очень долгая»). Сетевой round-trip до .110
// (ASR :1235 faster-whisper + Ollama :11434 27B) и есть основная задержка,
// не сама модель.
//
// ═══ Три независимых движка, не путать их требования ═══
//
// 1. Whisper через WhisperKit (CoreML) — ГЛАВНЫЙ путь распознавания.
//    Работает в любом регионе, Apple Intelligence не нужен. Та же модель,
//    что на сервере .110, только локально. Модель качается ТОЛЬКО по
//    явной команде из настроек приложения (downloadModel) — это сотни
//    мегабайт, решение о трафике принимает пользователь.
//
// 2. DictationTranscriber (Speech.framework, iOS 26) — запасной путь,
//    пока Whisper не скачан/не прогрет. Это ровно та же плоская диктовка,
//    что под микрофоном системной клавиатуры, качество не выше её.
//    Работает в любом регионе.
//
//    Раньше здесь был SFSpeechRecognizer + requiresOnDeviceRecognition.
//    Переписано 18.08.2026, причина конкретная: у старого API нет способа
//    ДОСТАВИТЬ ассет. Он умеет только спросить supportsOnDeviceRecognition
//    и сдаться, если false — а false он отдаёт даже когда у пользователя
//    русская диктовка на клавиатуре скачана и работает, потому что
//    инвентарь ассетов приложения отдельный от системного. Установить
//    свою копию умеет только AssetInventory (iOS 26+) — см. ensureAsset().
//
// 3. FoundationModels (suggestSubtasks) — ТРЕБУЕТ Apple Intelligence.
//    В российском регионе недоступен, и смена региона не поможет: у
//    SystemLanguageModel русского нет в supportedLanguages. Эта половина
//    обязана деградировать на серверный путь; JS читает флаг llm из
//    isAvailable() и не предлагает локальный разбор, если false.
//
// Один бинарник работает и на устройствах без Apple Intelligence, и на
// iOS < 26 — все проверки в рантайме, деградация тихая.

import AVFoundation
import Capacitor
import Foundation
import Speech
import UIKit
import WhisperKit
#if canImport(FoundationModels)
  import FoundationModels
#endif

private struct LocalAIError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
  init(_ message: String) { self.message = message }
}

// ═══════════ Whisper на устройстве (WhisperKit / CoreML) ═══════════
//
// Модель НЕ шарится с другими приложениями: песочница iOS, у каждого свой
// контейнер. Уже скачанные другими приложениями модели переиспользовать
// нельзя технически — нужна своя копия.
//
// Загрузка модели в память идёт фоном и никогда не блокирует диктовку:
// пока Whisper не готов, transcribe() отдаёт результат Apple-движка.
actor WhisperEngine {
  static let shared = WhisperEngine()

  static let defaultModel = "openai_whisper-large-v3-v20240930_turbo_632MB"
  private static let selectedKey = "whisper.selectedModel"

  // Список на случай, когда сети нет и fetchAvailableModels не отвечает —
  // настройки должны показывать хоть что-то.
  static let fallbackModels = [
    "openai_whisper-tiny",
    "openai_whisper-base",
    "openai_whisper-small_216MB",
    "openai_whisper-medium",
    "openai_whisper-large-v3-v20240930_turbo_632MB",
  ]

  private var kit: WhisperKit?
  private var loadedModel: String?
  private var loading = false
  private var downloadingModel: String?
  private var downloadProgress: Double = 0
  private var lastError: String?

  private let base: URL = {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("WhisperKitModels", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  var selectedModel: String {
    UserDefaults.standard.string(forKey: Self.selectedKey) ?? Self.defaultModel
  }

  func select(_ model: String) {
    UserDefaults.standard.set(model, forKey: Self.selectedKey)
    // Сбрасываем загруженную — следующая диктовка поднимет выбранную.
    kit = nil
    loadedModel = nil
  }

  /// Установленные модели — по факту наличия папки на диске, а не по флагу
  /// в UserDefaults: флаг рассинхронизируется при прерванном скачивании.
  func installedModels() -> [String] {
    let found = (try? FileManager.default.subpathsOfDirectory(atPath: base.path)) ?? []
    var names = Set<String>()
    for path in found {
      for part in path.split(separator: "/") where part.hasPrefix("openai_whisper-")
        || part.hasPrefix("distil-whisper_")
      {
        names.insert(String(part))
      }
    }
    return names.sorted()
  }

  private func folder(for model: String) -> URL? {
    let found = (try? FileManager.default.subpathsOfDirectory(atPath: base.path)) ?? []
    for path in found where path.hasSuffix(model) {
      let url = base.appendingPathComponent(path)
      var isDir: ObjCBool = false
      if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
        return url
      }
    }
    return nil
  }

  func status() -> [String: Any] {
    [
      "selected": selectedModel,
      "installed": installedModels(),
      "ready": kit != nil,
      "loadedModel": loadedModel ?? "",
      "loading": loading,
      "downloading": downloadingModel ?? "",
      "progress": downloadProgress,
      "error": lastError ?? "",
    ]
  }

  func availableModels() async -> [String] {
    do {
      let remote = try await WhisperKit.fetchAvailableModels()
      return remote.isEmpty ? Self.fallbackModels : remote
    } catch {
      return Self.fallbackModels
    }
  }

  func download(_ model: String, onProgress: @escaping @Sendable (Double) -> Void) async throws {
    guard downloadingModel == nil else {
      throw LocalAIError("Уже качается \(downloadingModel ?? "")")
    }
    downloadingModel = model
    downloadProgress = 0
    defer { downloadingModel = nil }
    do {
      _ = try await WhisperKit.download(
        variant: model, downloadBase: base, useBackgroundSession: false
      ) { progress in
        onProgress(progress.fractionCompleted)
      }
      lastError = nil
    } catch {
      lastError = error.localizedDescription
      throw error
    }
  }

  func delete(_ model: String) throws {
    guard let url = folder(for: model) else { return }
    try FileManager.default.removeItem(at: url)
    if loadedModel == model {
      kit = nil
      loadedModel = nil
    }
  }

  /// Грузит выбранную модель в память, если она установлена. НЕ качает.
  func ensureLoading() {
    let model = selectedModel
    guard kit == nil, !loading, folder(for: model) != nil else { return }
    loading = true
    Task { await self.load(model) }
  }

  private func load(_ model: String) async {
    do {
      let config = WhisperKitConfig(
        model: model, modelFolder: folder(for: model)?.path,
        verbose: false, logLevel: .error, prewarm: true, load: true, download: false)
      kit = try await WhisperKit(config)
      loadedModel = model
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    loading = false
  }

  /// nil — Whisper не готов (не установлен / грузится / упал), вызывающий
  /// обязан использовать Apple-путь.
  func transcribe(path: String, waitSeconds: Double) async -> String? {
    ensureLoading()
    let deadline = ContinuousClock.now.advanced(by: .seconds(waitSeconds))
    while kit == nil, loading, ContinuousClock.now < deadline {
      try? await Task.sleep(nanoseconds: 300_000_000)
    }
    guard let kit else { return nil }
    do {
      var options = DecodingOptions()
      options.language = "ru"
      // detectLanguage выключен намеренно: язык известен, автодетект на
      // коротких фразах уезжает в украинский/болгарский.
      options.detectLanguage = false
      let results = try await kit.transcribe(audioPath: path, decodeOptions: options)
      let text = results.map { $0.text }.joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      return text.isEmpty ? nil : text
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }
}

@objc(LocalAIPlugin)
public class LocalAIPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "LocalAIPlugin"
  public let jsName = "LocalAI"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "suggestSubtasks", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "prepareModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "modelStatus", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "downloadModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "selectModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
  ]

  private let targetLocale = Locale(identifier: "ru-RU")

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

    let authStatus = SFSpeechRecognizer.authorizationStatus()
    let authBlocked = authStatus == .denied || authStatus == .restricted

    guard #available(iOS 26.0, *) else {
      call.resolve([
        "llm": llmAvailable, "llmReason": llmReason,
        "asr": false, "asrReason": "Требуется iOS 26+",
      ])
      return
    }

    let locale = targetLocale
    Task {
      var asrReason = ""
      var asrStatus = "unknown"
      var asrOK = false

      if authBlocked {
        asrReason = "Нет разрешения на распознавание речи (Настройки → Конфиденциальность → Речь)"
      } else if let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
        // .supported тоже OK: ассет ещё не стоит, но transcribe() доставит
        // его сам. false тут значило бы «спрятать кнопку навсегда» — ровно
        // та ошибка, из-за которой путь выглядел как «модели есть, а не
        // работает».
        let status = await AssetInventory.status(forModules: [
          DictationTranscriber(locale: supported, preset: .longDictation)
        ])
        switch status {
        case .installed: asrStatus = "installed"; asrOK = true
        case .downloading: asrStatus = "downloading"; asrOK = true
        case .supported: asrStatus = "supported"; asrOK = true
        case .unsupported:
          asrStatus = "unsupported"
          asrReason = "Ассет распознавания для \(supported.identifier) недоступен на этом устройстве"
        @unknown default:
          // Новый случай в будущей iOS — считаем, что путь есть, и даём
          // transcribe() попробовать: он отдаст точную ошибку сам.
          asrStatus = "unknown"
          asrOK = true
        }
      } else {
        asrReason = "Распознавание \(locale.identifier) не поддерживается на этом устройстве"
      }

      let whisper = await WhisperEngine.shared.status()

      call.resolve([
        "llm": llmAvailable, "llmReason": llmReason,
        "asr": asrOK, "asrReason": asrReason, "asrAssetStatus": asrStatus,
        "whisperReady": whisper["ready"] ?? false,
        "whisperModel": whisper["selected"] ?? "",
      ])
    }
  }

  // ═══ Распознавание речи. Whisper первым, Apple как запас. ═══
  //
  // Принимает base64, не путь к файлу — без доп. зависимости на
  // @capacitor/filesystem (её нет в проекте, заводить ради одного
  // temp-файла не стоит). Сама пишет во временный файл и удаляет его
  // после — тот же Blob, что раньше уходил на /api/audio/transcribe.
  @objc func transcribe(_ call: CAPPluginCall) {
    guard let base64 = call.getString("audioBase64"),
      let data = Data(base64Encoded: base64)
    else {
      call.reject("audioBase64 обязателен — та же запись, что раньше шла на /api/audio/transcribe")
      return
    }

    guard #available(iOS 26.0, *) else {
      call.reject("Требуется iOS 26+ (Speech.framework SpeechAnalyzer)")
      return
    }

    // Расширение — из реального MIME записи, не угаданное: AVFoundation
    // определяет контейнер именно по нему, и на неверном отдаёт
    // kAudioFileUnsupportedFileTypeError (1954115647) вместо чтения.
    let mimeType = call.getString("mimeType") ?? ""
    guard let ext = Self.fileExtension(forMIME: mimeType) else {
      call.reject(
        "Формат записи \(mimeType) не читается AVFoundation — on-device распознавание невозможно, нужен mp4/AAC")
      return
    }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension(ext)
    do {
      try data.write(to: url)
    } catch {
      call.reject("Не удалось сохранить временный файл: \(error.localizedDescription)")
      return
    }

    let locale = targetLocale
    Task {
      // Единственная точка удаления файла — весь путь ниже async/await,
      // поэтому defer корректен (в отличие от старой callback-версии на
      // SFSpeechRecognizer, где он срабатывал до чтения файла).
      defer { try? FileManager.default.removeItem(at: url) }

      // Whisper первым, но с коротким ожиданием: если модель ещё грузится
      // в память, не держим пользователя — отдаём Apple-результат.
      if let whisperText = await WhisperEngine.shared.transcribe(
        path: url.path, waitSeconds: 3)
      {
        call.resolve(["text": whisperText, "engine": "whisper"])
        return
      }
      do {
        let text = try await self.runTranscription(fileURL: url, locale: locale)
        call.resolve(["text": text, "engine": "apple"])
      } catch {
        call.reject("Распознавание не удалось: \(error.localizedDescription)")
      }
    }
  }

  // WebM в списке отсутствует намеренно: AVFoundation его не декодирует ни
  // при каком расширении. Лучше явная ошибка здесь, чем мусорный OSStatus
  // из глубины AVAudioFile.
  private static func fileExtension(forMIME mime: String) -> String? {
    let base = mime.split(separator: ";").first.map(String.init)?
      .trimmingCharacters(in: .whitespaces).lowercased() ?? ""
    switch base {
    case "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "video/mp4": return "m4a"
    case "audio/wav", "audio/x-wav", "audio/wave": return "wav"
    case "audio/caf", "audio/x-caf": return "caf"
    case "audio/mpeg", "audio/mp3": return "mp3"
    case "audio/aiff", "audio/x-aiff": return "aiff"
    // Пустой MIME — старый JS без поля mimeType; m4a как исторический
    // default, всё равно самый вероятный на iOS.
    case "": return "m4a"
    default: return nil
    }
  }

  @available(iOS 26.0, *)
  private func runTranscription(fileURL: URL, locale: Locale) async throws -> String {
    guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else {
      throw LocalAIError("Распознавание \(locale.identifier) не поддерживается на этом устройстве")
    }

    let transcriber = DictationTranscriber(locale: supported, preset: .longDictation)
    try await ensureAuthorization()
    try await ensureAsset(for: transcriber, locale: supported)

    let file = try AVAudioFile(forReading: fileURL)
    guard
      let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
        compatibleWith: [transcriber], considering: file.processingFormat)
    else {
      throw LocalAIError("Не нашёлся совместимый аудиоформат для распознавателя")
    }
    let buffers = try convert(file: file, to: analyzerFormat)

    // Подписка на results ДО подачи аудио: results — живой AsyncSequence,
    // он отдаёт куски по ходу анализа. Подпишись после analyzeSequence —
    // начало фразы уже утекло.
    let collector = Task {
      var parts: [String] = []
      for try await result in transcriber.results {
        parts.append(String(result.text.characters))
      }
      return parts.joined()
    }

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    for buffer in buffers {
      continuation.yield(AnalyzerInput(buffer: buffer))
    }
    continuation.finish()

    _ = try await analyzer.analyzeSequence(stream)
    try await analyzer.finalizeAndFinishThroughEndOfInput()

    let text = try await collector.value
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  // Ассет приложения ≠ системная клавиатурная диктовка: у приложения свой
  // инвентарь, и если модели там нет — её надо СКАЧАТЬ, а не отрапортовать
  // «недоступно». reserve() закрепляет локаль за приложением (лимит —
  // maximumReservedLocales).
  @available(iOS 26.0, *)
  private func ensureAsset(for transcriber: DictationTranscriber, locale: Locale) async throws {
    if await AssetInventory.status(forModules: [transcriber]) != .installed {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        // Таймаут обязателен: без сети downloadAndInstall() не бросает, а
        // висит бесконечно — UI замирал молча, без всякой ошибки.
        try await withTimeout(
          seconds: 90,
          message:
            "Ассет распознавания не скачался: нет сети. Включи интернет один раз — дальше распознавание работает офлайн."
        ) {
          try await request.downloadAndInstall()
        }
      }
    }
    let installed = await DictationTranscriber.installedLocales
    guard installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
      throw LocalAIError(
        "Ассет распознавания \(locale.identifier) не установился — проверь сеть и свободное место")
    }
    try await AssetInventory.reserve(locale: locale)
  }

  // Гонка «операция против будильника»: кто первый, того и результат.
  private func withTimeout<T: Sendable>(
    seconds: Double, message: String, _ operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await operation() }
      group.addTask {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        throw LocalAIError(message)
      }
      guard let result = try await group.next() else { throw LocalAIError(message) }
      group.cancelAll()
      return result
    }
  }

  private func ensureAuthorization() async throws {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return
    case .denied, .restricted:
      throw LocalAIError("Нет разрешения на распознавание речи (Настройки → Конфиденциальность → Речь)")
    default:
      let status = await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
      }
      guard status == .authorized else {
        throw LocalAIError("Нет разрешения на распознавание речи (Настройки → Конфиденциальность → Речь)")
      }
    }
  }

  // Формат файла с диктофона (mp4/AAC) почти никогда не совпадает с тем,
  // что хочет распознаватель, — без конвертации analyzeSequence бросает.
  private func convert(file: AVAudioFile, to outFormat: AVAudioFormat) throws -> [AVAudioPCMBuffer] {
    let inFormat = file.processingFormat
    let frameCount = AVAudioFrameCount(file.length)
    guard frameCount > 0 else { throw LocalAIError("Пустая аудиозапись") }
    guard let inBuffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frameCount) else {
      throw LocalAIError("Не удалось выделить буфер под аудио")
    }
    try file.read(into: inBuffer)
    if inFormat == outFormat { return [inBuffer] }

    guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
      throw LocalAIError(
        "Не удалось создать конвертер \(inFormat.sampleRate)→\(outFormat.sampleRate) Гц")
    }
    let ratio = outFormat.sampleRate / inFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(frameCount) * ratio) + 4096
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else {
      throw LocalAIError("Не удалось выделить буфер под конвертированное аудио")
    }

    var fed = false
    var conversionError: NSError?
    let status = converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
      if fed {
        inputStatus.pointee = .endOfStream
        return nil
      }
      fed = true
      inputStatus.pointee = .haveData
      return inBuffer
    }
    if let conversionError { throw conversionError }
    guard status != .error, outBuffer.frameLength > 0 else {
      throw LocalAIError("Конвертация аудио не удалась")
    }
    return [outBuffer]
  }

  // ═══ Управление моделями из настроек приложения ═══
  // Всё, что пользователь может захотеть сделать с моделями, доступно из
  // UI: посмотреть список, скачать, выбрать, удалить. Без обращения к
  // разработчику и без пересборки.

  @objc func listModels(_ call: CAPPluginCall) {
    Task {
      let available = await WhisperEngine.shared.availableModels()
      var result = await WhisperEngine.shared.status()
      result["available"] = available
      call.resolve(result)
    }
  }

  @objc func modelStatus(_ call: CAPPluginCall) {
    Task { call.resolve(await WhisperEngine.shared.status()) }
  }

  @objc func downloadModel(_ call: CAPPluginCall) {
    guard let model = call.getString("model") else {
      call.reject("model обязателен")
      return
    }
    Task {
      do {
        try await WhisperEngine.shared.download(model) { [weak self] fraction in
          // Прогресс — событием, а не в ответе промиса: скачивание идёт
          // минуты, полоска в настройках должна двигаться по ходу.
          self?.notifyListeners(
            "whisperProgress", data: ["model": model, "progress": fraction])
        }
        var result = await WhisperEngine.shared.status()
        result["model"] = model
        call.resolve(result)
      } catch {
        call.reject("Не удалось скачать \(model): \(error.localizedDescription)")
      }
    }
  }

  @objc func selectModel(_ call: CAPPluginCall) {
    guard let model = call.getString("model") else {
      call.reject("model обязателен")
      return
    }
    Task {
      await WhisperEngine.shared.select(model)
      call.resolve(await WhisperEngine.shared.status())
    }
  }

  @objc func deleteModel(_ call: CAPPluginCall) {
    guard let model = call.getString("model") else {
      call.reject("model обязателен")
      return
    }
    Task {
      do {
        try await WhisperEngine.shared.delete(model)
        call.resolve(await WhisperEngine.shared.status())
      } catch {
        call.reject("Не удалось удалить \(model): \(error.localizedDescription)")
      }
    }
  }

  @objc func prepareModel(_ call: CAPPluginCall) {
    Task {
      await WhisperEngine.shared.ensureLoading()
      call.resolve(await WhisperEngine.shared.status())
    }
  }

  // ═══ Разбор диктовки на подзадачи — FoundationModels вместо Ollama.
  // Guided Generation (@Generable), не просьба вернуть JSON текстом:
  // серверный путь (server/src/routes/ai.ts, SYSTEM_PROMPT) вынужден
  // просить модель ответить «строго валидным JSON» и потом хрупко его
  // парсить (stripCodeFences/stripThinkTags/regex-фоллбек на первую [ и
  // последнюю ]) — потому что обычные chat-модели могут обвязать ответ
  // markdown-фенсами или think-тегами. FoundationModels даёт типобезопасный
  // вывод нативно. Смысл промпта (3-6 шагов, по-русски, конкретно) держать
  // согласованным с серверным при правке любого из двух мест — сам
  // механизм получения ответа осознанно разный.
  //
  // ВНИМАНИЕ: в RU-регионе этот путь недоступен (см. шапку файла) —
  // рабочим остаётся серверный. Оставлен как есть, чтобы заработал сам,
  // если регион/язык модели однажды появятся.
  #if canImport(FoundationModels)
    @available(iOS 26.0, *)
    @Generable
    struct SubtaskList {
      @Guide(
        description: "От 3 до 6 конкретных выполнимых шагов по-русски, каждый — короткая фраза с глагола"
      )
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
          let session = LanguageModelSession(
            instructions: """
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

// ═══ Регистрация плагина в мосте Capacitor ═══
//
// Без этого JS получает ровно {"code":"UNIMPLEMENTED"} на любой вызов
// LocalAI.*, а localAI.ts глушит это в catch и молча уходит на сервер —
// то есть весь нативный путь выглядит «как будто работает», но не
// вызывается никогда. Именно так и было до 18.08.2026.
//
// Автоподхвата тут нет: авто-регистрация Capacitor работает для плагинов,
// поставляемых пакетами (у них свой Package.swift и генерируемый список), а
// этот плагин живёт прямо в таргете App — его надо отдать мосту руками.
// capacitorDidLoad() — единственная точка, где bridge уже существует, но
// webView ещё не начал грузить JS; раньше (в SceneDelegate, сразу после
// init) нельзя — bridge там ещё nil.
//
// Класс лежит в этом файле осознанно: он уже в target App. Отдельный файл
// потребовал бы правки project.pbxproj — лишний риск ради пяти строк.
public class LocalAIBridgeViewController: CAPBridgeViewController {
  public override func capacitorDidLoad() {
    bridge?.registerPluginInstance(LocalAIPlugin())
  }
}
