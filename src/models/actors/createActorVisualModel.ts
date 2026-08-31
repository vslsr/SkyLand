import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createBuoyancyRaftModel } from '../ocean/createBuoyancyRaftModel';
import type { ActorVisualModel } from './ActorVisualModel';
import { createCargoCrateModel } from './createCargoCrateModel';
import { createReefModel } from './createReefModel';

export function createActorVisualModel(
  environment: FillMaterialEnvironment,
  definition: ActorRenderDefinition,
): ActorVisualModel {
  if (definition.model === 'line-art-raft') {
    return createBuoyancyRaftModel(environment, definition);
  }
  if (definition.model === 'line-art-cargo-crate') {
    return createCargoCrateModel(environment, definition);
  }
  return createReefModel(environment, definition);
}
