"""Structural cost per call: a trivial function of the project, called N times."""
import json
import sys
import time


def trivial(value):
    return value


def main(calls):
    trivial(0)
    start = time.perf_counter_ns()
    for index in range(calls):
        trivial(index)
    elapsed = time.perf_counter_ns() - start
    print(json.dumps({'calls': calls, 'ns': elapsed, 'nsPerCall': elapsed / calls}))


main(int(sys.argv[1]) if len(sys.argv) > 1 else 1_000_000)
