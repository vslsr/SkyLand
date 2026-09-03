import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderCamera, RenderCameraBuffer } from '../src/render/RenderCameraBuffer';
import { RenderInstanceBuffer } from '../src/render/RenderInstanceBuffer';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { toProxyId } from '../src/render/RenderScene';
import {
  applyRenderCommand,
  RenderCommandQueue,
  type RenderCommand,
} from '../src/render/worker/renderCommands';

/**
 * 渲染循环进 worker 之后，两侧之间只剩三样东西（实现路径文档 §3）：
 * 一段共享字节、一批命令、两条反向通知。这一组盯的是**每一样都真的过得去**。
 *
 * 用例里没有 worker：结构化克隆与 SAB 共享都能在同一条线程上如实模拟——
 * 复制一份当作「克隆过去」，同一个 buffer 当作「共享」。真正要验的是语义，
 * 不是 `postMessage` 本身。
 */

const PROP_INT = 5;
const PROP_FLOAT = 6;

test('相机那段字节接管之后读到的就是写的那一帧', () => {
  const writer = new RenderCameraBuffer();
  // 渲染线程拿到的是同一块内存，不是一份副本。
  const reader = RenderCameraBuffer.fromBytes(writer.bytes);
  assert.equal(reader.frameId, writer.frameId);

  const out = createRenderCamera();
  writer.write([1, 2, 3], [0, 0, -1], [0, 1, 0]);
  const beforePublish = reader.read(out);
  assert.notDeepEqual([...beforePublish.position], [1, 2, 3], '没翻面之前读的还是上一帧');

  writer.publish();
  const frame = reader.read(out);
  assert.deepEqual([...frame.position], [1, 2, 3]);
  assert.deepEqual([...frame.forward], [0, 0, -1]);
});

test('长度不对的字节当场认出来，而不是读出一堆垃圾', () => {
  assert.throws(
    () => RenderCameraBuffer.fromBytes(new ArrayBuffer(8)),
    /不像 RenderCameraBuffer/,
  );
});

/**
 * transform SoA 扩容会**重新分配**。跨线程时对面还拿着旧的那一块，不补一条通知，
 * 它会一直读一段没人再写的内存——画面停在扩容那一刻，而且不报错。
 */
test('SoA 扩容时回报新的那一块字节，接管之后读得到搬过去的内容', () => {
  const buffer = new RenderTransformBuffer(2);
  const grown: ArrayBufferLike[] = [];
  buffer.onGrow((bytes) => grown.push(bytes));

  const slot = toProxyId(0);
  buffer.write(slot, 7, 8, 9, 0.5);
  buffer.publish();
  const before = buffer.bytes;

  buffer.ensureSlot(5);
  assert.equal(grown.length, 1, '扩容要回报一次');
  assert.notEqual(grown[0], before, '回报的必须是新分配的那一块');

  const reader = RenderTransformBuffer.fromBytes(grown[0]);
  const moved = reader.readTransform(slot, { x: 0, y: 0, z: 0, yaw: 0 });
  assert.equal(moved.x, 7, '搬完再通知：对面接到手里的已经是搬好内容的那一块');
  assert.equal(moved.z, 9);
  assert.ok(reader.capacity >= 6);
});

test('实例记录按 count 截断复制过去，对面读回来一模一样', () => {
  const source = new RenderInstanceBuffer(PROP_INT, PROP_FLOAT, 4);
  source.beginFrame();
  source.push([1, 0, 0, 1, 42], [3, 0, -4, 0.5, 2, 0]);
  source.push([2, 1, 1, 0, 43], [8, 1, 9, 1.5, 7, 0.3]);

  const queue = new RenderCommandQueue();
  const target = new RenderInstanceBuffer(PROP_INT, PROP_FLOAT, 1);
  const fruit = new RenderInstanceBuffer(2, 3, 1);
  const emptyFruit = new RenderInstanceBuffer(2, 3, 1);
  emptyFruit.beginFrame();
  let submitted = 0;
  queue.submitInstances(source, emptyFruit);

  const batch = queue.flush()!;
  // 那几段记录是**跟着报文走**的（和 transform SoA 不一样），所以要登记成转移。
  assert.ok(batch.transfer.length >= 2, '定长记录按转移交出去，不是复制两次');
  for (const command of batch.commands) {
    applyRenderCommand(command as RenderCommand, {
      scene: { submitInstances: () => { submitted += 1; } } as never,
      transforms: new RenderTransformBuffer(1),
      propInstances: target,
      fruitInstances: fruit,
    });
  }

  assert.equal(submitted, 1);
  assert.equal(target.count, 2, '容量 1 的那一侧要先扩容再收');
  assert.equal(target.readInt(1, 4), 43);
  assert.equal(target.readFloat(0, 2), -4);
  assert.ok(Math.abs(target.readFloat(1, 3) - 1.5) < 1e-6);
});

/**
 * 整图级命令（换地图、天气、时刻、视口、线框……）也要过得去。
 *
 * 这条按「玩法侧调了什么，渲染侧就收到什么」检查，和 proxy 那批命令同一个套路：
 * 少接一条的后果是**静默的**——画面就是不动，不会报错。chunk 生成后端那条反向
 * 通知漏接过一次，代价正是流式地图整片空白。
 */
test('整图级命令一条不落地送到渲染世界那一端', () => {
  const queue = new RenderCommandQueue();
  const calls: string[] = [];
  const runtime = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a) ?? 'undefined').join(',')})`);
    },
  }) as never;

  queue.loadRenderScene({ renderer: { world: {} } } as never, 1234);
  queue.setViewport(800, 600, 2);
  queue.setWeather('rain' as never);
  queue.setTimeOfDay(0.25, true);
  queue.setSceneActive(true);
  queue.setTerrainCells([{ cellX: 1, cellZ: 2, code: 3 }]);
  queue.setTerrainHighlight({ cellX: 4, cellZ: 5 });
  queue.setPhysicsDebug(undefined);
  queue.setFrameContext({ focusX: 1, focusY: 2, focusZ: 3 });
  queue.clearRenderScene();

  const batch = queue.flush()!;
  for (const command of batch.commands) {
    applyRenderCommand(command as RenderCommand, {
      scene: {} as never,
      transforms: new RenderTransformBuffer(1),
      propInstances: new RenderInstanceBuffer(1, 1, 1),
      fruitInstances: new RenderInstanceBuffer(1, 1, 1),
      runtime,
    });
  }

  assert.deepEqual(calls, [
    'loadRenderScene({"renderer":{"world":{}}},1234)',
    'setViewport(800,600,2)',
    'setWeather("rain")',
    'setTimeOfDay(0.25,true)',
    'setSceneActive(true)',
    'setTerrainCells([{"cellX":1,"cellZ":2,"code":3}])',
    'setTerrainHighlight({"cellX":4,"cellZ":5})',
    'setPhysicsDebug(undefined)',
    'setFrameContext({"focusX":1,"focusY":2,"focusZ":3})',
    'clearRenderScene()',
  ]);
});

test('SoA 扩容那条命令带着新字节过去，收的一侧换掉手里那一块', () => {
  const queue = new RenderCommandQueue();
  const grown = new RenderTransformBuffer(8);
  queue.adoptTransforms(grown.bytes);

  let adopted: ArrayBufferLike | undefined;
  for (const command of queue.flush()!.commands) {
    applyRenderCommand(command as RenderCommand, {
      scene: {} as never,
      transforms: new RenderTransformBuffer(1),
      propInstances: new RenderInstanceBuffer(1, 1, 1),
      fruitInstances: new RenderInstanceBuffer(1, 1, 1),
      adoptTransforms: (bytes) => { adopted = bytes; },
    });
  }
  assert.equal(adopted, grown.bytes);
});

/**
 * 两条反向通知都不走命令队列：监听器留在发起方那一端，由收到 worker 报文的那一方
 * 转手调用。混进队列就会晚一帧，而拖拽那条晚一帧意味着手势归属判错。
 */
test('两条反向通知都不进命令队列', () => {
  const queue = new RenderCommandQueue();
  const seen: string[] = [];
  queue.onGeneratorReady((kind) => seen.push(`generator:${kind}`));
  queue.setSlimeSurfaceDragListener(
    (report) => seen.push(`drag:${report.id}:${report.dragging}:${report.pullX}`),
  );

  queue.generatorReady('wasm');
  queue.slimeSurfaceDragChanged({
    id: toProxyId(2), dragging: true,
    contactX: 0, contactY: 0, contactZ: 0, pullX: 1.5, pullY: 0, pullZ: 0,
  });

  // 手势本身（六个本地坐标）也走这条回报——上报房间读的是它缓存下来的那一份。
  assert.deepEqual(seen, ['generator:wasm', 'drag:2:true:1.5']);
  assert.equal(queue.flush(), undefined, '反向通知一条命令都不该产生');
});

/**
 * 合批内容每帧整个重铺，但绝大多数帧什么都没变。没变的帧不发：不复制、不克隆、
 * 不转移——主线程 `draw` 那一段里每帧固定的那几十微秒就是它。变了、换了地图，照发。
 */
test('实例记录逐字节没变的帧不再发，变了或换了地图才发', () => {
  const props = new RenderInstanceBuffer(PROP_INT, PROP_FLOAT, 4);
  const fruit = new RenderInstanceBuffer(2, 3, 4);
  const fill = (x: number) => {
    props.beginFrame();
    props.push([1, 0, 0, 1, 42], [x, 0, -4, 0.5, 2, 0]);
    fruit.beginFrame();
    fruit.push([1, 2], [0.1, 0.2, 0.3]);
  };
  const queue = new RenderCommandQueue();
  const sent = (): number => (queue.flush()?.commands ?? [])
    .filter((command) => command.kind === 'submitInstances').length;

  fill(3);
  queue.submitInstances(props, fruit);
  assert.equal(sent(), 1, '第一帧要发');
  fill(3);
  queue.submitInstances(props, fruit);
  assert.equal(sent(), 0, '内容一样的帧不发');
  fill(3.5);
  queue.submitInstances(props, fruit);
  assert.equal(sent(), 1, '一个数变了就发');
  fill(3.5);
  queue.submitInstances(props, fruit);
  assert.equal(sent(), 0);
  // 记录数变了也算变。
  props.beginFrame();
  queue.submitInstances(props, fruit);
  assert.equal(sent(), 1, '少了一条记录要发');
  // 换地图之后渲染世界是新的，没见过任何记录：照发。
  fill(3.5);
  queue.submitInstances(props, fruit);
  queue.flush();
  queue.clearRenderScene();
  fill(3.5);
  queue.submitInstances(props, fruit);
  assert.equal(sent(), 1, '换了地图要重发');
});
