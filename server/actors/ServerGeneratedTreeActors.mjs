import { PROP_BUFFER_LENGTH, PROP_FIELD, PROP_STRIDE, generateChunkProps } from '../../shared/world/chunkContent.mjs';
import { formatGeneratedTreeId } from '../../shared/world/generatedTree.mjs';
import {
  MAXIMUM_CHUNK_COORDINATE,
  MINIMUM_CHUNK_COORDINATE,
  PROP_KIND,
  toWorldSeed,
} from '../../shared/world/worldConfig.mjs';
import { createServerActor } from './ServerActorFactory.mjs';

/**
 * 在房间启动时构造全部确定性树 Actor。它们没有网格、碰撞和复制标记，且没有
 * System 查询会逐 tick 遍历它们；代价只是 Actor 身份与几个轻量 Component。
 */
export function createServerGeneratedTreeActors(world, archetype, worldSeed) {
  if (!archetype?.components.generatedTree) return 0;
  const seed = toWorldSeed(worldSeed);
  const props = new Int32Array(PROP_BUFFER_LENGTH);
  let created = 0;
  for (let chunkZ = MINIMUM_CHUNK_COORDINATE; chunkZ <= MAXIMUM_CHUNK_COORDINATE; chunkZ += 1) {
    for (let chunkX = MINIMUM_CHUNK_COORDINATE; chunkX <= MAXIMUM_CHUNK_COORDINATE; chunkX += 1) {
      const propCount = generateChunkProps(seed, chunkX, chunkZ, props);
      for (let propIndex = 0; propIndex < propCount; propIndex += 1) {
        const offset = propIndex * PROP_STRIDE;
        if (props[offset + PROP_FIELD.KIND] !== PROP_KIND.TREE) continue;
        const scale = props[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000;
        world.addActor(createServerActor({
          id: formatGeneratedTreeId(chunkX, chunkZ, propIndex),
          archetypeId: archetype.id,
          localTransform: {
            position: [
              props[offset + PROP_FIELD.X_MM] / 1000,
              0,
              props[offset + PROP_FIELD.Z_MM] / 1000,
            ],
            yaw: props[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
          },
        }, archetype, {
          replicated: false,
          generatedTree: { chunkX, chunkZ, propIndex, scale },
        }));
        created += 1;
      }
    }
  }
  return created;
}
