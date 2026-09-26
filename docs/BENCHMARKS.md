# Benchmark results

Captured 2026-09-26 on the machine described below. Reproduce with `pnpm bench`.

```
AgentOS benchmarks
node v24.16.0 · darwin/arm64
model: deterministic scripted provider · store/queue: in-process

agent startup latency — enqueue to first model call
  cold start (queue → first model call) p50           0.105 ms
  cold start (queue → first model call) p95           0.195 ms
  cold start (queue → first model call) p99           0.753 ms

execution throughput — single worker, varying concurrency
  throughput @ concurrency 1                        13783.3 executions/s
  throughput @ concurrency 4                        16722.7 executions/s
  throughput @ concurrency 16                       21632.2 executions/s

tool execution overhead — runtime cost around a trivial tool
  full execution with 1 tool call p50                 0.125 ms
  full execution with 1 tool call p95                 0.145 ms
  full execution with 1 tool call p99                   0.2 ms

policy evaluation — the gate every tool call passes through
  policy decisions                                  1095998 decisions/s
  policy decision latency                              0.91 µs

event pipeline — emit (with redaction) and rebuild a trace
  event emit (redacted + persisted)                  151563 events/s
  event emit latency                                    6.6 µs
  trace rebuild (5k events)                            1.23 ms

concurrent executions — several workers against one queue
  4 workers × 8 concurrency                         16319.6 executions/s
  executions completed                                  600 count

memory footprint — retained bytes per completed execution
  retained per execution (state + events)              11.5 KB
  note: run with --expose-gc for a stable figure; this one includes uncollected garbage

--- machine-readable ---
{
  "node": "v24.16.0",
  "platform": "darwin/arm64",
```
