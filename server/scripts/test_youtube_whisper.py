# Тест: инструмент youtube отдаёт текст и когда субтитров нет (через локальный Whisper).
# Прогон: python3 server/scripts/test_youtube_whisper.py
#
# Владелец 09.11.2026: часть роликов идёт без субтитров, а yt-dlp на них
# вообще не отдаёт форматы. Инструмент должен не падать, а распознавать
# звук локальным ASR и возвращать текст с пометкой источника.

import sys
import unittest

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import mcp_server as m  # noqa: E402


class _FakeCompleted:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


class TestYoutubeWhisperFallback(unittest.TestCase):
    def setUp(self):
        self._orig_run = m.subprocess.run
        self._orig_cookies = m._youtube_cookie_file
        m._youtube_cookie_file = lambda work: None
        m.subprocess.run = lambda *a, **kw: _FakeCompleted(stdout="Название ролика\n")

    def tearDown(self):
        m.subprocess.run = self._orig_run
        m._youtube_cookie_file = self._orig_cookies
        for name in ("_youtube_transcript_api", "_youtube_subs_text", "_youtube_whisper_text"):
            if hasattr(m, name):
                delattr(m, name)

    def test_ytdlp_knows_js_runtime(self):
        """Без JS-рантайма yt-dlp 2026.x не отдаёт ни одного формата."""
        self.assertIn("--js-runtimes", m.YTDLP_JS_ARGS)
        self.assertIn("--remote-components", m.YTDLP_JS_ARGS)

    def test_prefers_transcript_api_before_ytdlp(self):
        """Прямой API субтитров не должен запускать хрупкий yt-dlp путь."""
        m._youtube_transcript_api = lambda url, languages, cap: {
            "title": "Из API",
            "url": url,
            "transcript": "текст из прямого API",
            "chars": 22,
            "truncated": False,
            "source": "youtube-transcript-api",
            "sub_file": None,
        }
        m._youtube_subs_text = lambda *args: self.fail("yt-dlp не должен вызываться")

        result = m.t_youtube({"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"})

        self.assertEqual(result["source"], "youtube-transcript-api")
        self.assertEqual(result["transcript"], "текст из прямого API")

    def test_falls_back_to_whisper_when_no_subtitles(self):
        m._youtube_subs_text = lambda url, langs, work, cookie_args: (None, "субтитров нет", None)
        m._youtube_whisper_text = lambda url, work, cookie_args: "распознанный текст ролика"

        result = m.t_youtube({"url": "https://www.youtube.com/watch?v=test"})

        self.assertEqual(result["transcript"], "распознанный текст ролика")
        self.assertEqual(result["source"], "whisper")
        self.assertEqual(result["title"], "Название ролика")

    def test_prefers_subtitles_when_present(self):
        m._youtube_subs_text = lambda url, langs, work, cookie_args: ("текст из субтитров", "", "s.ru.vtt")
        m._youtube_whisper_text = lambda url, work, cookie_args: self.fail("Whisper не должен вызываться")

        result = m.t_youtube({"url": "https://www.youtube.com/watch?v=test"})

        self.assertEqual(result["transcript"], "текст из субтитров")
        self.assertEqual(result["source"], "subtitles")

    def test_reports_both_reasons_when_both_paths_fail(self):
        m._youtube_subs_text = lambda url, langs, work, cookie_args: (None, "антибот-блок YouTube", None)

        def boom(url, work, cookie_args):
            raise m.TaskFlowError("ASR .110 недоступен")

        m._youtube_whisper_text = boom

        with self.assertRaises(m.TaskFlowError) as ctx:
            m.t_youtube({"url": "https://www.youtube.com/watch?v=test"})
        message = str(ctx.exception)
        self.assertIn("антибот-блок YouTube", message)
        self.assertIn("ASR .110 недоступен", message)


if __name__ == "__main__":
    unittest.main(verbosity=2)
