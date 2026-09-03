import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MouseGrassInteractor } from '../src/grass/MouseGrassInteractor';
import { createRenderCamera } from '../src/render/RenderCameraBuffer';
import type { GrassBendImpulse } from '../src/grass/GrassInteraction';

/**
 * 鼠标拖草的反投影（实现路径文档 §3）。
 *
 * 它原来用 `THREE.Raycaster.setFromCamera(ndc, camera)`——那要一个活的相机对象，
 * 而相机住在渲染世界里，于是这个**输入**适配器每帧都要从渲染侧回调一次。
 * 现在自己按机位、朝向、视场角、宽高比构造射线。
 *
 * 这一组就是拿被替换掉的那个东西当参照：**同样的输入，落点必须和 Three 一致**。
 * 差出去就是玩家拖草时手感偏了，而那种偏差不会有任何测试自己报出来。
 */

/** 用一个假的 DOM 元素喂指针事件——这里测的是数学，不是浏览器。 */
function createHarness(width: number, height: number) {
  const listeners = new Map<string, (event: unknown) => void>();
  const element = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLElement;
  const impulses: GrassBendImpulse[] = [];
  const interactor = new MouseGrassInteractor(element, {
    applyImpulse: (impulse) => impulses.push(impulse),
  });
  const movePointer = (clientX: number, clientY: number): void => {
    listeners.get('pointermove')?.({ clientX, clientY });
  };
  return { interactor, impulses, movePointer };
}

/** 被替换掉的那条路：Three 的反投影 + 地面求交。 */
function threeGroundHit(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
): THREE.Vector3 | null {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const point = new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point);
}

const FOV_DEGREES = 50;
const WIDTH = 1280;
const HEIGHT = 720;

test('反投影落点和 THREE.Raycaster 一致——换掉的是实现，不是行为', () => {
  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, WIDTH / HEIGHT, 0.1, 200);
  // 几个不同的机位与俯仰，包括偏航过的：只对着 -Z 看的话叉乘那一步错了也发现不了。
  const poses: { position: [number, number, number]; target: [number, number, number] }[] = [
    { position: [0, 12, 18], target: [0, 0, 0] },
    { position: [-9, 6, 4], target: [2, 0, -3] },
    { position: [5, 20, -5], target: [0, 0, 0] },
  ];
  const view = {
    fovRadians: (FOV_DEGREES * Math.PI) / 180,
    aspect: WIDTH / HEIGHT,
  };

  for (const pose of poses) {
    camera.position.set(...pose.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld(true);

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const frame = createRenderCamera();
    frame.position = [...pose.position];
    frame.forward = [forward.x, forward.y, forward.z];
    frame.up = [camera.up.x, camera.up.y, camera.up.z];

    for (const [px, py] of [[640, 360], [200, 500], [1100, 620], [900, 400]] as const) {
      const ndcX = (px / WIDTH) * 2 - 1;
      const ndcY = -(py / HEIGHT) * 2 + 1;
      const expected = threeGroundHit(camera, ndcX, ndcY);
      if (!expected) continue;

      // 走真实入口：两次移动才会产生冲量，第二次的落点就是要比的那个。
      const harness = createHarness(WIDTH, HEIGHT);
      harness.movePointer(px, py);
      harness.interactor.update(frame, view);
      harness.movePointer(px + 60, py + 40);
      harness.interactor.update(frame, view);

      const impulse = harness.impulses.at(-1);
      assert.ok(impulse, `${pose.position} @ ${px},${py} 应当产生冲量`);
      const previousX = impulse.position.x - impulse.direction.x;
      const previousZ = impulse.position.z - impulse.direction.z;
      assert.ok(
        Math.abs(previousX - expected.x) < 1e-4 && Math.abs(previousZ - expected.z) < 1e-4,
        `落点和 Three 对不上：自己算 (${previousX}, ${previousZ})，`
        + `Three (${expected.x}, ${expected.z})`,
      );
    }
  }
});

test('射线打不到地面时不产生冲量，也不留下上一次的落点', () => {
  const view = { fovRadians: (FOV_DEGREES * Math.PI) / 180, aspect: WIDTH / HEIGHT };
  const harness = createHarness(WIDTH, HEIGHT);
  // 仰头看天：射线永远不与 y = 0 相交。
  const skyward = createRenderCamera();
  skyward.position = [0, 5, 0];
  skyward.forward = [0, 1, 0];
  harness.movePointer(640, 360);
  harness.interactor.update(skyward, view);
  harness.movePointer(700, 400);
  harness.interactor.update(skyward, view);
  assert.deepEqual(harness.impulses, []);
});

test('退化的相机朝向不会算出 NaN', () => {
  const view = { fovRadians: (FOV_DEGREES * Math.PI) / 180, aspect: WIDTH / HEIGHT };
  const harness = createHarness(WIDTH, HEIGHT);
  const degenerate = createRenderCamera();
  degenerate.position = [0, 4, 0];
  // forward 与 up 平行：叉乘出零向量，构不出相机基。
  degenerate.forward = [0, 1, 0];
  degenerate.up = [0, 1, 0];
  harness.movePointer(640, 360);
  harness.interactor.update(degenerate, view);
  harness.movePointer(700, 400);
  harness.interactor.update(degenerate, view);
  assert.deepEqual(harness.impulses, [], '构不出相机基时该安静地什么都不做');
});
