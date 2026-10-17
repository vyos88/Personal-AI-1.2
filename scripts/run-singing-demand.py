"""Pinned CUDA-only Singing API with request activity for its owning worker."""
import json
import os
from pathlib import Path
import sys
import time


def main():
    root = Path(os.environ['ALPHA_SINGING_ROOT']).resolve()
    engine = root / 'ACE-Step-1.5'
    sys.path.insert(0, str(engine))
    os.chdir(engine)
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('Singing requires CUDA; CPU fallback is disabled')
    # Stage weights in RAM between GPU calls; never run the audio decoder on CPU.
    os.environ['ACESTEP_OFFLOAD_DIT_TO_CPU'] = 'true'
    os.environ['ACESTEP_VAE_ON_CPU'] = 'false'
    from diffusers import AutoencoderOobleck
    from singing_cuda_policy import install_cuda_decode_guard
    install_cuda_decode_guard(AutoencoderOobleck)
    from acestep import model_downloader
    model_downloader.MAIN_MODEL_COMPONENTS = [name for name in model_downloader.MAIN_MODEL_COMPONENTS
                                            if not name.startswith('acestep-5Hz-lm-')]
    from acestep.api_server import app
    from fastapi import Depends
    from acestep.api.http.auth import verify_api_key

    @app.get('/alpha/runtime')
    async def runtime(_=Depends(verify_api_key)):
        handler = getattr(app.state, 'handler', None)
        return {'data': {'device': str(getattr(handler, 'device', 'unknown')),
                         'cpu_offload': bool(getattr(handler, 'offload_to_cpu', True)),
                         'dit_offload': bool(getattr(handler, 'offload_dit_to_cpu', False)),
                         'vae_decode_policy': 'cuda-only',
                         'cuda_available': torch.cuda.is_available()}}

    activity = Path(os.environ['ALPHA_SINGING_ACTIVITY'])
    state = {'active': 0, 'lastActivity': time.time()}

    def save():
        temporary = activity.with_suffix('.tmp')
        temporary.write_text(json.dumps(state), encoding='utf-8')
        temporary.replace(activity)

    save()

    class RequestActivity:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            tracked = scope['type'] == 'http' and scope.get('path') not in ('/health', '/v1/stats', '/alpha/runtime')
            if tracked:
                state['active'] += 1
                state['lastActivity'] = time.time()
                save()
            try:
                await self.app(scope, receive, send)
            finally:
                if tracked:
                    state['active'] -= 1
                    state['lastActivity'] = time.time()
                    save()

    app.add_middleware(RequestActivity)

    import uvicorn
    uvicorn.run(app, host=os.environ['ALPHA_SINGING_BIND'], port=8003, log_level='info')


if __name__ == '__main__':
    main()
