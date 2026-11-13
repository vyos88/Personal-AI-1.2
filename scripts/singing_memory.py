"""Windows commit admission: physical free RAM alone misses page-file exhaustion."""
import ctypes
import json
import os


def memory_snapshot():
    if os.name != 'nt':
        raise RuntimeError('Windows memory admission is unavailable')
    class Status(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong) for name in (
                'total_physical', 'available_physical', 'commit_limit', 'available_commit',
                'total_virtual', 'available_virtual', 'available_extended_virtual')]
    status = Status()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError()
    return {name + '_mib': round(getattr(status, name) / 1048576) for name in (
        'total_physical', 'available_physical', 'commit_limit', 'available_commit')}


def admission_reason(snapshot, *, loaded=False):
    physical = snapshot.get('available_physical_mib')
    commit = snapshot.get('available_commit_mib')
    if not isinstance(physical, (int, float)) or not isinstance(commit, (int, float)):
        return 'Memory admission is unknown; generation deferred'
    # Startup has a 1 GiB allowance above the 2 GiB machine reserve.
    # Once loaded, that allowance has already been consumed by the model.
    physical_minimum = 2048 if loaded else 3072
    if physical < physical_minimum:
        return f'Need at least {physical_minimum // 1024} GiB physical RAM free for Singing'
    minimum = 8192 if loaded else 16384
    if commit < minimum:
        return f'Need at least {minimum // 1024} GiB commit headroom for Singing'
    return None


if __name__ == '__main__':
    snapshot = memory_snapshot()
    print(json.dumps({'memory': snapshot, 'reason': admission_reason(snapshot)}))
