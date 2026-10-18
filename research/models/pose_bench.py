"""Q3 cost: time ONNX pose/detector models with onnxruntime, CUDA and CPU (4 threads), batch 1.

python -I pose_bench.py model.onnx [...]
"""
import sys
import time

import numpy as np
import onnxruntime as ort

try:
    ort.preload_dlls()  # CUDA/cuDNN from the nvidia pip packages
except Exception as e:  # noqa: BLE001
    print('preload_dlls failed:', e)


def bench(path, providers, n=100):
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    s = ort.InferenceSession(path, so, providers=providers)
    inp = s.get_inputs()[0]
    shape = [d if isinstance(d, int) else 1 for d in inp.shape]
    x = np.random.rand(*shape).astype(np.float32)
    for _ in range(10):
        s.run(None, {inp.name: x})
    t = time.perf_counter()
    for _ in range(n):
        s.run(None, {inp.name: x})
    return (time.perf_counter() - t) / n * 1000, shape, s.get_providers()[0]


for p in sys.argv[1:]:
    name = p.split('/')[-1][:60]
    for prov in (['CUDAExecutionProvider'], ['CPUExecutionProvider']):
        try:
            ms, shape, used = bench(p, prov, 100 if 'CUDA' in prov[0] else 20)
            print(f'{name:60s} {str(shape):22s} {used:24s} {ms:7.2f} ms')
        except Exception as e:  # noqa: BLE001
            print(f'{name:60s} {prov[0]} failed: {str(e)[:120]}')
