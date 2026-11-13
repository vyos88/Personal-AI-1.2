import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('singing_activity', Path(__file__).parents[1] / 'scripts/singing_activity.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ActivityTest(unittest.IsolatedAsyncioTestCase):
    async def test_windows_file_denial_cannot_break_request_or_leak_activity(self):
        state = module.Activity()
        async def app(scope, receive, send):
            self.assertEqual(state.snapshot()['active'], 1)
        with patch.object(Path, 'replace', side_effect=PermissionError('WinError 5')), patch.object(Path, 'write_text', side_effect=PermissionError('denied')):
            await module.RequestActivity(app, state)({'type': 'http', 'path': '/release_task'}, None, None)
        self.assertEqual(state.snapshot()['active'], 0)

    async def test_stream_remains_active_until_cancelled(self):
        state = module.Activity()
        started = asyncio.Event()
        async def app(scope, receive, send):
            started.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(module.RequestActivity(app, state)({'type': 'http', 'path': '/audio/test.wav'}, None, None))
        await started.wait()
        self.assertEqual(state.snapshot()['active'], 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(state.snapshot()['active'], 0)

    async def test_failed_request_releases_and_starts_idle_clock(self):
        clock = [100]
        state = module.Activity(lambda: clock[0])
        async def app(scope, receive, send):
            clock[0] = 110
            raise RuntimeError('request failed')
        with self.assertRaises(RuntimeError):
            await module.RequestActivity(app, state)({'type': 'http', 'path': '/query_result'}, None, None)
        self.assertEqual(state.snapshot(), {'active': 0, 'lastActivity': 110})

    async def test_health_observation_does_not_extend_idle(self):
        state = module.Activity(lambda: 100)
        state.clock = lambda: 200
        async def app(scope, receive, send):
            self.assertEqual(state.active, 0)
        for path in ('/health', '/v1/stats', '/alpha/runtime'):
            await module.RequestActivity(app, state)({'type': 'http', 'path': path}, None, None)
        self.assertEqual(state.snapshot(), {'active': 0, 'lastActivity': 100})


if __name__ == '__main__':
    unittest.main()
