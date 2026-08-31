import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createBuoyancyRaftModel } from '../ocean/createBuoyancyRaftModel';
import type { ActorVisualModel } from './ActorVisualModel';
import { createCargoCrateModel } from './createCargoCrateModel';
import { createReefModel } from './createReefModel';
import { createElasticMushroomModel } from './createElasticMushroomModel';
import { createFloorPlaqueModel } from './createFloorPlaqueModel';
import { createFocusObeliskModel } from './createFocusObeliskModel';
import { createTrainingDummyModel } from './createTrainingDummyModel';
import { createPlayerSlimeModel } from '../playerSlime';
import { createCampfireModel } from './createCampfireModel';
import { createDryHayModel } from './createDryHayModel';
import { createWoodPileModel } from './createWoodPileModel';

export function createActorVisualModel(
  environment: FillMaterialEnvironment,
  definition: ActorRenderDefinition,
): ActorVisualModel {
  if (definition.model === 'line-art-player-slime') {
    return createPlayerSlimeModel(definition);
  }
  if (definition.model === 'line-art-raft') {
    return createBuoyancyRaftModel(environment, definition);
  }
  if (definition.model === 'line-art-cargo-crate') {
    return createCargoCrateModel(environment, definition);
  }
  if (definition.model === 'line-art-elastic-mushroom') {
    return createElasticMushroomModel(environment, definition);
  }
  if (definition.model === 'line-art-training-dummy') {
    return createTrainingDummyModel(environment, definition);
  }
  if (definition.model === 'line-art-focus-obelisk') {
    return createFocusObeliskModel(environment, definition);
  }
  if (definition.model === 'line-art-floor-plaque') {
    return createFloorPlaqueModel(environment, definition);
  }
  if (definition.model === 'line-art-campfire') {
    return createCampfireModel(environment, definition);
  }
  if (definition.model === 'line-art-dry-hay') {
    return createDryHayModel(environment, definition);
  }
  if (definition.model === 'line-art-wood-pile') {
    return createWoodPileModel(environment, definition);
  }
  return createReefModel(environment, definition);
}
