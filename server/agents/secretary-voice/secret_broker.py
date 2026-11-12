"""Dormant Gemini Live broker adapter; never reads the original Gemini key."""
import json
import os
import re
import stat
from urllib.parse import urlsplit

def broker_voice_options(env=None):
    env = os.environ if env is None else env
    raw = env.get("TASKFLOW_SECRET_BROKER_BINDINGS", "").strip()
    if not raw:
        return None
    try:
        bindings = json.loads(raw)
        if not isinstance(bindings, list):
            raise ValueError()
        selected = [b for b in bindings if b.get("provider") == "secretary-voice"]
        if not selected:
            return None
        if len(selected) != 1:
            raise ValueError()
        binding = selected[0]
        alias = binding["alias"]
        if not isinstance(alias, str) or not re.fullmatch(r"[-a-zA-Z0-9._]{1,64}", alias):
            raise ValueError()
        url = urlsplit(binding["brokerUrl"])
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError()
        if not (url.scheme == "https" and url.hostname or
                url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")):
            raise ValueError()
        path = binding["tokenPath"]
        if not os.path.isabs(path):
            raise ValueError()
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError()
        with open(path) as stream:
            token = stream.read(65537).strip()
        if not token or len(token)>65536 or any(c in token for c in "\r\n\0"):
            raise ValueError()
        return {"api_key": token, "base_url": binding["brokerUrl"].rstrip("/") + "/proxy/" + alias}
    except (ValueError, TypeError, KeyError, OSError, AttributeError):
        raise ValueError("Broker connection credential unavailable") from None
