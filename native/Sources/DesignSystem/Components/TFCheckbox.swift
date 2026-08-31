import SwiftUI

// Спека DESIGN-TOKENS.md не даёт размеров «чекбокса» напрямую — в строке
// задачи он убран целиком (18.08.2026, §4 «Строка задачи»), а раздел
// «Изменить» подзадачи тоже без кружка-переключателя (владелец 15.08.2026,
// см. SubtaskRow в TaskFields.tsx — там подзадачи только переименовывают/
// удаляют). Числа ниже сняты с живого места, где кружок РЕАЛЬНО есть и
// переключается — `SubtaskFeed.tsx` (чек-лист подзадач на экране задачи,
// компонент `StateMark`/`DashedRing`), плюс комментарий в спеке §5
// «Индикатор «в работе» у подзадачи» с точными длительностями/масштабом.
//
// Кружок общий для ВСЕХ состояний — 21×21, не «прыгает» между ними.

/// Простой булев чекбокс — заполненный зелёный круг с галочкой (состояние
/// «готово»), не заполненный — контурное кольцо `dim`. Годится для мест, где
/// нужно именно да/нет, а не полный набор статусов подзадачи.
public struct TFCheckbox: View {
    let isChecked: Bool
    let action: (() -> Void)?

    public init(isChecked: Bool, action: (() -> Void)? = nil) {
        self.isChecked = isChecked
        self.action = action
    }

    public var body: some View {
        let mark = ZStack {
            Circle()
                .fill(isChecked ? Color.tfGreen : Color.clear)
                .overlay {
                    if !isChecked {
                        Circle().strokeBorder(Color.tfDim, lineWidth: 2)
                    }
                }
            if isChecked {
                // 12 из 21 — та же пропорция, что у StateMark в вебе (галочка мельче поля).
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 21, height: 21)

        if let action {
            Button(action: action) { mark }
                .buttonStyle(TFTapScaleStyle())
                .frame(minWidth: TFHitTarget.min, minHeight: TFHitTarget.min)
                .contentShape(Rectangle())
        } else {
            mark
        }
    }
}

/// Полный статус подзадачи (`StateMark`/`DashedRing`, SubtaskFeed.tsx) — пять
/// состояний, кольцо только у «готово». Числа буквально из спеки §5:
/// цвет-волна дуги 0.8s (5 из 8 сегментов зажжено разом, 62.5% цикла),
/// пульсация 1.6s `scale(0.8571↔1.0952)` (18↔23px на базе 21px),
/// вращение обёртки 1.6s **linear** против часовой — три независимых слоя,
/// не рассинхрон. Сегменты неподвижны сами по себе, «дорисовывается» именно
/// цвет по кругу — вращается только обёртка целиком.
public enum TFSubtaskState { case done, running, pending, blocked, review }

public struct TFSubtaskStatusRing: View {
    let state: TFSubtaskState

    public init(_ state: TFSubtaskState) {
        self.state = state
    }

    public var body: some View {
        ZStack {
            switch state {
            case .done:
                Circle()
                    .fill(Color.tfGreen)
                    .overlay(Circle().strokeBorder(Color.tfGreen, lineWidth: 2))
                    .overlay {
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.white)
                    }
            case .running:
                DashedRing(active: true)
            case .pending:
                DashedRing(active: false)
            case .blocked:
                // text-orange — тот же цвет, что «заблокировано» в статусе задачи наверху (не coral: тот = «агент пропал»).
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 21))
                    .foregroundStyle(Color.tfOrange)
            case .review:
                // text-blue — тот же цвет, что «на проверке» в статусе задачи наверху.
                Image(systemName: "eye")
                    .font(.system(size: 21))
                    .foregroundStyle(Color.tfBlue)
            }
        }
        .frame(width: 21, height: 21)
    }
}

/// Пунктирное кольцо из 8 сегментов, реализация `DashedRing` под `trim(from:to:)`
/// (спека §5 прямо называет это native-эквивалентом `stroke-dashoffset`).
/// Точные углы сегментов веба (atan2 от центра, шаг 45°) на native не нужны —
/// `Circle().trim` кладёт сегменты равномерно сама; воспроизводим ЧИСЛА
/// (длительности, доля дуги, направления вращения), не пиксельные пути SVG.
private struct DashedRing: View {
    let active: Bool

    @State private var rotation: Double = 0
    @State private var pulse: CGFloat = 1
    @State private var glowPhase: Double = 0

    private let segmentCount = 8
    private let litFraction = 5.0 / 8.0 // 5 из 8 сегментов зажжены разом

    var body: some View {
        ZStack {
            ForEach(0..<segmentCount, id: \.self) { i in
                segment(index: i)
            }
        }
        .frame(width: 21, height: 21)
        .scaleEffect(active ? pulse : 1)
        .rotationEffect(.degrees(active ? rotation : 0))
        .onAppear { if active { startAnimating() } }
    }

    private func segment(index: Int) -> some View {
        let start = Double(index) / Double(segmentCount)
        let span = 0.35 / Double(segmentCount) // короткая дуга, промежутки между сегментами (14° приём из веба)
        let lit = active && litSegment(index)
        return Circle()
            .trim(from: start, to: start + span)
            .stroke(
                lit ? Color.tfText.opacity(0.9) : Color.tfDim,
                style: StrokeStyle(lineWidth: 3, lineCap: .round)
            )
    }

    private func litSegment(_ index: Int) -> Bool {
        // Волна «змейкой» по кругу: окно из 5 соседних сегментов, сдвигается фазой glowPhase.
        let offset = Int(glowPhase * Double(segmentCount)) % segmentCount
        let rel = (index - offset + segmentCount) % segmentCount
        return Double(rel) < Double(segmentCount) * litFraction
    }

    private func startAnimating() {
        withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
            rotation = -360 // против часовой
        }
        withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
            pulse = 23.0 / 21.0 // 1.0952
        }
        withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) {
            glowPhase = 1
        }
    }
}

#Preview("Чекбоксы") {
    VStack(alignment: .leading, spacing: TFSpacing.lg) {
        HStack(spacing: TFSpacing.md) {
            TFCheckbox(isChecked: false)
            TFCheckbox(isChecked: true)
        }
        HStack(spacing: TFSpacing.lg) {
            TFSubtaskStatusRing(.done)
            TFSubtaskStatusRing(.running)
            TFSubtaskStatusRing(.pending)
            TFSubtaskStatusRing(.blocked)
            TFSubtaskStatusRing(.review)
        }
    }
    .padding()
    .background(Color.tfBackground)
}
