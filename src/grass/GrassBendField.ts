import * as THREE from 'three';
import {
  GRASS_BEND_FRAGMENT_SHADER,
  GRASS_BEND_VERTEX_SHADER,
} from '../shaders/grass';
import type { NormalizedGrassBendImpulse } from './GrassInteraction';
import type { GrassBendFieldView } from './GrassLayout';

const BEND_TEXTURE_SIZE = 256;
const DECAY_PER_60HZ_FRAME = 0.965;

export class GrassBendField {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new THREE.PlaneBufferGeometry(2, 2);
  private readonly material: THREE.ShaderMaterial;
  private readonly targets: readonly [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readIndex = 0;
  private initialized = false;

  public constructor(view: GrassBendFieldView) {
    // 直接引用布局持有的向量，而不是拷贝：滚动布局每帧移动原点，
    // 共享同一个实例就不需要再往下同步一遍。
    this.targets = [createBendTarget(view.wrap), createBendTarget(view.wrap)];
    this.material = new THREE.ShaderMaterial({
      vertexShader: GRASS_BEND_VERTEX_SHADER,
      fragmentShader: GRASS_BEND_FRAGMENT_SHADER,
      uniforms: {
        uPreviousTexture: { value: this.targets[0].texture },
        uFieldOrigin: { value: view.origin },
        uFieldSize: { value: view.size },
        uImpulsePosition: { value: new THREE.Vector2() },
        uImpulseDirection: { value: new THREE.Vector2(1, 0) },
        uImpulseRadius: { value: 0.65 },
        uImpulseStrength: { value: 0 },
        uDecay: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
  }

  public get texture(): THREE.Texture {
    return this.targets[this.readIndex].texture;
  }

  public step(
    renderer: THREE.WebGLRenderer,
    deltaSeconds: number,
    impulse?: NormalizedGrassBendImpulse,
  ): void {
    this.initialize(renderer);
    const writeIndex = 1 - this.readIndex;
    const readTarget = this.targets[this.readIndex];
    const writeTarget = this.targets[writeIndex];
    const previousTarget = renderer.getRenderTarget();

    this.material.uniforms.uPreviousTexture.value = readTarget.texture;
    this.material.uniforms.uDecay.value = Math.pow(
      DECAY_PER_60HZ_FRAME,
      Math.max(0, deltaSeconds) * 60,
    );
    this.material.uniforms.uImpulseStrength.value = impulse?.strength ?? 0;
    if (impulse) {
      this.material.uniforms.uImpulsePosition.value.set(impulse.positionX, impulse.positionZ);
      this.material.uniforms.uImpulseDirection.value.set(impulse.directionX, impulse.directionZ);
      this.material.uniforms.uImpulseRadius.value = impulse.radius;
    }

    renderer.setRenderTarget(writeTarget);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previousTarget);
    this.readIndex = writeIndex;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    for (const target of this.targets) target.dispose();
  }

  private initialize(renderer: THREE.WebGLRenderer): void {
    if (this.initialized) return;
    const previousTarget = renderer.getRenderTarget();
    const previousColor = renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha = renderer.getClearAlpha();
    renderer.setClearColor(new THREE.Color(0.5, 0.5, 0), 1);
    for (const target of this.targets) {
      renderer.setRenderTarget(target);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    this.initialized = true;
  }
}

/**
 * 环形寻址的形变场必须让纹理本身也回绕，否则着色器 fract 出来的 UV
 * 在接缝处会被钳制，踩踏痕迹会在边缘拖出一道条纹。
 */
function createBendTarget(wrap: boolean): THREE.WebGLRenderTarget {
  const wrapping = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  const target = new THREE.WebGLRenderTarget(BEND_TEXTURE_SIZE, BEND_TEXTURE_SIZE, {
    wrapS: wrapping,
    wrapT: wrapping,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.generateMipmaps = false;
  return target;
}
