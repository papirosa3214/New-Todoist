// TFHapticsPlugin — виброотклик на CoreHaptics.
//
// Зачем свой плагин, когда стоит @capacitor/haptics (20.08.2026, владелец
// дважды подряд: «чуть помощнее… чтобы поощутимее»). Дело не в силе,
// выставленной из JS, а в потолке самого плагина — смотреть
// node_modules/@capacitor/haptics/ios/.../Haptics.swift:
//
//   func impact(_ style:) {
//     let generator = UIImpactFeedbackGenerator(style: style)
//     generator.impactOccurred()
//   }
//
// Две беды в трёх строках:
//
//  1. Генератор создаётся ЗАНОВО на каждый вызов и ни разу не prepare().
//     Taptic Engine у неподготовленного генератора просыпается с задержкой
//     в десятки миллисекунд, и первый удар выходит слабее и позже
//     заказанного. На одиночном «положил карточку» это незаметно, а на
//     шкале, где засечки идут одна за другой, слабым получается КАЖДЫЙ:
//     генератор всё время новый.
//  2. Потолок — .heavy. Отдельной силы у UIImpactFeedbackGenerator нет
//     (intensity появился только в iOS 13 и здесь не используется).
//
// CoreHaptics обоих ограничений не имеет: движок держится запущенным, а у
// события есть intensity и sharpness от 0 до 1. Sharpness — это не
// громкость, а «резкость» фронта: у засечки шкалы он должен быть высоким,
// иначе вместо щелчка выходит мягкий толчок, который на ходу пальца
// смазывается.
//
// Плагин деградирует молча: нет CoreHaptics (симулятор, старое железо) —
// работает через UIImpactFeedbackGenerator, но ОДИН раз созданный и
// подготовленный, то есть всё равно резче капаситоровского.

import Capacitor
import CoreHaptics
import Foundation
import UIKit

@objc(TFHapticsPlugin)
public class TFHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TFHapticsPlugin"
  public let jsName = "TFHaptics"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "tick", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
  ]

  private var engine: CHHapticEngine?
  private let lock = NSLock()

  // Запасные генераторы держим готовыми, а не создаём по требованию —
  // ровно то, чего не делает капаситоровский плагин.
  private lazy var lightGen: UIImpactFeedbackGenerator = {
    let g = UIImpactFeedbackGenerator(style: .light)
    g.prepare()
    return g
  }()
  private lazy var heavyGen: UIImpactFeedbackGenerator = {
    let g = UIImpactFeedbackGenerator(style: .heavy)
    g.prepare()
    return g
  }()

  private var supportsCoreHaptics: Bool {
    CHHapticEngine.capabilitiesForHardware().supportsHaptics
  }

  /// Поднять движок заранее — вызывается на захвате карточки и на первом
  /// касании барабана, чтобы первая же засечка была полной силы.
  @objc func prepare(_ call: CAPPluginCall) {
    ensureEngine()
    call.resolve()
  }

  @objc func tick(_ call: CAPPluginCall) {
    let intensity = Float(call.getDouble("intensity") ?? 1.0)
    let sharpness = Float(call.getDouble("sharpness") ?? 1.0)
    play(intensity: min(max(intensity, 0), 1), sharpness: min(max(sharpness, 0), 1))
    call.resolve()
  }

  private func ensureEngine() {
    guard supportsCoreHaptics else { return }
    lock.lock()
    defer { lock.unlock() }
    if engine != nil { return }
    do {
      let e = try CHHapticEngine()
      // Движок останавливают система и уход в фон — без этих двух
      // обработчиков он молча умирает после первого же сворачивания
      // приложения, и вибрация «пропадает до перезапуска».
      e.stoppedHandler = { [weak self] _ in
        self?.lock.lock()
        self?.engine = nil
        self?.lock.unlock()
      }
      e.resetHandler = { [weak self] in
        try? self?.engine?.start()
      }
      e.playsHapticsOnly = true
      try e.start()
      engine = e
    } catch {
      engine = nil
    }
  }

  private func play(intensity: Float, sharpness: Float) {
    guard supportsCoreHaptics else {
      fallback(intensity: intensity)
      return
    }
    ensureEngine()
    lock.lock()
    let e = engine
    lock.unlock()
    guard let e else {
      fallback(intensity: intensity)
      return
    }
    let event = CHHapticEvent(
      eventType: .hapticTransient,
      parameters: [
        CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
        CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
      ],
      relativeTime: 0)
    do {
      let pattern = try CHHapticPattern(events: [event], parameters: [])
      let player = try e.makePlayer(with: pattern)
      try player.start(atTime: CHHapticTimeImmediate)
    } catch {
      fallback(intensity: intensity)
    }
  }

  private func fallback(intensity: Float) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let gen = intensity >= 0.6 ? self.heavyGen : self.lightGen
      gen.impactOccurred()
      gen.prepare()
    }
  }
}
