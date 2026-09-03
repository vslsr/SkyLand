import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimpleCollisionFromRender } from '../shared/actor/simpleCollision.mjs';
import { createActorVisualModel } from '../src/models/actors/createActorVisualModel';
import { modelBuildsFireVisual } from '../src/render/renderModelFacts';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';

/**
 * 「模型尺寸派生的碰撞盒」其实是一个**输入只有 render 定义的纯函数**
 * （实现路径文档 §3）。
 *
 * `MeshProxyInfo.simpleCollision` 曾经是玩法侧唯一要从渲染世界**同步取回**的
 * 几何量——`createMeshProxy` 因此不能是一条单向命令，而那正是 canvas 进线程的
 * 阻塞点。
 *
 * 但渲染侧算它的方式，就是调玩法侧同样拿得到的那个 shared 纯函数
 * （`ServerActorFactory` 早就直接调它）。所以这条往返可以整个删掉。
 *
 * 这个用例把「可以删掉」这件事钉住：**每一种 render 模型**建出来的模型，
 * 它的 `simpleCollision` 必须和 `createSimpleCollisionFromRender(定义)` 逐字段相等。
 * 哪天有人让某个模型按真实几何去量碰撞盒，这条会先炸——那时要么改回往返，
 * 要么把那个量法搬进这个纯函数里。
 */

const ENVIRONMENT = { fogColor: '#ffffff', fogNear: 20, fogFar: 60 };

/** 每一种 render 模型一个最小定义。少一种就说明 union 加了成员而这里没跟上。 */
const RENDER_DEFINITIONS: ActorRenderDefinition[] = [
  {
    model: 'line-art-player-slime',
    radius: 0.42,
    membraneColor: '#bfe8dd', middleColor: '#a8ddd0', coreColor: '#7fc9b8',
    bubbleColor: '#ffffff', inkColor: '#3d5c55', shadowColor: '#cfd8d4',
  },
  {
    model: 'line-art-pbf-slime',
    radius: 0.46, collisionRadius: 0.34, collisionHeight: 0.68,
    particleCount: 48, constraintIterations: 2, gravity: 9.8, centerForce: 4,
    viscosity: 0.1, bubbleCount: 4, bubbleSpeed: 0.4,
    surfaceColor: '#bfe8dd', innerColor: '#a8ddd0', highlightColor: '#ffffff',
    bubbleColor: '#ffffff', inkColor: '#3d5c55', shadowColor: '#cfd8d4',
  },
  { model: 'line-art-raft', foamColor: '#fffdf7', length: 4.8, width: 3.2 },
  {
    model: 'line-art-cargo-crate',
    color: '#a07850', accentColor: '#6f5138', length: 0.9, width: 0.9, height: 0.72,
  },
  { model: 'line-art-reef', color: '#887b6e', accentColor: '#514c47', radius: 1, height: 1.4 },
  {
    model: 'line-art-elastic-mushroom',
    capColor: '#c97868', stemColor: '#eadfc5', spotColor: '#f8f1df', radius: 0.5, height: 0.95,
  },
  {
    model: 'line-art-training-dummy',
    woodColor: '#a07850', accentColor: '#6f5138', radius: 0.36, height: 1.6,
  },
  {
    model: 'line-art-focus-obelisk',
    stoneColor: '#8c8880', crystalColor: '#9fd8e6', radius: 0.5, height: 2.1,
  },
  {
    model: 'line-art-floor-plaque',
    color: '#cfc6b4', accentColor: '#8c8880', width: 1.2, length: 1.2, height: 0.08,
  },
  {
    model: 'line-art-campfire',
    stoneColor: '#8c8880', woodColor: '#a07850', emberColor: '#e08a4c', radius: 0.55, height: 0.4,
  },
  {
    model: 'line-art-dry-hay',
    color: '#d8c78a', accentColor: '#a89457', radius: 0.6, height: 0.7,
  },
  {
    model: 'line-art-wood-pile',
    woodColor: '#a07850', cutColor: '#d8c199', inkColor: '#5c4630', radius: 0.42, height: 0.36,
  },
  {
    model: 'line-art-wood-log',
    woodColor: '#a07850', cutColor: '#d8c199', inkColor: '#5c4630', radius: 0.18, length: 1.1,
  },
  {
    model: 'line-art-stone-pile',
    stoneColor: '#8c8880', accentColor: '#6f6b64', inkColor: '#43413d', radius: 0.4, height: 0.3,
  },
  {
    model: 'line-art-fruit-pile',
    fruitColor: '#d4694f', accentColor: '#b3543d', inkColor: '#5c2f26', radius: 0.22, height: 0.2,
  },
];

test('每一种 render 模型的碰撞盒都等于那个 shared 纯函数的输出', () => {
  for (const definition of RENDER_DEFINITIONS) {
    const model = createActorVisualModel(ENVIRONMENT, definition);
    assert.deepEqual(
      { ...model.simpleCollision },
      { ...createSimpleCollisionFromRender(definition) },
      `${definition.model} 的碰撞盒不是纯函数算出来的——`
      + '边界上那条同步往返就删不掉了，见这个文件的开头',
    );
  }
});

test('这份定义表覆盖了 render union 的每一种模型', () => {
  // 漏一种，上面那条就会悄悄放过它。
  const covered = new Set(RENDER_DEFINITIONS.map((definition) => definition.model));
  assert.equal(covered.size, RENDER_DEFINITIONS.length, '定义表里有重复的 model');
  assert.equal(
    covered.size,
    15,
    'render union 的成员数变了：新增一种模型就要在这里加一条最小定义',
  );
});

/**
 * 「这个模型会不会长出火焰」原来是 `resolve()` 出活 proxy 再看它有没有 rig。
 * 递出活对象过不了线程边界，所以那件事改成了一张按 `render.model` 查的表。
 *
 * 表会和模型工厂脱节——这条把两边钉在一起：**建出来有没有 rig，必须和表说的一致**。
 * 哪天给某个模型加了火焰而忘了改表，那个 Actor 就不会有 `FireVisualComponent`，
 * 火点着了却不显示；反过来多列一项，会给一个没有 rig 的 Actor 挂上空表现。
 */
test('哪些模型会长出火焰，那张表和模型工厂说的一致', () => {
  for (const definition of RENDER_DEFINITIONS) {
    const model = createActorVisualModel(ENVIRONMENT, definition);
    assert.equal(
      Boolean(model.fireVisualRig),
      modelBuildsFireVisual(definition.model),
      `${definition.model}：renderModelFacts 里那张表和模型工厂对不上`,
    );
  }
});
