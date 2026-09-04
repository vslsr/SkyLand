import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createSceneEnvironment } from '../src/materials/createFillMaterial';
import { MAX_ENVIRONMENT_POINT_LIGHTS } from '../src/shaders/environmentLighting';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { resolvePointLightDesc } from '../src/render/RenderPointLights';
import { PARAM_POINT_LIGHT_INTENSITY } from '../src/render/RenderVisualParams';
import type { PointLightDesc } from '../src/render/RenderPointLights';
import type { ProxyId } from '../src/render/RenderScene';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';

/**
 * 篝火点亮周围的那条通路（参考项目 `index.html` 的 FILL 点光源）。
 *
 * 用例打的是**整条通路**而不是内部函数：玩法侧写一个标量进参数段，渲染世界
 * 把它兑现成全场共享的环境 uniform。中间那几步（平滑、闪烁、白昼衰减、挑最近的
 * 几盏）都是渲染侧自己的动画状态，从外面看只有 uniform 变了没变。
 */

const CAMPFIRE: ActorRenderDefinition = {
  model: 'line-art-campfire',
  stoneColor: '#c8c0b2',
  woodColor: '#79513a',
  emberColor: '#c95d32',
  radius: 0.65,
  height: 0.45,
};

const LIGHT: PointLightDesc = resolvePointLightDesc({
  color: '#ffb469',
  edgeColor: '#c2551c',
  radius: 7.5,
  intensity: 1,
  heightOffset: 0.42,
  // 闪烁会让强度在 [1 - flicker, 1] 之间摆；用例要断言具体数值，所以关掉它，
  // 闪烁本身由下面单独一条覆盖。
  flicker: 0,
  enabled: true,
});

function createScene() {
  const environment = createSceneEnvironment('#fdfbf6', 22, 52);
  const scene = new ThreeRenderScene(new THREE.Group(), environment);
  const proxyIds = new RenderProxyTable(scene);
  const transforms = new RenderTransformBuffer(8);
  return { environment, scene, proxyIds, transforms };
}

/** 建一堆篝火 proxy，摆在世界坐标上。 */
function lightUp(
  scene: ThreeRenderScene,
  proxyIds: RenderProxyTable,
  transforms: RenderTransformBuffer,
  x: number,
  z: number,
  light: PointLightDesc = LIGHT,
): ProxyId {
  const id = proxyIds.acquire();
  scene.createMeshProxy(id, { name: `campfire-${id}`, render: CAMPFIRE, pointLight: light });
  transforms.write(id, x, 0, z, 0);
  transforms.writeParam(id, PARAM_POINT_LIGHT_INTENSITY, 1);
  return id;
}

/** 跑一帧渲染世界：翻面、兑现 transform、驱动表现。 */
function step(
  scene: ThreeRenderScene,
  transforms: RenderTransformBuffer,
  deltaSeconds = 1 / 60,
  elapsedSeconds = 0,
): void {
  transforms.publish();
  scene.submitTransforms(transforms);
  scene.updateVisuals(transforms, deltaSeconds, elapsedSeconds);
}

/** 强度平滑要跑几帧才吸附到目标；用例不关心过程，只要终值。 */
function settle(
  scene: ThreeRenderScene,
  transforms: RenderTransformBuffer,
  elapsedSeconds = 0,
): void {
  for (let frame = 0; frame < 120; frame += 1) step(scene, transforms, 1 / 60, elapsedSeconds);
}

test('点着的篝火写进全场共享的点光源 uniform', () => {
  const { environment, scene, proxyIds, transforms } = createScene();
  const runtime = environment.runtime!;
  lightUp(scene, proxyIds, transforms, 3, -2);
  settle(scene, transforms);

  const position = runtime.pointLightPositions.value[0];
  assert.equal(position.x, 3);
  assert.equal(position.z, -2);
  // 光心抬到柴堆之上，而不是压在地面上。
  assert.ok(Math.abs(position.y - LIGHT.heightOffset) < 1e-6, '光心应当按 heightOffset 抬高');
  const falloff = runtime.pointLightFalloff.value[0];
  assert.equal(falloff.x, LIGHT.radius);
  // 强度 = 目标 1 × intensity 1 × 白昼衰减（默认 daylight = 1，压到四分之一）。
  assert.ok(Math.abs(falloff.y - 0.25) < 1e-6, `白昼下应当压到 0.25，实际 ${falloff.y}`);
  assert.deepEqual(
    runtime.pointLightColors.value[0].getHexString(),
    new THREE.Color(LIGHT.color).getHexString(),
  );
  assert.deepEqual(
    runtime.pointLightEdgeColors.value[0].getHexString(),
    new THREE.Color(LIGHT.edgeColor).getHexString(),
  );
});

test('入夜火更亮：白昼衰减取的是天气系统这一帧写的 daylight', () => {
  const { environment, scene, proxyIds, transforms } = createScene();
  const runtime = environment.runtime!;
  lightUp(scene, proxyIds, transforms, 0, 0);
  settle(scene, transforms);
  const noon = runtime.pointLightFalloff.value[0].y;

  runtime.daylight.value = 0;
  step(scene, transforms);
  const night = runtime.pointLightFalloff.value[0].y;

  assert.ok(night > noon, '夜里的篝火应当比正午亮');
  assert.ok(Math.abs(night - 1) < 1e-6, `夜里应当是满强度，实际 ${night}`);
});

test('熄掉的火强度收到 0，空槽位每帧写满', () => {
  const { environment, scene, proxyIds, transforms } = createScene();
  const runtime = environment.runtime!;
  const id = lightUp(scene, proxyIds, transforms, 0, 0);
  settle(scene, transforms);
  assert.ok(runtime.pointLightFalloff.value[0].y > 0);

  transforms.writeParam(id, PARAM_POINT_LIGHT_INTENSITY, 0);
  settle(scene, transforms);

  for (let slot = 0; slot < MAX_ENVIRONMENT_POINT_LIGHTS; slot += 1) {
    const falloff = runtime.pointLightFalloff.value[slot];
    assert.equal(falloff.y, 0, `第 ${slot} 格应当是空的`);
    // 半径不能是 0：着色器里那个除法会算出 NaN，再被 clamp 传染成一片黑。
    assert.ok(falloff.x > 0, `第 ${slot} 格的半径不能是 0`);
  }
});

test('着色器的循环次数与世界里的火堆数无关：只挑离视点最近的几盏', () => {
  const { environment, scene, proxyIds, transforms } = createScene();
  const runtime = environment.runtime!;
  // 一片营地：远近各放一批，数量超过 uniform 的格数。
  const distances = [40, 2, 25, 1, 30, 3, 50, 4];
  for (const distance of distances) lightUp(scene, proxyIds, transforms, distance, 0);
  // 视点在原点：`beforeRender` 是渲染循环递相机进来的那一步。
  scene.beforeRender(
    { domElement: { width: 800, height: 600 } } as THREE.WebGLRenderer,
    new THREE.PerspectiveCamera(),
  );
  settle(scene, transforms);

  const lit = runtime.pointLightFalloff.value
    .map((falloff, slot) => ({ slot, strength: falloff.y }))
    .filter((entry) => entry.strength > 0);
  assert.equal(lit.length, MAX_ENVIRONMENT_POINT_LIGHTS, '同时参与照明的盏数必须有上限');
  const chosen = runtime.pointLightPositions.value
    .slice(0, MAX_ENVIRONMENT_POINT_LIGHTS)
    .map((position) => position.x)
    .sort((left, right) => left - right);
  assert.deepEqual(chosen, [1, 2, 3, 4], '入选的应当是离视点最近的那几盏');
});

test('销毁 proxy 会丢掉它的光，复用槽位的新 Actor 不继承亮度', () => {
  const { environment, scene, proxyIds, transforms } = createScene();
  const runtime = environment.runtime!;
  const id = lightUp(scene, proxyIds, transforms, 0, 0);
  settle(scene, transforms);
  assert.ok(runtime.pointLightFalloff.value[0].y > 0);

  proxyIds.destroyMeshProxy(id);
  // 同一个槽位换成一个不发光的 Actor：它的参数段仍然写着上一个的 1。
  const reused = proxyIds.acquire();
  assert.equal(reused, id, '这条用例要的就是槽位复用');
  scene.createMeshProxy(reused, { name: 'crate', render: CAMPFIRE });
  transforms.write(reused, 0, 0, 0, 0);
  step(scene, transforms);

  assert.equal(runtime.pointLightFalloff.value[0].y, 0, '新 Actor 不该继承上一个的光');
});

test('闪烁把强度压在 [1 - flicker, 1] 之间摆动', () => {
  const { environment, scene, proxyIds, transforms } = createScene();
  const runtime = environment.runtime!;
  runtime.daylight.value = 0;
  const flickering = resolvePointLightDesc({
    color: '#ffb469',
    radius: 7.5,
    intensity: 1,
    flicker: 0.3,
    enabled: true,
  });
  lightUp(scene, proxyIds, transforms, 0, 0, flickering);
  settle(scene, transforms);

  let lowest = Number.POSITIVE_INFINITY;
  let highest = 0;
  for (let frame = 0; frame < 240; frame += 1) {
    step(scene, transforms, 1 / 60, frame / 60);
    const strength = runtime.pointLightFalloff.value[0].y;
    lowest = Math.min(lowest, strength);
    highest = Math.max(highest, strength);
  }
  assert.ok(lowest >= 0.7 - 1e-6, `不能暗过 1 - flicker，实际 ${lowest}`);
  assert.ok(highest <= 1 + 1e-6, `不能亮过满强度，实际 ${highest}`);
  assert.ok(highest - lowest > 0.05, '闪烁应当真的在动');
});

test('边缘色不写就跟随主色', () => {
  const desc = resolvePointLightDesc({
    color: '#ffb469',
    radius: 6,
    intensity: 1,
    enabled: true,
  });
  assert.equal(desc.edgeColor, '#ffb469');
  assert.equal(desc.heightOffset, 0);
  assert.equal(desc.flicker, 0);
});
