// Path on MacBook (выделенная копия Разработчика):
//   /Users/max/Проекты/TaskFlowDeveloper/Sources/Features/Settings/ServerParametersScreen.swift
// Ветка: codex/developer-mac  ·  HEAD: 7792e9aa
//
// Этот файл положен в worktree (роль builder) рядом с этой задачей,
// чтобы критик мог независимо прочитать код без доступа к MacBook.

import SwiftUI
import Observation

/// MAK-95 / задача `f19cf729` — нативный пульт управления сервером в
/// «Настройки → Сервер → Параметры». Серверная часть (`server/src/lib/
/// serverSettingsRegistry.ts` + `routes/admin-server-settings.ts`) принята
/// критиком на родительской задаче 581957c9; здесь только клиент.
@MainActor
@Observable
final class ServerParametersViewModel {
    private let api = APIClient()

    enum Phase: Equatable { case loading, failed, loaded }
    var phase: Phase = .loading

    private(set) var groupedSettings: [(group: String, items: [ServerSettingMetadata])] = []
    private(set) var values: [String: ServerSettingValue] = [:]
    private(set) var updatedAt: [String: String] = [:]

    private(set) var log: [ServerSettingsLogEntry] = []
    var logErrorMessage: String?

    var errorMessage: String?

    private(set) var pendingKeys: Set<String> = []

    func load() async {
        if groupedSettings.isEmpty { phase = .loading }
        async let settings = loadSettings()
        async let log = loadLog()
        let (settOutcome, logOutcome) = await (settings, log)
        applySettings(settOutcome)
        logErrorMessage = logOutcome.errorMessage
    }

    func reload() async {
        async let settings = loadSettings()
        async let log = loadLog()
        let (settOutcome, logOutcome) = await (settings, log)
        applySettings(settOutcome)
        logErrorMessage = logOutcome.errorMessage
    }

    @discardableResult
    func save(_ key: String, value: ServerSettingValue, reason: String?) async -> Bool {
        pendingKeys.insert(key)
        defer { pendingKeys.remove(key) }
        do {
            let response = try await api.putServerSetting(key: key, value: value, reason: reason)
            values[key] = response.value ?? value
            await reloadLogOnly()
            return true
        } catch {
            errorMessage = Self.message(error)
            await reload()
            return false
        }
    }

    @discardableResult
    func reset(_ key: String, reason: String?) async -> Bool {
        pendingKeys.insert(key)
        defer { pendingKeys.remove(key) }
        do {
            _ = try await api.resetServerSetting(key: key, reason: reason)
            await reload()
            return true
        } catch {
            errorMessage = Self.message(error)
            await reload()
            return false
        }
    }

    private func reloadLogOnly() async {
        logErrorMessage = (await loadLog()).errorMessage
    }

    private struct LoadOutcome {
        var settings: [ServerSettingMetadata]
        var values: [String: ServerSettingValue]
        var updatedAt: [String: String]
        var log: [ServerSettingsLogEntry]
        var errorMessage: String?
        var didSucceed: Bool
    }

    private func applySettings(_ outcome: LoadOutcome) {
        if outcome.didSucceed {
            groupedSettings = Self.group(outcome.settings)
            values = outcome.values
            updatedAt = outcome.updatedAt
            phase = .loaded
        } else if outcome.errorMessage != nil, groupedSettings.isEmpty {
            errorMessage = outcome.errorMessage
            phase = .failed
        } else if outcome.errorMessage != nil {
            errorMessage = outcome.errorMessage
        }
    }

    private func loadSettings() async -> LoadOutcome {
        do {
            let response = try await api.serverSettings()
            return LoadOutcome(
                settings: response.settings,
                values: response.values,
                updatedAt: response.updatedAt,
                log: [],
                errorMessage: nil,
                didSucceed: true
            )
        } catch {
            return LoadOutcome(
                settings: [],
                values: [:],
                updatedAt: [:],
                log: [],
                errorMessage: Self.message(error),
                didSucceed: false
            )
        }
    }

    private func loadLog() async -> LoadOutcome {
        do {
            let response = try await api.serverSettingsLog()
            return LoadOutcome(
                settings: [],
                values: [:],
                updatedAt: [:],
                log: response.log,
                errorMessage: nil,
                didSucceed: true
            )
        } catch {
            return LoadOutcome(
                settings: [],
                values: [:],
                updatedAt: [:],
                log: [],
                errorMessage: Self.message(error),
                didSucceed: false
            )
        }
    }

    private static func group(_ settings: [ServerSettingMetadata]) -> [(group: String, items: [ServerSettingMetadata])] {
        var orderedKeys: [String] = []
        var buckets: [String: [ServerSettingMetadata]] = [:]
        for setting in settings {
            if buckets[setting.group] == nil {
                orderedKeys.append(setting.group)
                buckets[setting.group] = []
            }
            buckets[setting.group]?.append(setting)
        }
        return orderedKeys.map { ($0, buckets[$0] ?? []) }
    }

    private static func message(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

struct ServerParametersScreen: View {
    @State private var viewModel = ServerParametersViewModel()

    var body: some View {
        ZStack {
            Color.tfBackground.ignoresSafeArea()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: TFSpacing.xl) {
                    introBlock
                    if let error = viewModel.errorMessage {
                        TFErrorBanner(error)
                    }
                    switch viewModel.phase {
                    case .loading:
                        TFLoading(.block)
                    case .failed:
                        Button {
                            Task { await viewModel.reload() }
                        } label: {
                            HStack(spacing: TFSpacing.md) {
                                Image(systemName: "arrow.clockwise")
                                    .foregroundStyle(Color.tfRed)
                                Text("Повторить")
                                    .tfText(.row)
                                    .foregroundStyle(Color.tfText)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, TFSpacing.lg)
                            .padding(.vertical, TFSpacing.md)
                            .overlay {
                                RoundedRectangle(cornerRadius: TFRadius.xl)
                                    .strokeBorder(Color.tfStroke, style: StrokeStyle(lineWidth: TFBorder.width, dash: [5]))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(TFTapRowStyle())
                    case .loaded:
                        ForEach(viewModel.groupedSettings, id: \.group) { group in
                            groupSection(group)
                        }
                        logSection
                    }
                }
                .padding(.horizontal, TFSpacing.screenHorizontal)
                .padding(.vertical, TFSpacing.lg)
            }
        }
        .tfNativeHeader("Параметры сервера")
        .task { await viewModel.load() }
    }

    private var introBlock: some View {
        Text("Все серверные параметры, которые раньше были константами. Владелец меняет их отсюда без перезапуска: изменения применяются сразу, в журнале остаётся кто, когда и зачем.")
            .tfText(.caption)
            .foregroundStyle(Color.tfSub)
    }

    @ViewBuilder
    private func groupSection(_ group: (group: String, items: [ServerSettingMetadata])) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            TFSectionHeader(group.group.capitalized)
            TFCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 {
                            TFDivider(inset: rowDividerInset)
                        }
                        ServerParameterRow(
                            setting: item,
                            value: viewModel.values[item.key] ?? item.defaultValue,
                            isPending: viewModel.pendingKeys.contains(item.key),
                            onSave: { newValue, reason in
                                Task {
                                    _ = await viewModel.save(item.key, value: newValue, reason: reason)
                                }
                            },
                            onReset: { reason in
                                Task {
                                    _ = await viewModel.reset(item.key, reason: reason)
                                }
                            }
                        )
                    }
                }
            }
        }
    }

    private var logSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            TFSectionHeader("Журнал изменений")
            TFCard(padding: 0) {
                if let message = viewModel.logErrorMessage {
                    Text(message)
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                        .padding(.horizontal, TFSpacing.lg)
                        .padding(.vertical, TFSpacing.md)
                } else if viewModel.log.isEmpty {
                    Text("Журнал пуст")
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                        .padding(.horizontal, TFSpacing.lg)
                        .padding(.vertical, TFSpacing.md)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(viewModel.log.enumerated()), id: \.element.id) { index, entry in
                            if index > 0 { TFDivider(inset: TFSpacing.lg) }
                            logRow(entry)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func logRow(_ entry: ServerSettingsLogEntry) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.xs) {
            HStack(spacing: TFSpacing.sm) {
                Text(entry.key)
                    .tfMonospaced(12, relativeTo: .caption)
                    .foregroundStyle(Color.tfText)
                    .lineLimit(1)
                Spacer(minLength: TFSpacing.sm)
                Text(formatted(entry.createdAt))
                    .tfText(.action)
                    .foregroundStyle(Color.tfDim)
            }
            if let reason = entry.reason, !reason.isEmpty {
                Text(reason)
                    .tfText(.action)
                    .foregroundStyle(Color.tfSub)
            }
            HStack(spacing: TFSpacing.sm) {
                valueChip(label: "было", value: entry.before)
                Image(systemName: "arrow.right")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.tfDim)
                valueChip(label: "стало", value: entry.after)
                Spacer(minLength: 0)
            }
            if let actor = entry.actor {
                Text(actor)
                    .tfText(.caption)
                    .foregroundStyle(Color.tfDim)
            }
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.vertical, TFSpacing.md)
    }

    private func valueChip(label: String, value: ServerSettingValue?) -> some View {
        HStack(spacing: TFSpacing.xs) {
            Text(label).tfText(.caption).foregroundStyle(Color.tfDim)
            Text(value?.displayString ?? "—").tfText(.action).foregroundStyle(Color.tfText)
        }
        .padding(.horizontal, TFSpacing.sm)
        .padding(.vertical, 2)
        .background(Color.tfCard2)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
    }

    private func formatted(_ iso: String) -> String {
        guard let date = DateFormats.iso8601(iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.dateFormat = "d MMM, HH:mm"
        return formatter.string(from: date)
    }

    private var rowDividerInset: CGFloat { TFSpacing.lg + 40 + TFSpacing.md }
}

struct ServerParameterRow: View {
    let setting: ServerSettingMetadata
    let value: ServerSettingValue
    let isPending: Bool
    let onSave: (ServerSettingValue, String?) -> Void
    let onReset: (String?) -> Void

    @State private var draft: String = ""
    @State private var isReasonSheetPresented = false
    @State private var pendingAction: PendingAction?
    @State private var inlineError: String?

    private enum PendingAction { case save(ServerSettingValue), reset }

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(setting.label)
                    .tfText(.body)
                    .foregroundStyle(Color.tfText)
                Spacer(minLength: TFSpacing.sm)
                if isPending {
                    ProgressView().scaleEffect(0.8)
                }
            }
            editor
            footer
            if let inlineError {
                Text(inlineError)
                    .tfText(.caption)
                    .foregroundStyle(Color.tfCoral)
            }
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.vertical, TFSpacing.md)
        .onAppear { syncDraft() }
        .onChange(of: value) { _, _ in syncDraft() }
        .tfBottomSheet(isPresented: Binding(
            get: { pendingAction != nil },
            set: { if !$0 { pendingAction = nil } }
        )) {
            reasonSheet
        }
    }

    @ViewBuilder
    private var editor: some View {
        switch setting.kind {
        case "bool":
            toggleEditor
        case "enum":
            enumEditor
        default:
            numberEditor
        }
    }

    private var toggleEditor: some View {
        HStack {
            Spacer(minLength: 0)
            TFToggle(isOn: Binding(
                get: { value == .bool(true) },
                set: { newValue in
                    pendingAction = .save(.bool(newValue))
                    isReasonSheetPresented = true
                }
            ))
            .disabled(isPending)
            .accessibilityIdentifier("server-param.\(setting.key).toggle")
        }
    }

    private var enumEditor: some View {
        let options = setting.options ?? []
        return Picker("", selection: Binding(
            get: {
                if case .string(let s) = value { return s }
                return options.first ?? ""
            },
            set: { newValue in
                pendingAction = .save(.string(newValue))
                isReasonSheetPresented = true
            }
        )) {
            ForEach(options, id: \.self) { option in
                Text(humanize(option)).tag(option)
            }
        }
        .pickerStyle(.segmented)
        .disabled(isPending || options.isEmpty)
    }

    private var numberEditor: some View {
        TextField(
            "Значение",
            text: Binding(
                get: { draft },
                set: { newValue in
                    draft = newValue.filter { $0.isNumber || $0 == "-" }
                }
            )
        )
        .keyboardType(.numberPad)
        .tfText(.input)
        .foregroundStyle(Color.tfText)
        .padding(.horizontal, TFSpacing.lg)
        .frame(minHeight: TFField.height)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        .disabled(isPending)
        .onSubmit { commitNumber() }
        .accessibilityIdentifier("server-param.\(setting.key).input")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let hint = boundsHint {
                Text(hint)
                    .tfText(.caption)
                    .foregroundStyle(Color.tfDim)
            }
            if !setting.appliesTo.isEmpty {
                Text("Применяется: \(setting.appliesTo.joined(separator: ", "))")
                    .tfText(.caption)
                    .foregroundStyle(Color.tfDim)
                    .lineLimit(2)
            }
            if !setting.isDefault(value) {
                Button {
                    pendingAction = .reset
                    isReasonSheetPresented = true
                } label: {
                    Text("Сбросить к дефолту")
                        .tfText(.action)
                        .foregroundStyle(Color.tfBlue)
                }
                .buttonStyle(.plain)
                .disabled(isPending)
                .accessibilityIdentifier("server-param.\(setting.key).reset")
            }
        }
    }

    private var boundsHint: String? {
        guard let min = setting.min, let max = setting.max else { return nil }
        return "Допустимо: \(formatBound(min))…\(formatBound(max))"
    }

    private func formatBound(_ value: Double) -> String {
        switch setting.kind {
        case "duration_min": return "\(Int(value)) мин"
        case "duration_ms": return "\(Int(value)) мс"
        case "interval_ms": return "\(Int(value)) мс"
        default: return "\(Int(value))"
        }
    }

    private func syncDraft() {
        draft = value.displayString
        inlineError = nil
    }

    private func commitNumber() {
        guard let parsed = Int(draft.trimmingCharacters(in: .whitespaces)) else {
            inlineError = "Введите целое число"
            return
        }
        if let min = setting.min, Double(parsed) < min {
            inlineError = "Меньше минимума (\(formatBound(min)))"
            return
        }
        if let max = setting.max, Double(parsed) > max {
            inlineError = "Больше максимума (\(formatBound(max)))"
            return
        }
        inlineError = nil
        pendingAction = .save(.int(parsed))
        isReasonSheetPresented = true
    }

    private var reasonSheet: some View {
        ReasonSheet(
            title: reasonTitle,
            onSubmit: { reason in
                guard let action = pendingAction else { return }
                switch action {
                case .save(let newValue): onSave(newValue, reason)
                case .reset: onReset(reason)
                }
                pendingAction = nil
            },
            onCancel: { pendingAction = nil }
        )
    }

    private var reasonTitle: String {
        switch pendingAction {
        case .save: return "Сохранить «\(setting.label)»?"
        case .reset: return "Сбросить «\(setting.label)» к дефолту?"
        case .none: return ""
        }
    }

    private func humanize(_ option: String) -> String {
        switch option {
        case "manual": return "Вручную"
        case "automatic": return "Автоматически"
        default: return option
        }
    }
}

private struct ReasonSheet: View {
    let title: String
    let onSubmit: (String?) -> Void
    let onCancel: () -> Void

    @State private var draft: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            Text(title)
                .tfText(.body)
                .foregroundStyle(Color.tfText)
            Text("Можно оставить пустым — журнал запишет только кто и когда.")
                .tfText(.caption)
                .foregroundStyle(Color.tfSub)
            TFTextField("Комментарий", text: $draft)
            HStack(spacing: TFSpacing.sm) {
                Button {
                    let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    onSubmit(value.isEmpty ? nil : value)
                } label: {
                    Text("Сохранить")
                        .tfText(.row).fontWeight(.semibold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, TFSpacing.lg)
                        .frame(height: 44)
                        .background(Color.tfRedSolid)
                        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                }
                .buttonStyle(TFTapScaleStyle())

                Button("Отмена") { onCancel() }
                    .tfText(.row)
                    .foregroundStyle(Color.tfSub)
                Spacer(minLength: 0)
            }
        }
        .padding(TFSpacing.lg)
    }
}
