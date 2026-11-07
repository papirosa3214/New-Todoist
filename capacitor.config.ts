import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.maksim.taskflow",
  appName: "Задачи",
  webDir: "dist",
  // Логи JS-консоли в системный лог устройства. Capacitor по умолчанию ставит
  // "debug", то есть проксирует их ТОЛЬКО в отладочной сборке (см.
  // CAPInstanceDescriptor.h: none/debug/production). После перехода на Release
  // (18.08.2026, ради нагрева и расхода батареи) канал
  // `xcrun devicectl device process launch --console` замолчал — а именно им
  // диагностировались все причины на живом устройстве. "production" оставляет
  // его рабочим и в Release; на поведение приложения это не влияет.
  loggingBehavior: "production",
  // Без этого WKWebView рисует контент от самого верха экрана — уезжает
  // под статус-бар/Dynamic Island. В браузере/PWA это скрывал
  // apple-mobile-web-app-status-bar-style=black (Safari сам резервирует
  // место), но в native-режиме этот мета-тег не действует — своего
  // отступа под safe-area-inset-top в вёрстке нет (см. комментарий в
  // index.html). Официальный путь Capacitor — плагин StatusBar,
  // overlaysWebView:false, а не правка CSS.
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      // overlaysWebView:false заставляет плагин добавить СВОЙ отдельный
      // UIView поверх WKWebView, ровно под область статус-бара (см.
      // StatusBar.swift: initializeBackgroundViewIfNeeded — не сам
      // window/viewController, как можно ожидать). Дефолт этого view —
      // UIColor.black, отсюда была чёрная полоса, не совпадающая с
      // --color-bg приложения. Красим тем же цветом явно.
      backgroundColor: "#171717",
    },
  },
};

export default config;
