# YouTube session via Secret Broker

## Boundary

The owner signed in only through an isolated Chromium profile on .110. The Netscape cookie jar was written to the local Agent Secret Broker as `youtube-session`; it was never logged, sent to Composio, or persisted in the repository.

## Runtime

`mcp_server.py` requests the encrypted jar from the broker owner API only for one `youtube` tool invocation. It writes a `0600` file under the invocation temporary directory, passes that path to `yt-dlp`, then removes the entire directory in `finally`.

## Verification

The live research tool used the broker path. The earlier YouTube anti-bot response disappeared; the remaining test-video response was `Requested format is not available`, a separate caption/PO-token limitation.
