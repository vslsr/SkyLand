import * as THREE from 'three';
import { createCharacterInkMaterial } from '../../materials/createCharacterInkMaterial';
import { createContactShadowMaterial } from '../../materials/createContactShadowMaterial';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import {
  HYBRID_SLIME_CENTER_HEIGHT_RATIO,
  HYBRID_SLIME_PLANAR_RADIUS_RATIO,
  hybridSlimeRestY,
} from '../../slime/hybrid/HybridSlimeRestShape';
import type { ActorVisualModel, PbfSlimeVisualRig } from './ActorVisualModel';

export type PbfSlimeRenderDefinition = Extract<
  ActorRenderDefinition,
  { model: 'line-art-pbf-slime' }
>;

function createDirectionNeighbors(directions: Float32Array): readonly Uint16Array[] {
  const vertexCount = directions.length / 3;
  const result: Uint16Array[] = [];
  // 约 20° 的球面邻域，相当于参考密度格一次 3×3×3 模糊的局部低通。
  const minimumDot = 0.94;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const neighbors: number[] = [];
    for (let other = 0; other < vertexCount; other += 1) {
      if (other === vertex) continue;
      const otherOffset = other * 3;
      const dot = (
        directions[offset] * directions[otherOffset]
        + directions[offset + 1] * directions[otherOffset + 1]
        + directions[offset + 2] * directions[otherOffset + 2]
      );
      if (dot >= minimumDot) neighbors.push(other);
    }
    result.push(Uint16Array.from(neighbors));
  }
  return result;
}

function createShadowBoundaryVertices(
  shadowPosition: THREE.BufferAttribute,
  surfaceDirections: Float32Array,
): Uint16Array {
  const result = new Uint16Array(shadowPosition.count - 1);
  for (let ringVertex = 0; ringVertex < result.length; ringVertex += 1) {
    const shadowVertex = ringVertex + 1;
    const directionX = shadowPosition.getX(shadowVertex);
    // CircleGeometry 位于 XY，绕 X -90° 后它的 -Y 对应世界/外壳的 +Z。
    const directionZ = -shadowPosition.getY(shadowVertex);
    const directionLength = Math.hypot(directionX, directionZ) || 1;
    let bestVertex = 0;
    let bestAlignment = Number.NEGATIVE_INFINITY;
    for (let surfaceVertex = 0; surfaceVertex < surfaceDirections.length / 3; surfaceVertex += 1) {
      const offset = surfaceVertex * 3;
      if (Math.abs(surfaceDirections[offset + 1]) > 1e-5) continue;
      const alignment = (
        surfaceDirections[offset] * directionX
        + surfaceDirections[offset + 2] * directionZ
      ) / directionLength;
      if (alignment <= bestAlignment) continue;
      bestAlignment = alignment;
      bestVertex = surfaceVertex;
    }
    result[ringVertex] = bestVertex;
  }
  return result;
}

function createEyes(radius: number, eyeColor: string): THREE.Group {
  const face = new THREE.Group();
  // 眼睛最后单独叠加，属于角色墨记层：不参与昼夜灯光、远景雾或色调映射。
  // 见 createCharacterInkMaterial。
  const eyeMaterial = createCharacterInkMaterial(eyeColor, {
    depthTest: false,
    depthWrite: false,
  });
  const eyeGeometry = new THREE.SphereGeometry(radius * 0.075, 10, 7);
  for (const [index, x] of [-radius * 0.23, radius * 0.23].entries()) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye.name = `pbf-slime-eye-${index === 0 ? 'left' : 'right'}`;
    eye.position.set(x, radius * 0.08, 0);
    eye.scale.y = 1.18;
    eye.renderOrder = 8;
    face.add(eye);
  }
  return face;
}

/** 单一连续外壳；球形软核心、气泡与弹簧蒙皮都位于客户端 visualRoot。 */
export function createPbfSlimeModel(definition: PbfSlimeRenderDefinition): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const pbfRoot = new THREE.Group();
  root.add(visualRoot);
  visualRoot.add(pbfRoot);

  const surfaceGeometry = new THREE.SphereGeometry(1, 24, 16);
  const surfacePosition = surfaceGeometry.getAttribute('position') as THREE.BufferAttribute;
  const surfaceDirections = Float32Array.from(surfacePosition.array as ArrayLike<number>);
  const initialCenterY = definition.radius * HYBRID_SLIME_CENTER_HEIGHT_RATIO;
  for (let offset = 0; offset < surfaceDirections.length; offset += 3) {
    const length = Math.hypot(
      surfaceDirections[offset],
      surfaceDirections[offset + 1],
      surfaceDirections[offset + 2],
    ) || 1;
    surfaceDirections[offset] /= length;
    surfaceDirections[offset + 1] /= length;
    surfaceDirections[offset + 2] /= length;
    surfacePosition.setXYZ(
      offset / 3,
      surfaceDirections[offset] * definition.radius * HYBRID_SLIME_PLANAR_RADIUS_RATIO,
      hybridSlimeRestY(definition.radius, surfaceDirections[offset + 1]),
      surfaceDirections[offset + 2] * definition.radius * HYBRID_SLIME_PLANAR_RADIUS_RATIO,
    );
  }
  surfacePosition.needsUpdate = true;
  surfaceGeometry.computeVertexNormals();
  const surfaceNeighbors = createDirectionNeighbors(surfaceDirections);
  // 场景采用无灯光的 line-art 渲染，不能使用依赖 Light 的 Phong 材质；
  // Basic 保证配置的薄荷色不会在透明叠加前先被压成灰色。
  const coreColor = new THREE.Color(definition.innerColor)
    .lerp(new THREE.Color(definition.highlightColor), 0.08);

  const surface = new THREE.Mesh(
    surfaceGeometry,
    new THREE.MeshBasicMaterial({
      color: definition.surfaceColor,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  surface.name = 'pbf-slime-surface';
  surface.renderOrder = 5;
  surface.frustumCulled = false;
  pbfRoot.add(surface);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(definition.radius * 0.3, 18, 12),
    new THREE.MeshBasicMaterial({
      color: coreColor,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  core.name = 'hybrid-slime-spherical-core';
  core.position.y = initialCenterY;
  core.renderOrder = 2;
  pbfRoot.add(core);

  const bubbleMaterial = new THREE.MeshBasicMaterial({
    color: definition.bubbleColor,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const bubbles = Array.from({ length: definition.bubbleCount }, (_, index) => {
    const size = definition.radius * (0.032 + index % 3 * 0.012);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), bubbleMaterial);
    mesh.name = `pbf-slime-bubble-${index}`;
    mesh.renderOrder = 3;
    pbfRoot.add(mesh);
    return {
      mesh,
      phase: (index * 0.61803398875) % 1,
      particleIndex: index * 17 % definition.particleCount,
    };
  });

  const faceRoot = createEyes(definition.radius, definition.inkColor);
  faceRoot.name = 'pbf-slime-face';
  faceRoot.position.set(0, initialCenterY, definition.radius * 0.82);
  pbfRoot.add(faceRoot);

  const shadowRoot = new THREE.Group();
  shadowRoot.name = 'pbf-slime-adhesion-root';
  visualRoot.add(shadowRoot);
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(
      definition.radius * HYBRID_SLIME_PLANAR_RADIUS_RATIO,
      24,
    ),
    // 影子的方向、长度和浓度跟着房间权威时刻走，见 createContactShadowMaterial。
    createContactShadowMaterial(definition.shadowColor, { opacity: 0.15 }),
  );
  shadow.name = 'pbf-slime-shadow';
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  shadow.renderOrder = 1;
  shadow.frustumCulled = false;
  shadowRoot.add(shadow);
  const shadowPosition = shadow.geometry.getAttribute('position') as THREE.BufferAttribute;
  shadowPosition.setUsage(THREE.DynamicDrawUsage);
  const shadowBoundaryVertices = createShadowBoundaryVertices(
    shadowPosition,
    surfaceDirections,
  );

  const pbfSlimeVisualRig: PbfSlimeVisualRig = {
    root: pbfRoot,
    surface,
    surfaceGeometry,
    surfacePosition,
    surfaceDirections,
    surfaceNeighbors,
    core,
    faceRoot,
    bubbles,
    shadowRoot,
    shadow,
    shadowPosition,
    shadowBoundaryVertices,
    radius: definition.radius,
  };
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.radius * 2.15,
    pbfSlimeVisualRig,
  };
}
