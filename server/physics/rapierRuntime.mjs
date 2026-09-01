import { initRapier } from '../../shared/physics/RapierRuntime.mjs';

export function initServerRapier() {
  return initRapier(() => import('@dimforge/rapier3d-compat'));
}

