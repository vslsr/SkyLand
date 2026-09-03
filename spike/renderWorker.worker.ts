/// <reference lib="webworker" />
import * as THREE from 'three';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import {
  applyRenderCommand,
  type RenderCommandBatch,
} from '../src/render/worker/renderCommands';
import { ChunkViewHost } from '../src/world/ChunkViewHost';
import { createSceneEnvironment } from '../src/materials/createFillMaterial';
import { createChunkGenerator } from '../src/world/loadChunkGenerator';
import { registerChunkTemplates } from '../src/models/chunkTemplates';

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

let apply: ((batch: RenderCommandBatch) => void) | undefined;

self.addEventListener('message', (event: MessageEvent) => {
  if (event.data.canvas) {
    void run(event.data.canvas as OffscreenCanvas, event.data.bytes as ArrayBufferLike);
    return;
  }
  apply?.(event.data.batch as RenderCommandBatch);
});

async function run(canvas: OffscreenCanvas, bytes: ArrayBufferLike): Promise<void> {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      antialias: false,
    });
    renderer.setSize(canvas.width, canvas.height, false);
    renderer.setClearColor(0xfdfbf6, 1);
    REPORT('webgl-renderer', true, renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1');

    // 那段字节是主线程投递过来的同一个 SAB——容量写在表头里，不需要额外被告知。
    const transforms = RenderTransformBuffer.fromBytes(bytes);
    REPORT('transform-bytes', true, `capacity=${transforms.capacity} shared=${transforms.isShared}`);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 200);
    camera.position.set(14, 12, 18);
    camera.lookAt(0, 0, 0);

    const environment = createSceneEnvironment('#ffffff', 40, 160);
    const root = new THREE.Group();
    scene.add(root);
    const renderScene = new ThreeRenderScene(root, environment);

    const generator = await createChunkGenerator();
    const templates = {
      content: { ground: true, trees: true, grass: true, ocean: false },
      environment,
      palette: {
        ground: '#efe9dc', grass: '#cfe0b8', treeTrunk: '#a89073',
        treeNeedles: '#cfe0c0', rock: '#b9b4ab',
      },
    };
    registerChunkTemplates(generator, { ...templates, content: { ...templates.content, grass: false } });
    const chunkViews = new ChunkViewHost({ templates, environment, worldSeed: 1234, seaLevel: 0 });
    scene.add(chunkViews.root);
    REPORT('render-world', true, generator.kind);

    let applied = 0;
    apply = (batch) => {
      // **这里是这次尖刀的重点**：命令是结构化克隆过来的，不是就地调用。
      for (const command of batch.commands) {
        applyRenderCommand(command, { scene: renderScene, transforms, chunkViews });
        applied += 1;
      }
      chunkViews.update(1 / 60, applied / 60);
      chunkViews.beforeRender(renderer);
      renderScene.faceCameras(camera);
      renderer.render(scene, camera);
      REPORT('applied-batch', true, `commands=${batch.commands.length} draws=${renderer.info.render.calls}`);
    };
    REPORT('ready', true);
  } catch (error) {
    REPORT('failed', false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
  }
}
