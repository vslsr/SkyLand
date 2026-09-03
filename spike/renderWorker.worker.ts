/// <reference lib="webworker" />
import * as THREE from 'three';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { ChunkViewHost } from '../src/world/ChunkViewHost';
import { createSceneEnvironment } from '../src/materials/createFillMaterial';
import { createChunkGenerator } from '../src/world/loadChunkGenerator';
import { registerChunkTemplates } from '../src/models/chunkTemplates';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';

/**
 * 尖刀（不入库）：**真实渲染栈**能不能整体跑在 worker 里。
 *
 * 上一次尖刀只证明了「OffscreenCanvas + WebGL2 能在 worker 里清屏」。那和这里问的
 * 不是一件事——真正会咬人的是自定义 shader 材质、chunk 几何、共享线材质、
 * 以及草地那类要渲到纹理的东西。
 */

const REPORT = (stage: string, ok: boolean, detail = ''): void => {
  (self as unknown as Worker).postMessage({ stage, ok, detail });
};

self.addEventListener('message', (event: MessageEvent) => {
  const canvas = event.data.canvas as OffscreenCanvas;
  void run(canvas);
});

async function run(canvas: OffscreenCanvas): Promise<void> {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      antialias: false,
    });
    renderer.setSize(canvas.width, canvas.height, false);
    renderer.setClearColor(0xfdfbf6, 1);
    REPORT('webgl-renderer', true, renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 200);
    camera.position.set(14, 12, 18);
    camera.lookAt(0, 0, 0);

    const environment = createSceneEnvironment('#ffffff', 40, 160);
    REPORT('scene-environment', true);

    // 1) Actor 模型 + 自定义填充材质 + 共享线材质
    const root = new THREE.Group();
    scene.add(root);
    const renderScene = new ThreeRenderScene(root, environment);
    const proxyIds = new RenderProxyTable(renderScene);
    const transforms = new RenderTransformBuffer();
    const crate: ActorRenderDefinition = {
      model: 'line-art-cargo-crate',
      color: '#a07850', accentColor: '#6f5138', length: 1.2, width: 1.2, height: 1,
    };
    for (let i = 0; i < 3; i += 1) {
      const id = proxyIds.acquire();
      renderScene.createMeshProxy(id, { name: `spike-crate-${i}`, render: crate, interactionMarker: true });
      transforms.write(id, i * 2.2 - 2.2, 0.5, 0, i * 0.4);
    }
    const slime: ActorRenderDefinition = {
      model: 'line-art-player-slime',
      radius: 0.6,
      membraneColor: '#bfe8dd', middleColor: '#a8ddd0', coreColor: '#7fc9b8',
      bubbleColor: '#ffffff', inkColor: '#3d5c55', shadowColor: '#cfd8d4',
    };
    const slimeId = proxyIds.acquire();
    renderScene.createPlayerProxy(slimeId, { name: 'spike-slime', render: slime, walkSpeed: 3 });
    transforms.write(slimeId, 0, 0.6, 3.5, 0);
    transforms.publish();
    renderScene.submitTransforms(transforms);
    REPORT('actor-proxies', true, '3 crates + 1 slime');

    // 2) 标记牌的文字贴图（OffscreenCanvas 那条路）
    renderScene.setInteractionMarker(0 as never, '拾取');
    renderScene.setTemperatureMarkersVisible(true);
    REPORT('marker-textures', true);

    // 3) chunk 几何 + 草地（含渲到纹理）
    const generator = await createChunkGenerator();
    REPORT('chunk-generator', true, generator.kind);
    const templates = {
      content: { ground: true, trees: true, grass: true, ocean: false },
      environment,
      palette: {
        ground: '#efe9dc', grass: '#cfe0b8', treeTrunk: '#a89073',
        treeNeedles: '#cfe0c0', rock: '#b9b4ab',
      },
    };
    registerChunkTemplates(generator, { ...templates, content: { ...templates.content, grass: false } });
    const views = new ChunkViewHost({ templates, environment, worldSeed: 1234, seaLevel: 0 });
    scene.add(views.root);
    for (let cz = -1; cz <= 0; cz += 1) {
      for (let cx = -1; cx <= 0; cx += 1) {
        views.mount({
          key: `${cx}:${cz}`,
          chunkX: cx,
          chunkZ: cz,
          data: generator.buildChunk(cx, cz, undefined),
          terrainOverrides: new Int32Array(),
        });
      }
    }
    REPORT('chunk-views', true, '4 chunks');

    // 4) 真正画几帧，包括 beforeRender（草地在这里渲到纹理）
    for (let frame = 0; frame < 3; frame += 1) {
      views.update(1 / 60, frame / 60);
      renderScene.updateVisuals(transforms, 1 / 60, frame / 60);
      views.beforeRender(renderer);
      renderScene.setGuidePathResolution(canvas.width, canvas.height);
      renderScene.faceCameras(camera);
      renderer.render(scene, camera);
    }
    REPORT('rendered-frames', true, `draws=${renderer.info.render.calls}`);
    REPORT('done', true);
  } catch (error) {
    REPORT('failed', false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
  }
}
