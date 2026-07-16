import test from "node:test";
import assert from "node:assert/strict";
import { measureAsync, measureSync, observeMetric, performanceSnapshot, resetPerformanceMetrics } from "../src/performanceMetrics.js";

test("performance metrics summarize bounded timing samples", async () => {
  resetPerformanceMetrics();
  for (let index = 0; index < 250; index += 1) observeMetric("sqlite.test", index);
  assert.equal(measureSync("sync.test", () => 42), 42);
  assert.equal(await measureAsync("async.test", async () => "ok"), "ok");

  const snapshot = performanceSnapshot();
  assert.equal(snapshot.metrics["sqlite.test"].samples, 200);
  assert.equal(snapshot.metrics["sqlite.test"].maxMs, 249);
  assert.equal(snapshot.metrics["sync.test"].samples, 1);
  assert.equal(snapshot.metrics["async.test"].samples, 1);
  assert.equal(typeof snapshot.memoryMb.rss, "number");
});

test("performance metric names are globally bounded", () => {
  resetPerformanceMetrics();
  for (let index = 0; index < 250; index += 1) observeMetric(`http.GET./unknown-${index}`, index);
  const metrics = performanceSnapshot().metrics;
  assert.equal(Object.keys(metrics).length, 100);
  assert.equal(metrics.other.samples > 0, true);
});
