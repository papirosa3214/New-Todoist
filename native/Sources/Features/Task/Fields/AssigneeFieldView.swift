import SwiftUI

// «Назначить» — spec/SCREENS-1.md §5.5 п.8: picker исполнителя из списка
// агентов, пусто → «Выбрать исполнителя» с пунктирным кружком-плюсом. Список
// — ТОЛЬКО агенты `type == "ai"` (спека: «в списке у каждого агента (только
// для типа ai) — статус «на связи»/«не в сети»»).
struct AssigneeFieldView: View {
    let agents: [ApiUser]
    @Binding var selectedAgentId: String?
    @State private var isExpanded = false

    private var aiAgents: [ApiUser] { agents.filter { $0.type == .ai } }
    private var selected: ApiUser? { aiAgents.first { $0.id == selectedAgentId } }

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Назначить").tfText(.title).foregroundStyle(Color.tfText)

            Button {
                withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: TFField.iconTextGap) {
                    if let selected {
                        TFAvatar(size: .md, initials: selected.initials ?? "?",
                                  tint: selected.avatarColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
                        Text(selected.name).tfText(.body).foregroundStyle(Color.tfText)
                    } else {
                        Circle()
                            .strokeBorder(Color.tfDim, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                            .frame(width: 30, height: 30)
                            .overlay {
                                Image(systemName: "plus").font(.system(size: 14)).foregroundStyle(Color.tfDim)
                            }
                        Text("Выбрать исполнителя").tfText(.body).foregroundStyle(Color.tfSub)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 13)).foregroundStyle(Color.tfDim)
                }
                .padding(.horizontal, TFField.cardInsetH)
                .frame(minHeight: TFField.height)
                .background(Color.tfCard)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }
            .buttonStyle(TFTapRowStyle())

            if isExpanded {
                TFFieldGroup {
                    optionRow(name: "Без исполнителя", isOnline: nil, isSelected: selectedAgentId == nil) {
                        selectedAgentId = nil
                    }
                    ForEach(aiAgents) { agent in
                        TFFieldDivider()
                        optionRow(
                            name: agent.name, isOnline: agent.online, isSelected: selectedAgentId == agent.id,
                            avatarColor: agent.avatarColor.map { Color(hex: $0) }, initials: agent.initials
                        ) {
                            selectedAgentId = agent.id
                        }
                    }
                }
            }
        }
        .onChange(of: selectedAgentId) { _, _ in
            withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded = false }
        }
    }

    private func optionRow(
        name: String, isOnline: Bool?, isSelected: Bool,
        avatarColor: Color? = nil, initials: String? = nil, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: TFField.iconTextGap) {
                if let initials {
                    TFAvatar(size: .sm, initials: initials, tint: avatarColor ?? Color(hex: "#A6A6A6"))
                }
                Text(name).tfText(.body).foregroundStyle(Color.tfText)
                if let isOnline {
                    Text(isOnline ? "на связи" : "не в сети")
                        .tfText(.caption)
                        .foregroundStyle(isOnline ? Color.tfTeal : Color.tfDim)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(Color.tfRed)
                }
            }
            .padding(.horizontal, TFField.cardInsetH)
            .frame(minHeight: TFField.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }
}
