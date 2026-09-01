let installedRuntime;
let initialization;

function unwrapRuntime(module) {
  return module?.default ?? module;
}

function assertRuntime(runtime) {
  if (!runtime?.World || !runtime?.RigidBodyDesc || !runtime?.ColliderDesc) {
    throw new TypeError('Rapier runtime is missing World, RigidBodyDesc, or ColliderDesc.');
  }
  return runtime;
}

/**
 * Initialize exactly one Rapier WASM runtime for the current JS realm.
 *
 * Browser and Node entry points deliberately provide different package loaders,
 * while all simulation code below this boundary consumes the same installed API.
 */
export async function initRapier(loadRuntime) {
  if (installedRuntime) return installedRuntime;
  if (typeof loadRuntime !== 'function') {
    throw new TypeError('initRapier requires a package loader.');
  }
  if (!initialization) {
    initialization = (async () => {
      const runtime = assertRuntime(unwrapRuntime(await loadRuntime()));
      if (typeof runtime.init === 'function') await runtime.init();
      installedRuntime = runtime;
      return runtime;
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

/** Test/embedded-host hook for an already initialized compatible runtime. */
export function installRapierRuntime(runtime) {
  installedRuntime = assertRuntime(unwrapRuntime(runtime));
  initialization = Promise.resolve(installedRuntime);
  return installedRuntime;
}

export function getRapier() {
  if (!installedRuntime) {
    throw new Error('Rapier has not been initialized. Initialize it in the application entry point first.');
  }
  return installedRuntime;
}

// Transitional aliases for callers created before the Phase 1 API was finalized.
export const initializeRapierRuntime = initRapier;
export const requireRapierRuntime = getRapier;
