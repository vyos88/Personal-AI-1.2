"""Owner GPU policy for the installed Singing engine's automatic CPU fallback."""
from functools import wraps


def install_cuda_decode_guard(vae_class, log=print):
    original = vae_class.decode
    if getattr(original, '__alpha_cuda_only__', False):
        return

    @wraps(original)
    def cuda_decode(self, *args, **kwargs):
        latent = args[0] if args else kwargs.get('z')
        if latent is None:
            latent = kwargs.get('latents')
        parameter = next(iter(self.parameters()), None)
        model_device = getattr(parameter, 'device', None)
        latent_device = getattr(latent, 'device', None)
        if (getattr(model_device, 'type', None) != 'cuda'
                or getattr(latent_device, 'type', None) != 'cuda'):
            raise RuntimeError('CPU VAE decode refused by laptop owner GPU policy; '
                               'CPU work belongs on Alpha-serv-01')
        log('[alpha-cuda-policy] VAE decode on CUDA; model=' + str(model_device)
            + ' latents=' + str(latent_device), flush=True)
        return original(self, *args, **kwargs)

    cuda_decode.__alpha_cuda_only__ = True
    vae_class.decode = cuda_decode
