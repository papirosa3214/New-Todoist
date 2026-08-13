import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS с самоподписанным сертификатом (не Let's Encrypt — под IP локальной
// сети настоящий сертификат не выпустить) — нужен ради getUserMedia (кнопка
// микрофона, TaskFormScreen): браузер отдаёт доступ к микрофону ТОЛЬКО в
// secure context, а исключение из этого правила — строго localhost/127.0.0.1,
// НЕ вся локальная сеть. На голом http://192.168.1.110:5180 микрофон не
// заработает ни с одного устройства, кроме самой .110. Браузер один раз
// покажет предупреждение «соединение не защищено» на каждом устройстве —
// после подтверждения запоминает. Существующий прокси /api и /ws ниже
// продолжает работать как есть: он выполняется на сервере (сам vite dev
// процесс → :3001), браузер их вообще не видит напрямую, так что HTTPS
// достаточно навесить только здесь.
export default defineConfig({
  // basicSsl() сам включает server.https — отдельно его выставлять не
  // нужно (и с этой версией vite даже не типизируется как `true`, только
  // как объект TLS-опций).
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
