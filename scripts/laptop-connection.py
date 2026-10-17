"""Control-only Alpha connection. Never leases compute work or starts CPU agents."""
import ctypes
import json
from pathlib import Path
import sys
import time
import urllib.request

sys.path.insert(0, 'C:/Users/jack/AppData/Local/AlphaWindowsWorker')
from alpha_agent_controller import AgentController

CONFIG = Path('C:/services/alpha-tunnel/gpu-runtime/control-credential.json')

def main():
    kernel = ctypes.windll.kernel32
    kernel.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel.CreateMutexW(None, False, 'Global\\AlphaLaptopControlOnly')
    if not handle or kernel.GetLastError() == 183:
        return
    credential = json.loads(CONFIG.read_text(encoding='utf-8-sig'))
    headers = {'Content-Type': 'application/json', 'X-Alpha-Device-Id': credential['device_id'],
               'X-Alpha-Worker-Token': credential['worker_token']}
    def call(path, body):
        request = urllib.request.Request('https://alpha-serv-01.tail879ea7.ts.net' + path,
                                         json.dumps(body).encode(), headers, method='POST')
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.load(response)
    controller = AgentController('C:/Users/jack/AppData/Local/Alpha')
    registered = False
    while True:
        try:
            metadata = {'execution_boundary': 'control-only-no-compute-leases',
                        'cpu_jobs_enabled': False, 'gpu_jobs': 'on-demand-tunnel',
                        'free_ram_kb': 0, 'usable_cpu_threads': 0}
            if not registered:
                call('/devices/network/worker/register', {'device_id': credential['device_id'],
                     'board_type': 'windows_compute', 'capabilities': ['agent-control'], 'metadata': metadata})
                registered = True
            heartbeat = call('/devices/network/heartbeat', {'device_id': credential['device_id'],
                 'cpu_pct': 0, 'free_ram_kb': 0, 'status': 'online', 'telemetry': metadata})
            if heartbeat.get('ok') is not True:
                raise RuntimeError('Heartbeat not acknowledged')
            command = call('/devices/network/agent-control/poll', {'agents': controller.inventory()}).get('command')
            if command:
                if command.get('action') == 'start':
                    result = {'state': 'failed', 'detail': 'CPU agents run on the server; laptop starts are disabled.'}
                elif command.get('action') == 'status':
                    result = controller.observe(command.get('agent'))
                    result.pop('agent_id', None)
                else:
                    result = controller.execute(command)
                call('/devices/network/agent-control/receipt', {'command_id': command['id'], 'result': result})
                print(json.dumps({'event': 'control-receipt', 'command_id': command['id'], 'result': result}), flush=True)
            print(json.dumps({'event': 'connected', 'capabilities': ['agent-control'], 'cpu_jobs_enabled': False}), flush=True)
        except Exception as error:
            registered = False
            print(json.dumps({'event': 'reconnect', 'error_type': type(error).__name__}), flush=True)
        time.sleep(30)

if __name__ == '__main__':
    main()



