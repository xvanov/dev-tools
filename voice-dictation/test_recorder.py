"""python -m unittest test_recorder (numpy only: audio, clipboard and soundfile are stubbed)."""
import os
import sys
import tempfile
import types
import unittest

_DIR = tempfile.mkdtemp()
os.environ["VD_RECORDER_LOG"] = os.path.join(_DIR, "recorder.log")
for name in ("sounddevice", "soundfile", "pyperclip"):
    sys.modules.setdefault(name, types.SimpleNamespace(copy=lambda _t: None, write=None))
import recorder as rd  # noqa: E402

rd.RUNNING_FLAG = os.path.join(_DIR, "vd-running.flag")
rd.STOP_FLAG = os.path.join(_DIR, "vd-stop.flag")
rd.CANCEL_FLAG = os.path.join(_DIR, "vd-cancel.flag")


def read_log():
    try:
        with open(rd.LOG_PATH, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""


class FakeOverlay:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        return lambda *a, **k: self.calls.append((name, a, k))


class FakeRecorder:
    def __init__(self, result=None, exc=None):
        self._result, self._exc = result, exc

    def record(self):
        if self._exc:
            raise self._exc
        return self._result

    @staticmethod
    def cleanup():
        pass


class Base(unittest.TestCase):
    def setUp(self):
        open(rd.LOG_PATH, "w").close()


class PipelineFailure(Base):
    def test_exception_is_logged_and_closes_the_overlay(self):
        ov = FakeOverlay()
        err = OSError(28, "No space left on device")
        rd._recording_thread(FakeRecorder(exc=err), ov)

        statuses = [a[0] for n, a, _ in ov.calls if n == "set_status"]
        self.assertEqual(statuses, ["Error: disk full — free space and retry"])
        self.assertIn("close", [n for n, _, _ in ov.calls])
        log = read_log()
        self.assertIn("pipeline failed in phase recording", log)
        self.assertIn("Traceback", log)
        self.assertIn("temp free=", log)

    def test_a_dead_overlay_does_not_mask_the_error(self):
        class Dead:
            def __getattr__(self, name):
                def boom(*a, **k):
                    raise RuntimeError("main thread is not in main loop")
                return boom

        rd._recording_thread(FakeRecorder(exc=ValueError("boom")), Dead())
        log = read_log()
        self.assertIn("ValueError('boom')", log)
        self.assertIn("overlay.close failed", log)


class PipelineSuccess(Base):
    def setUp(self):
        super().setUp()
        self._saved = {k: sys.modules.get(k) for k in ("llm_cleanup", "history")}
        sys.modules["llm_cleanup"] = types.SimpleNamespace(cleanup=lambda t: (t.upper(), "python"))
        sys.modules["history"] = types.SimpleNamespace(append_entry=lambda *a, **k: None)
        self._t, self._p = rd._transcribe, rd._auto_paste
        rd._transcribe = lambda _p: ("zorbly", None)
        rd._auto_paste = lambda: None

    def tearDown(self):
        rd._transcribe, rd._auto_paste = self._t, self._p
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def test_phases_are_logged_in_order(self):
        ov = FakeOverlay()
        rd._recording_thread(FakeRecorder(result=(False, "x.wav")), ov)
        done = [a for n, a, _ in ov.calls if n == "show_done"]
        self.assertEqual(done[0][0], "ZORBLY")
        log = read_log()
        order = [log.index(p) for p in ("phase recording", "-> transcribing", "-> cleanup", "-> paste", "-> done")]
        self.assertEqual(order, sorted(order))


class WatchdogTest(Base):
    def test_fires_once_past_the_phase_deadline_with_stacks(self):
        now = [100.0]
        fired = []
        wd = rd.Watchdog(on_expire=fired.append, deadlines={"a": 5, "b": 1}, clock=lambda: now[0])
        wd.arm("a")
        now[0] += 4
        self.assertFalse(wd.check())
        wd.arm("b")  # re-arming resets the deadline
        now[0] += 2
        self.assertTrue(wd.check())
        self.assertFalse(wd.check())
        self.assertEqual(fired, ["b"])
        log = read_log()
        self.assertIn("WATCHDOG: phase 'b' exceeded 1s", log)
        self.assertIn("--- thread", log)

    def test_no_deadline_before_arming(self):
        wd = rd.Watchdog(on_expire=lambda p: self.fail("fired"), deadlines={}, clock=lambda: 1e9)
        self.assertFalse(wd.check())


class Flags(Base):
    def test_running_flag_holds_the_pid(self):
        rd._set_running(True)
        with open(rd.RUNNING_FLAG) as f:
            self.assertEqual(f.read(), str(os.getpid()))
        rd._set_running(False)
        self.assertFalse(os.path.exists(rd.RUNNING_FLAG))


class PreviewErrors(Base):
    def test_each_distinct_error_is_logged_once(self):
        r = rd.AudioRecorder()
        for _ in range(3):
            r._note_preview_error(OSError(28, "No space left on device"))
        r._note_preview_error("transcription timed out")
        log = read_log()
        self.assertEqual(log.count("preview failed: OSError"), 1)
        self.assertEqual(log.count("preview failed: transcription timed out"), 1)


class ShortError(unittest.TestCase):
    def test_disk_full_variants(self):
        self.assertIn("disk full", rd._short_error(OSError(28, "No space left on device")))
        e = OSError(None, "There is not enough space on the disk")
        e.winerror = 112
        self.assertIn("disk full", rd._short_error(e))

    def test_long_messages_are_trimmed(self):
        self.assertEqual(len(rd._short_error(ValueError("x" * 200))), 80)


if __name__ == "__main__":
    unittest.main()
