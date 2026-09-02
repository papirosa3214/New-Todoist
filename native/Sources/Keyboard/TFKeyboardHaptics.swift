import CoreHaptics
import UIKit

// Виброотклик на нажатие клавиши — аналог hapticKey()/prepare() из веба
// (src/lib/haptics.ts) и родного плагина TFHapticsPlugin.swift
// (ios/App/App/, CoreHaptics), см. spec/NATIVE-PARTS.md §2. Тот плагин ещё
// НЕ перенесён в Core/ (Core/ вообще пока пуст — волна 1 не дошла до этого
// куска), поэтому клавиатура несёт свою маленькую самодостаточную копию по
// тому же рецепту: держать двигатель прогретым (`prepare()`), не создавать
// генератор заново на каждый удар. Когда общий хаптик-сервис появится в
// Core/, эту обёртку стоит свести к нему — сейчас трогать Core/ нельзя
// (правило проекта), поэтому дублирование временное и осознанное.
//
// Параметры даны спекой буквально: intensity 0.6 / sharpness 0.8 / стиль
// Light — «на КАЖДОЕ нажатие клавиши, включая служебные» (спека §1.3).
final class TFKeyboardHaptics {
    static let shared = TFKeyboardHaptics()

    private var engine: CHHapticEngine?
    private let supportsHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    private let fallback = UIImpactFeedbackGenerator(style: .light)

    private init() {
        guard supportsHaptics else { return }
        engine = try? CHHapticEngine()
        // Движок останавливается системой сам (фон, звонок и т.п.) — перезапуск
        // по сбросу/остановке, иначе после первого такого события отклик молча
        // пропадает до следующего запуска приложения.
        engine?.resetHandler = { [weak self] in try? self?.engine?.start() }
        engine?.stoppedHandler = { [weak self] _ in try? self?.engine?.start() }
    }

    /// Разбудить двигатель заранее — на появлении клавиатуры (onAppear), чтобы
    /// первый щелчок не выходил слабее и позже остальных.
    func prepare() {
        guard supportsHaptics else { return }
        try? engine?.start()
    }

    /// Один щелчок клавиши. intensity 0.6 / sharpness 0.8 — лёгкий отклик,
    /// нарочно слабее засечек шкалы времени в остальном приложении: клавиша
    /// срабатывает по нескольку раз в секунду подряд при наборе, и тяжёлый
    /// отклик там превращается в тряску (см. комментарий hapticKey() в вебе).
    func tickKey() {
        guard supportsHaptics, let engine else {
            fallback.impactOccurred()
            return
        }
        let event = CHHapticEvent(
            eventType: .hapticTransient,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.6),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.8),
            ],
            relativeTime: 0
        )
        do {
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            fallback.impactOccurred()
        }
    }
}
