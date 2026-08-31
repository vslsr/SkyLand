import { AbilityLabSceneComponent } from './AbilityLabSceneComponent';
import { MouseGrassInteractionSceneComponent } from './MouseGrassInteractionSceneComponent';
import type { SceneComponentFactory } from './SceneComponent';

/** 客户端场景组件白名单；新增配置类型时必须在这里注册实现。 */
export const createSceneRuntimeComponent: SceneComponentFactory = (definition, context) => {
  switch (definition.type) {
    case 'mouse-grass-interaction':
      return new MouseGrassInteractionSceneComponent(context);
    case 'ability-lab':
      return new AbilityLabSceneComponent(context);
    default: {
      const unsupported: never = definition;
      throw new Error(`未实现的场景组件：${JSON.stringify(unsupported)}`);
    }
  }
};
