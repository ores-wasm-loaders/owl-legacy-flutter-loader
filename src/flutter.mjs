// The shared Flutter-web adapter.
//
// Flutter already publishes a supported loading lifecycle — `_flutter.loader.load()`, an
// entrypoint-loaded callback, `initializeEngine()`, then `runApp()` — and it already decides
// between the WasmGC build and the JS fallback at runtime. This adapter's job is to wrap
// that lifecycle uniformly across the fleet, not to re-implement it byte by byte.
//
// Two rules it exists to enforce:
//
//   1. `flutter_bootstrap.js` is never executed to "warm the loader". Running it STARTS the
//      application. Preparation here is fetch-only, always.
//   2. Multi-view means several views of ONE running application. It is not a way to host
//      independently compiled Flutter apps in a shared engine, and this adapter will not
//      pretend otherwise: a second app gets a second engine.

const WASM = 'application/wasm';

/**
 * Which startup variant this runtime will actually use.
 *
 * Flutter's own loader makes the real choice; we mirror it only to decide what is worth
 * PREPARING, because fetching both the WasmGC module and the full JS fallback would double
 * the bytes on every marketing page for no benefit.
 */
export function startupVariant({ wasm } = {}) {
  const gc = Boolean(wasm) && typeof wasm.Function === 'function';
  return gc ? 'module' : 'fallback';
}

export function createFlutterAdapter({
  interfaces,
  global: globalObject,
  loadScript,
  supportsWasmGc,
} = {}) {
  const engines = new Map(); // appId@releaseId -> { engine, appRunner, views: Map }

  const flutterGlobal = () => globalObject?._flutter;

  return {
    framework: 'flutter',
    // Flutter releases prepare fetch-only: the supported bootstrap owns compilation, so a
    // module we compiled separately has nowhere to go.
    supports: ['fetch'],

    plan(manifest) {
      // `supportsWasmGc` answers a yes/no question; `startupVariant` names the variant.
      // Keeping the two straight matters: getting it backwards silently prepares the JS
      // fallback for a WasmGC runtime, which is the opposite of the intended saving.
      const variant = supportsWasmGc ? (supportsWasmGc() ? 'module' : 'fallback') : startupVariant({ wasm: globalObject?.WebAssembly });
      const drop = variant === 'module' ? 'fallback' : 'module';
      return interfaces
        .preparableAssets(manifest)
        .filter((item) => item.role !== drop);
    },

    async prepareAsset(caps, item, url) {
      // Deliberately no compileStreaming branch: see `supports` above.
      const response = await caps.fetch(url, { signal: caps.signal, credentials: 'omit', mode: 'cors' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const body = await response.arrayBuffer();
      if (item.contentType === WASM && body.byteLength >= 4) {
        const magic = new Uint8Array(body.slice(0, 4));
        if (!(magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d)) {
          throw new Error(`${url}: served as application/wasm but does not start with the Wasm magic — check the hosting content type`);
        }
      }
      return { kind: 'bytes', bytes: body.byteLength };
    },

    async activate(caps, manifest, options = {}) {
      const key = `${manifest.appId}@${manifest.releaseId}`;
      const host = options.host ?? (manifest.activation.hostSelector ? caps.document.querySelector(manifest.activation.hostSelector) : null);
      if (!host) throw new Error(`${manifest.appId}: no host element (looked for ${manifest.activation.hostSelector ?? 'options.host'})`);

      if (manifest.requiresCrossOriginIsolation && caps.document.defaultView && caps.document.defaultView.crossOriginIsolated === false) {
        caps.log?.(`[owl-flutter] ${manifest.appId} declares the threaded renderer but this document is not cross-origin isolated — Flutter will fall back`);
      }

      const running = engines.get(key);
      if (running && manifest.activation.mode === 'attach-view') {
        // The persistent-shell path: one engine, one heap, another view.
        const viewId = await running.appRunner.addView({ hostElement: host });
        running.views.set(host, viewId);
        caps.log?.(`[owl-flutter] ${manifest.appId} attached view ${viewId} to the running engine`);
        return { framework: 'flutter', key, mode: 'attach-view', viewId, host, engineReused: true };
      }

      const bootstrap = manifest.entrypoints.find((e) => e.role === 'bootstrap');
      if (!bootstrap) throw new Error(`${manifest.appId}: no entrypoint with role \`bootstrap\``);

      // Executing the bootstrap is exactly what activation is for — and nothing before it.
      if (!flutterGlobal()) await loadScript(`${manifest.baseUrl}${bootstrap.path}`);
      const loader = flutterGlobal()?.loader;
      if (!loader?.load) throw new Error(`${manifest.appId}: _flutter.loader is unavailable after loading ${bootstrap.path}`);

      let engineInitializer = null;
      await loader.load({
        config: { canvasKitBaseUrl: `${manifest.baseUrl}canvaskit/`, ...(options.config ?? {}) },
        onEntrypointLoaded: async (initializer) => {
          engineInitializer = initializer;
        },
      });
      if (!engineInitializer) throw new Error(`${manifest.appId}: Flutter never reported an entrypoint`);

      const engine = await engineInitializer.initializeEngine({
        multiViewEnabled: manifest.activation.mode === 'attach-view',
        ...(manifest.activation.mode === 'attach-view' ? {} : { hostElement: host }),
      });
      const appRunner = await engine.runApp();

      const record = { engine, appRunner, views: new Map() };
      engines.set(key, record);

      if (manifest.activation.mode === 'attach-view') {
        const viewId = await appRunner.addView({ hostElement: host });
        record.views.set(host, viewId);
        return { framework: 'flutter', key, mode: 'attach-view', viewId, host, engineReused: false };
      }
      return { framework: 'flutter', key, mode: 'run-app', host, engineReused: false };
    },

    /** Remove a view. The engine stays alive for the shell's next view. */
    async deactivate(instance) {
      const record = engines.get(instance.key);
      if (!record) return;
      if (instance.mode === 'attach-view' && record.appRunner.removeView) {
        await record.appRunner.removeView(instance.viewId);
        record.views.delete(instance.host);
      }
      if (record.views.size === 0 && instance.mode !== 'attach-view') engines.delete(instance.key);
    },

    /** Diagnostics for a shell: how many engines this document is keeping alive. */
    get engineCount() {
      return engines.size;
    },
  };
}
