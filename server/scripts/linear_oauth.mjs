#!/usr/bin/env node
// Обмен client_credentials OAuth-приложения TaskFlow на access_token Linear.
//
// Запускается ТОЛЬКО через ~/.claude/vault-run.py, который подставляет
// LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET из хранилища в окружение дочернего
// процесса (в argv секреты не попадают). Наружу скрипт печатает единственный
// JSON: { access_token, expires_in }. Значения секретов не печатаются.
//
// Токен — не vault-значение, а производный результат, поэтому vault-run его не
// маскирует; сервер держит его в памяти и не пишет на диск.

const clientId = process.env.LINEAR_CLIENT_ID;
const clientSecret = process.env.LINEAR_CLIENT_SECRET;
const SCOPE = "read,write,issues:create,comments:create";

if (!clientId || !clientSecret) {
  console.log(JSON.stringify({ error: "no_credentials" }));
  process.exit(1);
}

async function main() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: SCOPE,
  });
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    // Ни тела ответа с секретом, ни заголовков наружу — только код и причина.
    console.log(JSON.stringify({ error: payload.error || "token_failed", status: response.status }));
    process.exit(1);
  }
  console.log(JSON.stringify({ access_token: payload.access_token, expires_in: Number(payload.expires_in) || 0 }));
}

main().catch((error) => {
  console.log(JSON.stringify({ error: "token_request_failed", message: String(error?.message || error).slice(0, 200) }));
  process.exit(1);
});
