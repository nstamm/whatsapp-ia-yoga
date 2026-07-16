import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const MAX_SAMPLES = 200;
const MAX_METRICS = 100;
const EVENT_LOOP_RESOLUTION_MS = 20;
const samples = new Map();
const eventLoop = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
eventLoop.enable();

export function observeMetric(name, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  let metricName = name;
  if (!samples.has(metricName) && samples.size >= MAX_METRICS) {
    metricName = "other";
    if (!samples.has(metricName)) samples.delete(samples.keys().next().value);
  }
  const values = samples.get(metricName) ?? [];
  values.push(durationMs);
  if (values.length > MAX_SAMPLES) values.shift();
  samples.set(metricName, values);
}

export function measureSync(name, operation) {
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    observeMetric(name, performance.now() - startedAt);
  }
}

export async function measureAsync(name, operation) {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    observeMetric(name, performance.now() - startedAt);
  }
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export function performanceSnapshot() {
  const metrics = {};
  for (const [name, values] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    metrics[name] = {
      samples: values.length,
      averageMs: Number((total / values.length).toFixed(2)),
      p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
      p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
      maxMs: Number(sorted.at(-1).toFixed(2)),
    };
  }

  const memory = process.memoryUsage();
  const eventLoopLagMs = (value) => Math.max(0, Number(value) / 1e6 - EVENT_LOOP_RESOLUTION_MS);
  return {
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, Number((value / 1024 / 1024).toFixed(1))])),
    eventLoop: {
      meanMs: Number((eventLoopLagMs(eventLoop.mean) || 0).toFixed(2)),
      p95Ms: Number((eventLoopLagMs(eventLoop.percentile(95)) || 0).toFixed(2)),
      maxMs: Number((eventLoopLagMs(eventLoop.max) || 0).toFixed(2)),
    },
    metrics,
  };
}

export function resetPerformanceMetrics() {
  samples.clear();
  eventLoop.reset();
}
