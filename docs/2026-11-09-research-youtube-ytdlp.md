# Research egress: Tavily and YouTube

## Tavily

Role egress now sends only api.tavily.com through the existing restore-it route. Live web_search returned provider: tavily with three results. The prior 403 was the previous egress IP, not the API key.

## YouTube

The Debian yt-dlp 2024.04.09 failed at player-response extraction. The server now prefers the current user-managed ~/.local/bin/yt-dlp (2026.10.26), with PATH fallback.

The same tool now reaches YouTube through restore-it; the remaining response is Sign in to confirm you’re not a bot. No browser cookies were read or used. Owner authorization is required before using an existing authenticated browser session.
