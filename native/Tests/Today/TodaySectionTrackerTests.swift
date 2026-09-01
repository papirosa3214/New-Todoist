import SwiftUI
import XCTest
@testable import TaskFlow

final class TodaySectionTrackerTests: XCTestCase {
    private let threshold: CGFloat = TodayHeaderMetrics.barHeight

    func testEmptyVirtualizationPassKeepsCurrentSection() {
        let overdue = mark("Просрочено")

        let next = TodaySectionTracker.next(
            current: overdue,
            crossing: sections[2],
            minY: threshold + 20,
            sections: sections,
            threshold: threshold
        )

        XCTAssertEqual(next?.title, "Просрочено")
    }

    func testCrossingNextBoundaryAdvancesSection() {
        let overdue = mark("Просрочено")

        let next = TodaySectionTracker.next(
            current: overdue,
            crossing: sections[2],
            minY: threshold - 1,
            sections: sections,
            threshold: threshold
        )

        XCTAssertEqual(next?.title, "1 сентября")
    }

    func testScrollingAboveFirstTrackedBoundaryReturnsToInitialSection() {
        let next = TodaySectionTracker.next(
            current: mark("Просрочено"),
            crossing: sections[1],
            minY: threshold + 1,
            sections: sections,
            threshold: threshold
        )

        XCTAssertNil(next)
    }

    func testOlderBoundaryCannotOverwriteLaterSection() {
        let next = TodaySectionTracker.next(
            current: mark("1 сентября"),
            crossing: sections[1],
            minY: threshold - 20,
            sections: sections,
            threshold: threshold
        )

        XCTAssertEqual(next?.title, "1 сентября")
    }

    private var sections: [TodaySectionInfo] {
        [
            .init(kind: .waiting, title: "Ждут вас", icon: nil, color: .white),
            .init(kind: .overdue, title: "Просрочено", icon: nil, color: .red),
            .init(kind: .today, title: "1 сентября", icon: nil, color: .gray),
        ]
    }

    private func mark(_ title: String) -> TodaySectionMark {
        TodaySectionMark(title: title, icon: nil, color: .white, minY: 0)
    }
}
