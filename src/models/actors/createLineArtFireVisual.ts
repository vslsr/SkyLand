import * as THREE from 'three';
import type { LineArtFireVisualRig, WavyFlameVisual } from './ActorVisualModel';

const SEGMENTS = 24;

export interface LineArtFireSource {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly height: number;
  readonly width: number;
  readonly phase: number;
  readonly speed: number;
}

function createFlame(
  material: THREE.LineBasicMaterial,
  x: number,
  y: number,
  z: number,
  height: number,
  width: number,
  phase: number,
  speed: number,
): WavyFlameVisual {
  const position = new THREE.BufferAttribute(
    new Float32Array((SEGMENTS + 1) * 2 * 3),
    3,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', position);
  const line = new THREE.LineLoop(geometry, material);
  line.frustumCulled = false;
  return { line, position, x, y, z, height, width, phase, speed, segments: SEGMENTS };
}

/** 参考魔法小屋壁炉：五层动态线圈火舌与循环上升的线框火星。 */
export function createLineArtFireVisual(
  scale = 1,
  surfaceSources?: readonly LineArtFireSource[],
): LineArtFireVisualRig {
  const root = new THREE.Group();
  root.name = 'line-art-fire-effect';
  root.scale.setScalar(scale);
  root.visible = false;

  const outer = new THREE.LineBasicMaterial({ color: 0xb8421f });
  const middle = new THREE.LineBasicMaterial({ color: 0xe0862e });
  const inner = new THREE.LineBasicMaterial({ color: 0xf5c542 });
  const distributedMaterials = [outer, middle, outer, inner] as const;
  const flames = surfaceSources && surfaceSources.length > 0
    ? surfaceSources.map((source, index) => createFlame(
      distributedMaterials[index % distributedMaterials.length],
      source.x,
      source.y,
      source.z,
      source.height,
      source.width,
      source.phase,
      source.speed,
    ))
    : [
      createFlame(outer, 0, 0, 0, 0.8, 0.3, 0, 2.6),
      createFlame(middle, 0.01, 0, -0.01, 0.6, 0.2, 2.3, 3.1),
      createFlame(inner, -0.01, 0, 0.01, 0.38, 0.11, 4.1, 3.6),
      createFlame(outer, -0.14, 0, -0.1, 0.34, 0.11, 1.2, 3.3),
      createFlame(outer, 0.15, 0, 0.12, 0.28, 0.1, 3.4, 3),
    ];
  root.add(...flames.map((flame) => flame.line));

  const sparkMaterial = new THREE.LineBasicMaterial({ color: 0xe0862e });
  const sparkSources = surfaceSources && surfaceSources.length > 0
    ? surfaceSources
    : Array.from({ length: 6 }, () => null);
  const sparks = sparkSources.map((source, index) => {
    const object = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.018, 0)),
      sparkMaterial,
    );
    const phase = index / sparkSources.length;
    const drift = source
      ? ((index * 37) % 11 - 5) * source.width * 0.18
      : ((index * 37) % 11 - 5) * 0.022;
    const x = source?.x ?? 0;
    const y = source ? source.y + source.height * 0.3 : 0.55;
    const z = source?.z ?? 0;
    const rise = source ? source.height * 1.4 : 1;
    root.add(object);
    return { object, phase, drift, x, y, z, rise };
  });

  return { root, flames, sparks };
}
