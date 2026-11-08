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


if __name__ == "__main__":
    unittest.main()
