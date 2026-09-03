import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import type { RenderCommandSink } from '../src/render/RenderScene';

/**
 * 槽位表的复用节奏（`RenderProxyTable` 的类注释）。
 *
 * 渲染线程每拍等主线程翻面之后自己兑现 transform，销毁命令却要等报文到了才生效。
 * 释放的槽位若在同一帧交给新 Actor，旧模型会在新位置上闪一帧——所以要隔到
 * 下一帧翻面之后。这里用一个手拨的帧号模拟 transform SoA 的 `publish()`。
 */

function sink(): RenderCommandSink & { destroyed: number[] } {
  const destroyed: number[] = [];
  return {
    destroyed,
    destroyMeshProxy: (id) => { destroyed.push(id); },
    setGuidePath: () => {},
  };
}

test('没有帧号来源时释放即复用——单线程下没有另一条线程在读', () => {
  const table = new RenderProxyTable(sink());
  const first = table.acquire();
  table.destroyMeshProxy(first);
  assert.equal(table.acquire(), first);
});

test('释放的槽位隔到下一帧翻面之后才复用，同一帧里分配拿到的是新槽位', () => {
  const frames = { frameId: 5 };
  const commands = sink();
  const table = new RenderProxyTable(commands, frames);
  const first = table.acquire();
  const second = table.acquire();
  assert.equal(table.liveCount, 2);

  table.destroyMeshProxy(first);
  assert.deepEqual(commands.destroyed, [first], '销毁命令照发');
  assert.equal(table.liveCount, 1, '隔离中的槽位已经销毁，不算活的');
  // 同一帧：渲染线程画这一帧时旧 proxy 还在，不能把它的槽位交给别人。
  const third = table.acquire();
  assert.notEqual(third, first);
  assert.equal(third, 2, '拿到的是一个新槽位');

  // 主线程翻面（frameId 涨一）之后，销毁命令已经先于任何新位置到了渲染线程。
  frames.frameId = 6;
  assert.equal(table.acquire(), first, '现在可以复用了');
  assert.equal(table.liveCount, 3);
  assert.ok(second >= 0);
});

test('隔离期间多个释放的槽位按帧号各自放行', () => {
  const frames = { frameId: 1 };
  const table = new RenderProxyTable(sink(), frames);
  const a = table.acquire();
  const b = table.acquire();
  table.destroyMeshProxy(a);
  frames.frameId = 2;
  table.destroyMeshProxy(b);
  // a 是上一帧释放的，可以复用；b 是这一帧的，还不行。
  assert.equal(table.acquire(), a);
  const fresh = table.acquire();
  assert.notEqual(fresh, b);
  frames.frameId = 3;
  assert.equal(table.acquire(), b);
});

test('换场景 reset 把隔离中的槽位一起清掉，编号从头开始', () => {
  const frames = { frameId: 9 };
  const table = new RenderProxyTable(sink(), frames);
  table.destroyMeshProxy(table.acquire());
  table.reset();
  assert.equal(table.liveCount, 0);
  assert.equal(table.acquire(), 0);
});
