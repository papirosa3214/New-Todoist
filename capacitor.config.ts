import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.maksim.taskflow",
  appName: "Задачи",
  webDir: "dist",
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
