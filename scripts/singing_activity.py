"""ASGI request accounting; never publish through a Windows-shared file."""
import time


class Activity:
    def __init__(self, clock=time.time):
        self.clock = clock
        self.active = 0
        self.last_activity = clock()

    def snapshot(self):
        return {'active': self.active, 'lastActivity': self.last_activity}


class RequestActivity:
    def __init__(self, app, activity):
        self.app = app
        self.activity = activity

    async def __call__(self, scope, receive, send):
        tracked = scope['type'] == 'http' and scope.get('path') not in (
            '/health', '/v1/stats', '/alpha/runtime')
        if tracked:
            self.activity.active += 1
            self.activity.last_activity = self.activity.clock()
        try:
            await self.app(scope, receive, send)
        finally:
            if tracked:
                self.activity.active -= 1
                self.activity.last_activity = self.activity.clock()
