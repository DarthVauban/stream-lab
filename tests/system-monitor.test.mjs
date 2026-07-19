import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCpuUsage,
  parseNetworkCounters,
  SystemMonitor,
} from "../media-server/system-monitor.mjs";

test("calculates CPU usage and ignores the loopback network interface", () => {
  assert.equal(
    calculateCpuUsage({ idle: 900, total: 1_000 }, { idle: 1_000, total: 1_200 }),
    50,
  );
  assert.deepEqual(
    parseNetworkCounters(`
      lo: 500 0 0 0 0 0 0 0 600 0 0 0 0 0 0 0
    eth0: 1200 0 0 0 0 0 0 0 3400 0 0 0 0 0 0 0
    `),
    { receivedBytes: 1_200, transmittedBytes: 3_400 },
  );
});

test("captures CPU, memory, disk, network and hardware metrics", async () => {
  const cpuSamples = [
    [{ model: "Test CPU", speed: 3_200, times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } }],
    [{ model: "Test CPU", speed: 3_200, times: { user: 200, nice: 0, sys: 0, idle: 1_000, irq: 0 } }],
  ];
  const networkSamples = [
    { receivedBytes: 1_000, transmittedBytes: 2_000 },
    { receivedBytes: 3_000, transmittedBytes: 3_000 },
  ];
  const clock = [0, 2_000];
  const monitor = new SystemMonitor({
    storage: {
      snapshot: async () => ({
        totalBytes: 10_000,
        usedBytes: 7_000,
        freeBytes: 3_000,
        percentUsed: 70,
        level: "OK",
        warningPercent: 80,
        criticalPercent: 90,
        updatedAt: new Date(2_000).toISOString(),
      }),
    },
    osImpl: {
      cpus: () => cpuSamples.shift(),
      totalmem: () => 1_000,
      freemem: () => 250,
      loadavg: () => [0.5, 0.25, 0.1],
      hostname: () => "streamlab-test",
      platform: () => "linux",
      release: () => "test-release",
      arch: () => "x64",
      uptime: () => 3_600,
    },
    processImpl: {
      memoryUsage: () => ({ rss: 100, heapUsed: 50 }),
      availableMemory: () => 500,
      version: "v-test",
    },
    now: () => clock.shift(),
    networkProvider: async () => networkSamples.shift(),
    temperatureProvider: async () => 55.5,
  });

  await monitor.init();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.cpu.usagePercent, 50);
  assert.equal(snapshot.cpu.temperatureCelsius, 55.5);
  assert.equal(snapshot.memory.usagePercent, 75);
  assert.equal(snapshot.disk.percentUsed, 70);
  assert.equal(snapshot.network.receivedBytesPerSecond, 1_000);
  assert.equal(snapshot.network.transmittedBytesPerSecond, 500);
  assert.equal(snapshot.system.hostname, "streamlab-test");
  assert.equal(snapshot.history.length, 1);
});
