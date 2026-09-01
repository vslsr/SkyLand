import { register } from 'node:module';
import { initRapier } from '../shared/physics/RapierRuntime.mjs';

register(new URL('./typescript-loader.mjs', import.meta.url));
await initRapier(() => import('@dimforge/rapier3d-compat'));
