// TaskFlowWidgetBundle.swift
// Главный бандл виджетов TaskFlow для iOS.

import SwiftUI
import WidgetKit

@main
struct TaskFlowWidgetBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOS 16.1, *) {
      TaskActivityWidget()
    }
  }
}
