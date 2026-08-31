import assert from 'node:assert/strict';
import test from 'node:test';
import type { SceneComponentDefinition } from '../src/scenes/data/SceneDefinition';
import { SceneComponentHost } from '../src/scene/components/SceneComponentHost';
import type {
  SceneComponentContext,
  SceneComponentFactory,
} from '../src/scene/components/SceneComponent';

function createLoggingFactory(events: string[]): SceneComponentFactory {
  return (definition: SceneComponentDefinition) => {
    events.push(`create:${definition.type}`);
    return {
      type: definition.type,
      activate: () => events.push(`activate:${definition.type}`),
      deactivate: () => events.push(`deactivate:${definition.type}`),
      update: () => events.push(`update:${definition.type}`),
      dispose: () => events.push(`dispose:${definition.type}`),
    };
  };
}

const context = {} as SceneComponentContext;

test('场景组件按配置顺序初始化和更新，并在换图时反向释放', () => {
  const events: string[] = [];
  const host = new SceneComponentHost(createLoggingFactory(events));
  host.setActive(true);
  host.load([
    { type: 'mouse-grass-interaction' },
    { type: 'ability-lab', targetActorId: 'training-dummy-01' },
  ], context);
  host.update(1 / 60, 1);
  host.load([], context);

  assert.deepEqual(events, [
    'create:mouse-grass-interaction',
    'create:ability-lab',
    'activate:mouse-grass-interaction',
    'activate:ability-lab',
    'update:mouse-grass-interaction',
    'update:ability-lab',
    'deactivate:ability-lab',
    'deactivate:mouse-grass-interaction',
    'dispose:ability-lab',
    'dispose:mouse-grass-interaction',
  ]);
});

test('场景暂停与恢复只切换组件活跃态，不重建实例', () => {
  const events: string[] = [];
  const host = new SceneComponentHost(createLoggingFactory(events));
  host.load([{ type: 'mouse-grass-interaction' }], context);
  host.setActive(true);
  host.setActive(false);
  host.setActive(true);

  assert.deepEqual(events, [
    'create:mouse-grass-interaction',
    'activate:mouse-grass-interaction',
    'deactivate:mouse-grass-interaction',
    'activate:mouse-grass-interaction',
  ]);
  host.dispose();
});
