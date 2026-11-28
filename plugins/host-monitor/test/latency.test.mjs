import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

// Load the client code without starting a React Native app or contacting a host.
function setup() {
  let data;
  let ping = async () => ({});
  let now = 0;
  let timer;
  let timeoutMs;
  const modules = {
    "@getpaseo/plugin/client": { useRpc: () => (...args) => ping(...args) },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon" },
    "@tanstack/react-query": {
      useQuery: (options) => options,
      useQueryClient: () => ({ getQueryData: () => data }),
    },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "../shared/stats": {},
    "./sidebar": {},
  };
  function load(file) {
    const module = { exports: {} };
    const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    });
    vm.runInNewContext(outputText, {
      exports: module.exports,
      require: (name) => modules[name] ?? require(name),
      performance: { now: () => now },
      Date,
      Error,
      setTimeout: (callback, ms) => { timer = callback; timeoutMs = ms; return 1; },
      clearTimeout: () => { timer = undefined; },
    }, { filename: file });
    return module.exports;
  }
  modules["./stats"] = load("../client/stats.tsx");
  const latency = load("../client/latency.tsx");
  return {
    ...latency,
    ...modules["./stats"],
    setPing: (fn) => { ping = fn; },
    setNow: (value) => { now = value; },
    expire: () => { assert.equal(timeoutMs, 5000); timer(); },
    hasTimer: () => timer !== undefined,
    measure: async () => (data = await latency.useLatency().queryFn()),
  };
}

test("severity thresholds, formatting and failed sparkline samples", () => {
  const app = setup();
  for (const [ms, severity] of [[0, "normal"], [149, "normal"], [150, "warning"], [399, "warning"], [400, "critical"]]) {
    assert.equal(app.latencySeverity(ms), severity);
  }
  assert.equal(app.formatLatency(25.4), "25 ms");
  assert.equal(app.formatLatency(1250), "1.3 s");
  const bars = app.Sparkline({ values: [50, null, 0], color: "red", height: 40 }).props.children;
  assert.deepEqual(bars.map((bar) => bar.props.style.height), [20, 0, 1]);
});

test("monotonic timing, 30-result history, failures and last success", async () => {
  const app = setup();
  const options = app.useLatency();
  assert.equal(options.refetchInterval, 2000);
  assert.equal(options.staleTime, Infinity);
  assert.equal(options.networkMode, "always");
  assert.equal(options.retry, false);
  app.setPing(async () => { app.setNow(125); return {}; });
  let data = await app.measure();
  assert.equal(data.ms, 125);
  assert.equal(data.error, null);
  assert.equal(app.hasTimer(), false);
  const lastOkAt = data.lastOkAt;
  assert.equal(typeof lastOkAt, "number");
  app.setPing(async () => { throw new Error("Host unavailable"); });
  data = await app.measure();
  assert.equal(data.ms, null);
  assert.equal(data.error, "Host unavailable");
  assert.equal(data.lastOkAt, lastOkAt);
  assert.equal(data.sent, 2);
  assert.equal(data.lost, 1);
  assert.equal(data.history[1], null);
  for (let i = 0; i < 30; i++) data = await app.measure();
  assert.equal(data.history.length, 30);
  assert.equal(data.sent, 32);
  assert.equal(data.lost, 31);
  assert.ok(data.history.every((value) => value === null));
});

test("a hung RPC times out as disconnected and a later result recovers", async () => {
  const app = setup();
  app.setPing(() => new Promise(() => {}));
  const pending = app.measure();
  app.expire();
  let data = await pending;
  assert.equal(data.ms, null);
  assert.match(data.error, /No response within 5 seconds/);
  assert.equal(data.lost, 1);
  assert.equal(data.lastOkAt, null);
  assert.equal(app.hasTimer(), false);
  app.setPing(async () => { app.setNow(20); return {}; });
  data = await app.measure();
  assert.equal(data.ms, 20);
  assert.equal(data.error, null);
  assert.equal(data.sent, 2);
  assert.equal(data.lost, 1);
  assert.equal(data.history[0], null);
  assert.equal(data.history[1], 20);
});

test("polling waits for completion, then two seconds; opening details does not refetch", async () => {
  // QueryObserver schedules browser timers; no browser or DOM is needed for this check.
  globalThis.window = {};
  const { QueryClient, QueryObserver } = await import("@tanstack/query-core");
  delete globalThis.window;
  const app = setup();
  let calls = 0;
  let finish;
  app.setPing(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const client = new QueryClient();
  const observer = new QueryObserver(client, app.useLatency());
  const stop = observer.subscribe(() => {});
  let stopDetails = () => {};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    assert.equal(calls, 1);
    await sleep(2100);
    assert.equal(calls, 1, "an in-flight request must not start another ping");
    finish({});
    await new Promise(setImmediate);
    const details = new QueryObserver(client, app.useLatency());
    stopDetails = details.subscribe(() => {});
    assert.equal(calls, 1, "opening details must reuse the current result");
    await sleep(1800);
    assert.equal(calls, 1, "the interval starts after completion");
    await sleep(300);
    assert.equal(calls, 2);
    finish({});
    await new Promise(setImmediate);
  } finally {
    stopDetails();
    stop();
    client.clear();
  }
});
