# Secret Broker provider cutover — 2026-11-09

## Delivered

- Agent Secret Broker protocol 2 is installed as the system service on .110.
- TaskFlow server uses a separate revocable connection token, stored with mode 0600.
- Broker bindings are enabled for `minimax`, `opencode-go`, and `opencode`.
- Their original API keys were copied into the encrypted broker vault; role runtime routes through `127.0.0.1:28443/proxy/...` and does not read Pi auth keys for those providers.
- OpenCode traffic gets a stable `x-opencode-session` from the TaskFlow session; a generated per-runtime ID is only the fallback.

## Verification

- Broker health: protocol 2; HTTP proxy, SSE, OAuth refresh, WebSocket, loopback policy.
- Direct broker model catalog probes: HTTP 200 for MiniMax, OpenCode Go and OpenCode.
- Real TaskFlow `ModelRuntime` probe: `opencode-go/deepseek-v4.1-flash` returned HTTP 200 and a model response through the broker.

## Not migrated

Pi OAuth credentials for Anthropic, OpenAI Codex and xAI remain untouched. Their refresh configurations need provider-specific verification before cutover; they are not used by the current role routing.
