import SwiftUI
import UIKit

// ═══════════ СВАЙП СТРОКИ: перенос веб-хука useRowSwipe на UIKit ═══════════
//
// 01.09.2026, Максим: «там, где есть свайпы влево-вправо, там пиздец какой-то
// происходит… была же, ты посмотри, как в вебе было настроено, там прям
// нативный свайп был. Надо посмотреть, как это было сделано, оно было сделано
// именно с учётом прям этого iOS».
//
// Эталон — `src/lib/useRowSwipe.ts` и `src/components/TaskRow.tsx` веб-версии:
// механика вылизана на живом устройстве, все числа взяты оттуда без изменений.
//
// ═══ Почему НЕ SwiftUI DragGesture ═══
//
// В вебе жест ловится вручную на pointer-событиях: пока направление не решено,
// браузер продолжает считать движение прокруткой, и список листается. У
// SwiftUI такого промежуточного состояния нет — `DragGesture` объявляет себя
// хозяином касания ещё до первого `onChanged`, и ScrollView остаётся без
// событий. Проверено на живом телефоне во всех трёх видах: `gesture`,
// `highPriorityGesture`, `simultaneousGesture` — список не листался пальцем по
// задаче ни в одном.
//
// UIKit даёт ровно то состояние, которого не хватает: распознаватель может
// сначала посмотреть на движение и объявить себя ПРОВАЛИВШИМСЯ, если палец
// пошёл вертикально. Тогда касание достаётся `UIScrollView`, и прокрутка
// работает как обычно.
//
// ═══ Почему через `UIGestureRecognizerRepresentable`, а не своей UIView ═══
//
// Первая попытка вешала распознаватель на `superview` вьюхи из `.background` —
// касания в него не приходили вовсе (тесты: прокрутка и тап зелёные, строка не
// сдвинулась ни на пиксель). Причина: UIKit доставляет касание только
// распознавателям на hit-tested вью и её предках, а фоновая вьюха — ПОТОМОК
// хоста строки, содержимое которой SwiftUI рисует сам, без отдельных UIView.
// Тайминг привязки тут ни при чём, местоположение в дереве неисправимо.
// `UIGestureRecognizerRepresentable` (iOS 18+) — штатный мост: SwiftUI сам
// ставит распознаватель туда, куда касания доходят.

/// Ширина открывающейся панели действия (веб: `ROW_ACTION_W`, `ACTION_W`).
public let TFRowActionWidth: CGFloat = 84
/// Порог, после которого решается направление (веб: `DIRECTION_LOCK_PX`).
private let directionLockPx: CGFloat = 8
/// Насколько горизонталь должна преобладать (веб: `DIRECTION_BIAS`).
private let directionBias: CGFloat = 1.3

/// Распознаватель, который начинается ТОЛЬКО на горизонтальном движении.
///
/// Решение принимается один раз, после порога `directionLockPx`, по той же
/// формуле, что в вебе: `|dx| > |dy| × 1.3`. Вертикаль → `.failed`, и касание
/// целиком достаётся прокрутке.
final class HorizontalPanRecognizer: UIPanGestureRecognizer {
    /// Точка касания, от которой считается смещение. Именно от неё, а не от
    /// момента `began`: иначе первые 8 пикселей жеста потерялись бы и строка
    /// прыгала бы под пальцем в начале движения.
    private(set) var startLocation: CGPoint = .zero
    private var decided = false

    override func reset() {
        super.reset()
        decided = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        decided = false
        if let touch = touches.first {
            startLocation = touch.location(in: view)
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if !decided, let touch = touches.first {
            let point = touch.location(in: view)
            let dx = point.x - startLocation.x
            let dy = point.y - startLocation.y

            // Порога ещё не достигли — молчим. Ни своим, ни чужим жест пока не
            // объявляем: у прокрутки свой распознаватель, он решит сам.
            guard abs(dx) > directionLockPx || abs(dy) > directionLockPx else { return }

            decided = true
            guard abs(dx) > abs(dy) * directionBias else {
                // Вертикаль — это прокрутка, не наше дело.
                state = .failed
                return
            }
            super.touchesMoved(touches, with: event)
            // Начинаем сами, не дожидаясь, пока `UIPanGestureRecognizer`
            // дозреет до своего порога: на быстром флике (и на коротких
            // синтетических свайпах XCUITest) событий мало, и жест иначе
            // срабатывает через раз.
            if state == .possible { state = .began }
            return
        }
        super.touchesMoved(touches, with: event)
    }

    /// Смещение пальца по X от точки касания (веб: `ev.clientX - d.startX`).
    var horizontalTranslation: CGFloat {
        guard let view else { return 0 }
        return location(in: view).x - startLocation.x
    }
}

/// Горизонтальный свайп строки, не отбирающий вертикальную прокрутку.
///
/// Ставится обычным `.gesture(...)`. Логика решения — в
/// `HorizontalPanRecognizer`; сюда приходят уже готовые смещение и скорость.
struct HorizontalPan: UIGestureRecognizerRepresentable {
    /// Направление решено, жест наш (веб: `hapticCross()` в момент захвата).
    var onBegin: () -> Void = {}
    /// Смещение пальца по X за текущий жест.
    var onChange: (CGFloat) -> Void
    /// Итог жеста: смещение и скорость по X (px/с).
    var onEnd: (CGFloat, CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> HorizontalPanRecognizer {
        let recognizer = HorizontalPanRecognizer()
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: HorizontalPanRecognizer, context: Context) {
        switch recognizer.state {
        case .began:
            onBegin()
            onChange(recognizer.horizontalTranslation)
        case .changed:
            onChange(recognizer.horizontalTranslation)
        case .ended, .cancelled, .failed:
            onEnd(recognizer.horizontalTranslation, recognizer.velocity(in: recognizer.view).x)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        /// Прокрутке не мешаем — пусть распознаватели живут вместе.
        /// Вертикальный `ScrollView` по горизонтали всё равно не двигается,
        /// так что одновременная работа безопасна.
        func gestureRecognizer(_ g: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
