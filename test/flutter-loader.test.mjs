import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePackage } from './resolve.mjs';

const { createCoordinator } = await import(resolvePackage('owl-coordinator', 'ores-wasm-loaders'));
import { createFlutterAdapter, startupVariant } from '../index.mjs';
import { interfaces, manifests, testEnv, fakeDocument } from './helpers.mjs';

const validate = (m) => interfaces.checkManifest(m, interfaces.manifestSchema);

/** A stand-in for Flutter's own loader, with the lifecycle it actually publishes. */
function fakeFlutter() {
  const calls = { load: 0, initializeEngine: [], runApp: 0, addView: [], removeView: [] };
  let nextViewId = 1;
  const appRunner = {
    async addView({ hostElement }) {
      const id = nextViewId++;
      calls.addView.push({ hostElement, id });
      return id;
    },
    async removeView(id) {
      calls.removeView.push(id);
    },
  };
  return {
    calls,
    global: {
      _flutter: {
        loader: {
          async load({ onEntrypointLoaded, config }) {
            calls.load += 1;
            calls.config = config;
            await onEntrypointLoaded({
              async initializeEngine(options) {
                calls.initializeEngine.push(options);
                return {
                  async runApp() {
                    calls.runApp += 1;
                    return appRunner;
                  },
                };
              },
            });
          },
        },
      },
    },
  };
}

function setup({ wasmGc = true, flutter = fakeFlutter(), document = fakeDocument() } = {}) {
  const scripts = [];
  const adapter = createFlutterAdapter({
    interfaces,
    global: flutter.global,
    supportsWasmGc: () => wasmGc,
    loadScript: async (src) => {
      scripts.push(src);
    },
  });
  const env = testEnv({ document });
  const coordinator = createCoordinator({ env, validate, adapters: [adapter] });
  coordinator.register(manifests.flutter);
  return { adapter, coordinator, env, flutter, scripts, document };
}

test('preparation fetches only the variant this runtime will use', async () => {
  const gc = setup({ wasmGc: true });
  const gcReceipt = await gc.coordinator.prepare('owl-fixture-flutter');
  assert.ok(gcReceipt.prepared.includes('main.dart.wasm'));
  assert.ok(!gcReceipt.prepared.includes('main.dart.js'), 'the JS fallback must not be fetched too');

  const fallback = setup({ wasmGc: false });
  const fallbackReceipt = await fallback.coordinator.prepare('owl-fixture-flutter');
  assert.ok(fallbackReceipt.prepared.includes('main.dart.js'));
  assert.ok(!fallbackReceipt.prepared.includes('main.dart.wasm'));
});

test('preparation never executes the bootstrap', async () => {
  const { coordinator, scripts, flutter } = setup();
  await coordinator.prepare('owl-fixture-flutter');
  assert.deepEqual(scripts, [], 'no script may be inserted during preparation');
  assert.equal(flutter.calls.load, 0);
  assert.equal(flutter.calls.runApp, 0);
});

test('activation runs the supported lifecycle exactly once and attaches a view', async () => {
  const { coordinator, flutter, adapter } = setup();
  const host = { id: 'app-view' };
  const instance = await coordinator.activate('owl-fixture-flutter', { host });

  assert.equal(flutter.calls.load, 1);
  assert.equal(flutter.calls.runApp, 1);
  assert.deepEqual(flutter.calls.initializeEngine, [{ multiViewEnabled: true }]);
  assert.equal(instance.viewId, 1);
  assert.equal(instance.engineReused, false);
  assert.equal(adapter.engineCount, 1);
  assert.match(flutter.calls.config.canvasKitBaseUrl, /canvaskit\/$/);
});

test('a second view joins the running engine instead of starting another', async () => {
  const { coordinator, adapter, flutter } = setup();
  const first = await coordinator.activate('owl-fixture-flutter', { host: { id: 'a' } });
  // A different host in the same document: the shell revealing a second panel.
  const second = await adapter.activate(
    { document: fakeDocument(), prepared: new Map(), log: () => {} },
    coordinator.registry.get('owl-fixture-flutter'),
    { host: { id: 'b' } },
  );

  assert.equal(flutter.calls.runApp, 1, 'one engine, one heap');
  assert.equal(second.engineReused, true);
  assert.notEqual(second.viewId, first.viewId);
  assert.equal(adapter.engineCount, 1);

  await adapter.deactivate(second);
  assert.deepEqual(flutter.calls.removeView, [second.viewId]);
});

test('a wasm file served with the wrong bytes is caught during preparation', async () => {
  const { coordinator, env } = setup();
  const realFetch = env.fetch;
  env.fetch = async (url, init) => {
    const response = await realFetch(url, init);
    if (url.endsWith('.wasm')) {
      return { ...response, arrayBuffer: async () => new TextEncoder().encode('<!doctype html>not wasm').buffer };
    }
    return response;
  };
  const receipt = await coordinator.prepare('owl-fixture-flutter');
  const failure = receipt.skipped.find((s) => s.path === 'main.dart.wasm');
  assert.ok(failure, 'the bogus module should have been skipped');
  assert.equal(failure.reason, 'failed');
});

test('activation without a host says so instead of starting an invisible engine', async () => {
  const { coordinator } = setup({ document: { ...fakeDocument(), querySelector: () => null } });
  await assert.rejects(() => coordinator.activate('owl-fixture-flutter'), /no host element/);
});

test('the startup variant follows the runtime, not a build flag', () => {
  assert.equal(startupVariant({ wasm: { Function: function () {} } }), 'module');
  assert.equal(startupVariant({ wasm: {} }), 'fallback');
  assert.equal(startupVariant({}), 'fallback');
});
