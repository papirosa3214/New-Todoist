import SwiftUI

// Точка входа. Пока — заглушка канала сборки: проверяем, что проект генерится
// xcodegen'ом, собирается на Маке и ставится на телефон. Настоящая оболочка
// (таббар, навигация, сессия) приходит следующим шагом.
@main
struct TaskFlowApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    var body: some View {
        ZStack {
            Color(red: 0.09, green: 0.09, blue: 0.09).ignoresSafeArea()
            Text("TaskFlow Native")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
        }
    }
}
