import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRenderCommand,
  RenderCommandQueue,
  type RenderCommand,
} from '../src/render/worker/renderCommands';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { NULL_PROXY_ID, toProxyId, type ProxyId } from '../src/render/RenderScene';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';

/**
 * 渲染命令的往返（实现路径文档 §3）。
 *
 * 前面几步把 `RenderScene` 与 `ChunkViewSink` 上每个方法都改成返回 `void`，
 * 为的就是让一次调用能原样变成一条报文。这一组盯的是那条往返真的**无损**：
 * 玩法侧调了什么，渲染侧就收到什么，顺序也一样。
 *
 * 用假的目标对象接住，因为这里测的是通道本身，不是 Three 会画成什么样。
 */

const CRATE: ActorRenderDefinition = {
  model: 'line-art-cargo-crate',
  color: '#a07850', accentColor: '#6f5138', length: 1, width: 1, height: 0.8,
};

/** 把收到的调用原样记下来。 */
function createRecordingTarget() {
  const calls: string[] = [];
  const transforms = new RenderTransformBuffer(8);
  const scene = {
    createMeshProxy: (id: ProxyId, desc: { name: string }) => calls.push(`createMesh:${id}:${desc.name}`),
    createPlayerProxy: (id: ProxyId, desc: { name: string }) => calls.push(`createPlayer:${id}:${desc.name}`),
    destroyMeshProxy: (id: ProxyId) => calls.push(`destroy:${id}`),
    setGuidePath: (id: ProxyId, _s: unknown, changed: boolean) => calls.push(`guide:${id}:${changed}`),
    setInteractionMarker: (id: ProxyId, label: string) => calls.push(`marker:${id}:${label}`),
    setHoveredProxy: (id: ProxyId) => calls.push(`hover:${id}`),
    setAbilityLabTarget: (id: ProxyId) => calls.push(`labTarget:${id}`),
    setAbilityLabState: (state: { caster: { health: number } } | undefined, x: number, y: number, z: number) => {
      calls.push(`labState:${state ? state.caster.health : 'none'}:${x},${y},${z}`);
    },
    playAbilityLabAction: (action: string, x: number, y: number, z: number, ok: boolean) => {
      calls.push(`labAction:${action}:${x},${y},${z}:${ok}`);
    },
    setTemperatureMarkersVisible: (v: boolean) => calls.push(`temp:${v}`),
    setSimpleCollisionVisible: (v: boolean) => calls.push(`collision:${v}`),
    submitTransforms: (buffer: RenderTransformBuffer) => {
      calls.push(`submit:${buffer === transforms ? 'same-bytes' : 'WRONG'}`);
    },
    updateVisuals: (_b: unknown, dt: number, elapsed: number) => calls.push(`visuals:${dt}:${elapsed}`),
    dispose: () => calls.push('dispose'),
  };
  const chunkViews = {
    mount: (request: { key: string; terrainOverrides: Int32Array }) => {
      calls.push(`mount:${request.key}:${Array.from(request.terrainOverrides).join(',')}`);
    },
    unmount: (key: string) => calls.push(`unmount:${key}`),
    clear: () => calls.push('clear'),
    onGeneratorReady: () => undefined,
  };
  return { calls, transforms, scene, chunkViews };
}

const drain = (queue: RenderCommandQueue, target: ReturnType<typeof createRecordingTarget>): void => {
  const batch = queue.flush();
  for (const command of batch?.commands ?? []) {
    applyRenderCommand(command as RenderCommand, target);
  }
};

test('玩法侧调了什么，渲染侧就收到什么，顺序一模一样', () => {
  const queue = new RenderCommandQueue();
  const target = createRecordingTarget();
  const a = toProxyId(0);
  const b = toProxyId(1);

  queue.createMeshProxy(a, { name: 'crate', render: CRATE });
  queue.setInteractionMarker(a, '拾取');
  queue.createPlayerProxy(b, {
    name: 'slime',
    walkSpeed: 3,
    render: {
      model: 'line-art-player-slime', radius: 0.4,
      membraneColor: '#a', middleColor: '#b', coreColor: '#c',
      bubbleColor: '#d', inkColor: '#e', shadowColor: '#f',
    },
  });
  queue.setHoveredProxy(b);
  queue.submitTransforms(target.transforms);
  queue.updateVisuals(target.transforms, 0.016, 1.25);
  queue.destroyMeshProxy(a);

  drain(queue, target);
  assert.deepEqual(target.calls, [
    'createMesh:0:crate',
    'marker:0:拾取',
    'createPlayer:1:slime',
    'hover:1',
    'submit:same-bytes',
    'visuals:0.016:1.25',
    'destroy:0',
  ]);
});

/**
 * 能力实验室曾经是玩法侧最后一处递出活对象的地方：`getActorRenderProxy` 拿到活的
 * `ThreeMeshProxy`，把 `abilityTargetRig` 交给一个住在主线程的视觉系统。
 *
 * 现在它是三条命令。这里盯的就是「它们过得了这条通道」——`AbilityLabViewState`
 * 是纯数据，施法者位置是三个标量，一条都不需要回话。
 */
test('能力实验室的三条命令过得了通道，视图状态原样到对面', () => {
  const queue = new RenderCommandQueue();
  const target = createRecordingTarget();
  const dummy = toProxyId(3);
  const state = { caster: { health: 72 }, target: { health: 180 }, cooldowns: {}, logs: [] };

  queue.setAbilityLabTarget(dummy);
  queue.setAbilityLabState(state as never, 1, 2, 3);
  queue.playAbilityLabAction('arcane', 1, 2, 3, true);
  queue.playAbilityLabAction('burn', 1, 2, 3, false);
  queue.setAbilityLabState(undefined, 0, 0, 0);
  queue.setAbilityLabTarget(NULL_PROXY_ID);

  drain(queue, target);
  assert.deepEqual(target.calls, [
    'labTarget:3',
    'labState:72:1,2,3',
    'labAction:arcane:1,2,3:true',
    'labAction:burn:1,2,3:false',
    'labState:none:0,0,0',
    `labTarget:${NULL_PROXY_ID}`,
  ]);
});

test('那段字节不跟着命令走——worker 一开始就有同一个 SAB', () => {
  const queue = new RenderCommandQueue();
  const target = createRecordingTarget();
  queue.submitTransforms(target.transforms);
  queue.updateVisuals(target.transforms, 0.016, 2);
  const batch = queue.flush()!;
  // 每帧再把视图塞进报文是白费；命令里只该有时间量。
  const serialized = JSON.stringify(batch.commands);
  assert.doesNotMatch(serialized, /buffer|byteLength/, '命令里不该出现那段字节');
  assert.match(serialized, /"deltaSeconds":0\.016/);
  // 兑现时用的仍然是渲染侧自己那一份。
  for (const command of batch.commands) applyRenderCommand(command, target);
  assert.deepEqual(target.calls, ['submit:same-bytes', 'visuals:0.016:2']);
});

test('chunk 挂载命令带着地形覆盖过去，并登记成转移而不是复制', () => {
  const queue = new RenderCommandQueue();
  const target = createRecordingTarget();
  const overrides = Int32Array.from([3, 4, 7]);
  queue.mount({ key: '0:0', chunkX: 0, chunkZ: 0, terrainOverrides: overrides });
  queue.mount({ key: '1:0', chunkX: 1, chunkZ: 0, terrainOverrides: new Int32Array() });
  queue.unmount('0:0');
  queue.clear();

  const batch = queue.flush()!;
  assert.equal(
    batch.transfer.length,
    1,
    '非空的覆盖数组该按转移交出去；空数组不值得登记',
  );
  assert.equal(batch.transfer[0], overrides.buffer);
  for (const command of batch.commands) applyRenderCommand(command, target);
  assert.deepEqual(target.calls, ['mount:0:0:3,4,7', 'mount:1:0:', 'unmount:0:0', 'clear']);
});

test('按帧成批：取走之后队列是空的，空帧不产生报文', () => {
  const queue = new RenderCommandQueue();
  assert.equal(queue.flush(), undefined, '空帧该省掉这一次 postMessage');
  queue.setSimpleCollisionVisible(true);
  queue.setTemperatureMarkersVisible(false);
  assert.equal(queue.pendingCount, 2);
  assert.equal(queue.flush()?.commands.length, 2);
  assert.equal(queue.pendingCount, 0, '取走之后不该还留着上一帧的命令');
  assert.equal(queue.flush(), undefined);
});

test('生成后端就位是反向通知，不走命令队列', () => {
  const queue = new RenderCommandQueue();
  const seen: string[] = [];
  queue.onGeneratorReady((kind) => seen.push(`early:${kind}`));
  assert.deepEqual(seen, [], '还没就位时不该回调');
  assert.equal(queue.flush(), undefined, '反向通知不该混进命令队列');

  queue.generatorReady('wasm');
  assert.deepEqual(seen, ['early:wasm']);
  // 就位之后再登记的立刻回调：装配顺序不该决定收不收得到。
  queue.onGeneratorReady((kind) => seen.push(`late:${kind}`));
  assert.deepEqual(seen, ['early:wasm', 'late:wasm']);
  // 重复上报只算一次。
  queue.generatorReady('js');
  assert.deepEqual(seen, ['early:wasm', 'late:wasm']);
});
