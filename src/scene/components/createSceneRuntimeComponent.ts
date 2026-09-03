import { AbilityLabSceneComponent } from './AbilityLabSceneComponent';
import { MouseGrassInteractionSceneComponent } from './MouseGrassInteractionSceneComponent';
import type { SceneComponentFactory } from './SceneComponent';

/**
 * 主线程这一侧的场景组件白名单。
 *
 * **有一类不在这里**：纯表现的组件由 `createRenderWorld` 建，跟着 canvas 走
 * （引擎迁移路线图 第 3 步）。落叶就是这一类——它要的只是几个数和一块地形，
 * 没有一样是主线程独有的。工厂对它们返回 `undefined`，宿主跳过。
 *
 * 新增配置类型时必须在这里或 `createRenderWorld` 里注册实现，二选一。
 */
export const createSceneRuntimeComponent: SceneComponentFactory = (definition, context) => {
  switch (definition.type) {
    case 'mouse-grass-interaction':
      return new MouseGrassInteractionSceneComponent(context);
    case 'ability-lab':
      return new AbilityLabSceneComponent(definition, context);
    case 'interactive-particle-effect':
      // 归渲染世界，见 createRenderWorld。
      return undefined;
    default: {
      const unsupported: never = definition;
      throw new Error(`未实现的场景组件：${JSON.stringify(unsupported)}`);
    }
  }
};
