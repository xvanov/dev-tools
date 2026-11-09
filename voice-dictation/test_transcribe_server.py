"""python -m unittest test_transcribe_server (numpy only: faster_whisper is stubbed)."""
import os
import sys
import tempfile
import types
import unittest
import wave

import numpy as np

sys.modules.setdefault("faster_whisper", types.SimpleNamespace(WhisperModel=None))
import transcribe_server as ts  # noqa: E402


def write_wav(path, samples, rate=16000, channels=1, width=2):
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())


class ReadAudio(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def path(self, name):
        return os.path.join(self.dir, name)

    def test_pcm16_mono_16k_is_read_as_float(self):
        p = self.path("a.wav")
        write_wav(p, np.array([0, 16384, -32768, 32767], dtype="<i2"))
        a = ts._read_audio(p)
        self.assertEqual(a.dtype, np.float32)
        np.testing.assert_allclose(a, [0, 0.5, -1, 32767 / 32768])

    def test_other_formats_are_left_to_faster_whisper(self):
        p = self.path("b.wav")
        write_wav(p, np.zeros(8, dtype="<i2"), rate=48000)
        self.assertIsNone(ts._read_audio(p))
        write_wav(p, np.zeros(8, dtype="<i2"), channels=2)
        self.assertIsNone(ts._read_audio(p))
        with open(p, "wb") as f:
            f.write(b"not a wav")
        self.assertIsNone(ts._read_audio(p))

    def test_a_missing_file_is_an_error(self):
        with self.assertRaises(OSError):
            ts._read_audio(self.path("gone.wav"))


class Options(unittest.TestCase):
    def test_timestamps_only_across_windows(self):
        short = np.zeros(ts.RATE * 5, dtype=np.float32)
        long = np.zeros(ts.RATE * 60, dtype=np.float32)
        self.assertTrue(ts._options(short)["without_timestamps"])
        self.assertNotIn("without_timestamps", ts._options(long))
        self.assertNotIn("without_timestamps", ts._options(None))
        self.assertEqual(ts._options(short)["beam_size"], 1)


class SpeechActivity(unittest.TestCase):
    """The PA's meeting capture reads this log to tell dictation from a meeting."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "sub", "speech-activity.jsonl")

    def read(self):
        import json

        with open(self.log, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def test_one_line_per_request_with_when_the_audio_ended(self):
        wav = os.path.join(self.dir, "vd-final.wav")
        write_wav(wav, np.zeros(16000, dtype="<i2"))
        os.utime(wav, (1_800_000_000, 1_800_000_000))
        ts.note_activity(wav, 1.0, now=1_800_000_005, path=self.log)
        (e,) = self.read()
        self.assertEqual(e["end"], "2027-01-15T08:00:00.000Z")
        self.assertEqual(e["at"], "2027-01-15T08:00:05.000Z")
        self.assertEqual(e["seconds"], 1.0)
        self.assertEqual(e["file"], "vd-final.wav")

    def test_a_missing_file_still_logs_and_never_raises(self):
        ts.note_activity(os.path.join(self.dir, "gone.wav"), None, now=1_800_000_000, path=self.log)
        (e,) = self.read()
        self.assertIsNone(e["seconds"])
        self.assertEqual(e["end"], e["at"])

    def test_an_oversized_log_keeps_only_recent_lines(self):
        old_max = ts.ACTIVITY_MAX_BYTES
        ts.ACTIVITY_MAX_BYTES = 200
        try:
            for i in range(5):
                ts.note_activity("old.wav", 1, now=1_000_000_000 + i, path=self.log)
            ts.note_activity("new.wav", 1, now=1_000_000_000 + 10 * 86400, path=self.log)
        finally:
            ts.ACTIVITY_MAX_BYTES = old_max
        self.assertEqual([e["file"] for e in self.read()], ["new.wav"])


class NoThrottle(unittest.TestCase):
    def test_answers_whether_it_took(self):
        self.assertIsInstance(ts._no_throttle(), bool)
        if os.name != "nt":
            self.assertFalse(ts._no_throttle())


if __name__ == "__main__":
    unittest.main()
