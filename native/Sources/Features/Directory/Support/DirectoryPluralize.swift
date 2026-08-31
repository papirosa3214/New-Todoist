import Foundation

// Дубль `src/lib/pluralize.ts` (`taskWord`) — «1 задача / 2 задачи / 5 задач»,
// с исключением 11–14 («11 задач», не «11 задача»). Не самодостаточный
// компонент DesignSystem — просто общая функция для строк проектов/меток
// (ProjectsScreen/LabelsScreen), поэтому дубль здесь, а не там.
enum DirectoryPluralize {
    static func taskWord(_ n: Int) -> String {
        let mod100 = n % 100
        if mod100 >= 11 && mod100 <= 14 { return "задач" }
        let mod10 = n % 10
        if mod10 == 1 { return "задача" }
        if mod10 >= 2 && mod10 <= 4 { return "задачи" }
        return "задач"
    }
}
