/**
 * Мини-прокси для e2e: поднимает https перед приложением и передаёт запрос
 * дальше по http с заголовком `x-forwarded-proto: https`.
 *
 * Зачем: критерий приёмки «при открытии по https флаг Secure сохраняется»
 * нельзя проверить в браузере без настоящего TLS — браузер иначе не
 * примет Secure-cookie. Через этот прокси воспроизводится ровно боевой
 * случай «приложение за обратным прокси с https».
 *
 * Запуск: node e2e/https-proxy.mjs <https-порт> <http-порт-приложения> [хост]
 * Сертификат самоподписанный, лежит в data/e2e-cert (папка в .gitignore).
 * Браузеру Playwright он не страшен — в конфиге ignoreHTTPSErrors.
 */
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const httpsPort = Number(process.argv[2] ?? 3013);
const appPort = Number(process.argv[3] ?? 3012);
const host = process.argv[4] ?? "192.168.1.110";

const certDir = path.resolve(process.cwd(), "data", "e2e-cert");
const keyFile = path.join(certDir, "key.pem");
const certFile = path.join(certDir, "cert.pem");

function ensureCert() {
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) return;
  fs.mkdirSync(certDir, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyFile,
      "-out", certFile,
      "-days", "365",
      "-subj", "/CN=127.0.0.1",
      "-addext", `subjectAltName=IP:127.0.0.1,IP:${host},DNS:localhost`,
    ],
    { stdio: "ignore" },
  );
}

ensureCert();

const server = createServer(
  { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
  (inReq, inRes) => {
    const headers = { ...inReq.headers, "x-forwarded-proto": "https" };
    // Тело не перекодируем: иначе поток придётся распаковывать вручную.
    delete headers["accept-encoding"];
    delete headers.connection;

    const outReq = httpRequest(
      {
        host: "127.0.0.1",
        port: appPort,
        method: inReq.method,
        path: inReq.url,
        headers,
      },
      (outRes) => {
        inRes.writeHead(outRes.statusCode ?? 502, outRes.headers);
        outRes.pipe(inRes);
      },
    );
    outReq.on("error", (err) => {
      if (!inRes.headersSent) inRes.writeHead(502);
      inRes.end(String(err));
    });
    inReq.pipe(outReq);
  },
);

// Слушаем на всех интерфейсах: к прокси нужно достучаться по сетевому
// адресу, а не по loopback (см. пояснение в playwright.config.ts).
server.listen(httpsPort, () => {
  console.log(
    `[https-proxy] https://${host}:${httpsPort} -> http://127.0.0.1:${appPort}`,
  );
});