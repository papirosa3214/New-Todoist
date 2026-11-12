"""Executed only by the Go fixture integration test; never uses real credentials."""
import asyncio
import os
from google import genai
from google.genai import types

async def main():
    url=os.environ["BROKER_FIXTURE_URL"]
    assert url.startswith("http://127.0.0.1:")
    client=genai.Client(api_key=os.environ["BROKER_FIXTURE_TOKEN"],
        http_options=types.HttpOptions(base_url=url+"/proxy/gemini"))
    try:
        async with client.aio.live.connect(model="gemini-3.8-live") as session:
            await session.send_realtime_input(audio=types.Blob(data=b"\x00\x01\x02\x03",mime_type="audio/pcm;rate=16000"))
            async for message in session.receive():
                if message.text:
                    assert message.text=="ready"
                    break
            else:
                raise AssertionError("no voice fixture output")
        print("VOICE_CHAIN_OK")
    finally:
        await client.aio.aclose()

if __name__=="__main__":
    asyncio.run(main())
