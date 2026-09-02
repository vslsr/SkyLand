import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridSlimeSimulation } from '../src/slime/hybrid/HybridSlimeSimulation';
import { HybridSlimeVolumeFlow } from '../src/slime/hybrid/HybridSlimeVolumeFlow';
import {
  HYBRID_SLIME_CENTER_HEIGHT_RATIO,
  HYBRID_SLIME_PLANAR_RADIUS_RATIO,
  hybridSlimeFloorY,
  hybridSlimeRestY,
} from '../src/slime/hybrid/HybridSlimeRestShape';

const RADIUS = 0.95;

/** 与 createPbfSlimeModel 相同的经纬球拓扑，但不依赖 three，测试保持纯数学。 */
function createSurfaceDirections(segments = 16, rings = 12): Float32Array {
  const values: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const polar = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment += 1) {
      const azimuth = (segment / segments) * Math.PI * 2;
      values.push(
        Math.sin(polar) * Math.sin(azimuth),
        Math.cos(polar),
        Math.sin(polar) * Math.cos(azimuth),
      );
    }
  }
  return Float32Array.from(values);
}

function createSurfaceNeighbors(directions: Float32Array): Uint16Array[] {
  const vertexCount = directions.length / 3;
  const result: Uint16Array[] = [];
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
      if (dot >= 0.94) neighbors.push(other);
    }
    result.push(Uint16Array.from(neighbors));
  }
  return result;
}

/** 与 HybridSlimeSimulation.rebuildAnchors 静止分支一致的贴地穹顶。 */
function createRestShell(directions: Float32Array): Float32Array {
  const shell = new Float32Array(directions.length);
  for (let offset = 0; offset < directions.length; offset += 3) {
    shell[offset] = directions[offset] * RADIUS * HYBRID_SLIME_PLANAR_RADIUS_RATIO;
    shell[offset + 1] = hybridSlimeRestY(RADIUS, directions[offset + 1]);
    shell[offset + 2] = directions[offset + 2] * RADIUS * HYBRID_SLIME_PLANAR_RADIUS_RATIO;
  }
  return shell;
}

function createFlow(directions: Float32Array): HybridSlimeVolumeFlow {
  return new HybridSlimeVolumeFlow(directions, {
    radius: RADIUS,
    floorY: hybridSlimeFloorY(RADIUS),
  });
}

const CENTER = new Float32Array([0, RADIUS * HYBRID_SLIME_CENTER_HEIGHT_RATIO, 0]);

test('蒙皮与静止形状一致时不产生体积流动', () => {
  const directions = createSurfaceDirections();
  const flow = createFlow(directions);
  const anchors = createRestShell(directions);
  const pristine = Float32Array.from(anchors);
  const positions = Float32Array.from(anchors);

  for (let step = 0; step < 30; step += 1) {
    flow.apply(anchors, positions, CENTER, 1 / 120);
  }

  assert.ok(Math.abs(flow.lastVolumeError) < 1e-6);
  for (let offset = 0; offset < anchors.length; offset += 1) {
    assert.ok(Math.abs(anchors[offset] - pristine[offset]) < 1e-6);
  }
});

test('压出的空隙由就近蒙皮向外下坠填充，而不是整圈均匀鼓胀', () => {
  const directions = createSurfaceDirections();
  const flow = createFlow(directions);
  const anchors = createRestShell(directions);
  const pristine = Float32Array.from(anchors);
  const positions = Float32Array.from(anchors);

  // 只在 +X 侧压进去一块，制造一个真实的空隙。
  const dentedVertices: number[] = [];
  for (let offset = 0; offset < directions.length; offset += 3) {
    if (directions[offset] < 0.7) continue;
    dentedVertices.push(offset);
    positions[offset] -= RADIUS * 0.22;
  }
  assert.ok(dentedVertices.length > 0);

  for (let step = 0; step < 60; step += 1) {
    anchors.set(pristine);
    flow.apply(anchors, positions, CENTER, 1 / 120);
  }
  assert.ok(flow.lastVolumeError > 0, '缺体积时误差必须为正');

  // 取空隙上侧的顶点：静止形状里赤道及以下整圈都压在 floorY 上，本来就不允许再下坠。
  let dentedOffset = dentedVertices[0];
  let bestAlignment = Number.NEGATIVE_INFINITY;
  for (const offset of dentedVertices) {
    const directionY = directions[offset + 1];
    if (directionY < 0.2 || directionY > 0.6) continue;
    if (directions[offset] <= bestAlignment) continue;
    bestAlignment = directions[offset];
    dentedOffset = offset;
  }
  assert.ok(bestAlignment > 0, '空隙必须覆盖到离地的一段蒙皮');
  // 空隙一侧的锚点被推向空隙内部（+X），并且整体向下坠。
  assert.ok(anchors[dentedOffset] > pristine[dentedOffset] + RADIUS * 0.01);
  assert.ok(anchors[dentedOffset + 1] < pristine[dentedOffset + 1] - RADIUS * 0.005);

  // 背面没有空隙，只允许拿到远小于空隙侧的补偿。
  let oppositeOffset = 0;
  let mostOpposite = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < directions.length; offset += 3) {
    if (directions[offset] >= mostOpposite) continue;
    mostOpposite = directions[offset];
    oppositeOffset = offset;
  }
  const dentedGain = Math.abs(anchors[dentedOffset] - pristine[dentedOffset]);
  const oppositeGain = Math.abs(anchors[oppositeOffset] - pristine[oppositeOffset]);
  assert.ok(oppositeGain < dentedGain * 0.75);
});

test('被拉出的一块不再供料，本体向内并塌陷', () => {
  const directions = createSurfaceDirections();
  const flow = createFlow(directions);
  const anchors = createRestShell(directions);
  const pristine = Float32Array.from(anchors);
  const positions = Float32Array.from(anchors);

  for (let offset = 0; offset < directions.length; offset += 3) {
    if (directions[offset] < 0.7) continue;
    positions[offset] += RADIUS * 0.3;
  }

  for (let step = 0; step < 60; step += 1) {
    anchors.set(pristine);
    flow.apply(anchors, positions, CENTER, 1 / 120);
  }
  assert.ok(flow.lastVolumeError < 0, '多体积时误差必须为负');

  // 顶部本体被抽走材料后下沉。
  let topOffset = 0;
  let highest = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < directions.length; offset += 3) {
    if (directions[offset + 1] <= highest) continue;
    highest = directions[offset + 1];
    topOffset = offset;
  }
  assert.ok(anchors[topOffset + 1] < pristine[topOffset + 1] - RADIUS * 0.005);
});

test('补偿量有硬上限，reset 后完全清零', () => {
  const directions = createSurfaceDirections();
  const flow = createFlow(directions);
  const anchors = createRestShell(directions);
  const pristine = Float32Array.from(anchors);
  const positions = createRestShell(directions);
  // 极端塌缩：整张蒙皮收到中心附近。
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] = CENTER[0];
    positions[offset + 1] = CENTER[1];
    positions[offset + 2] = CENTER[2];
  }

  for (let step = 0; step < 600; step += 1) {
    anchors.set(pristine);
    flow.apply(anchors, positions, CENTER, 1 / 120);
  }
  for (const offset of flow.offsets) {
    assert.ok(Math.abs(offset) <= RADIUS * 0.24 + 1e-6);
  }

  flow.reset();
  assert.ok(flow.offsets.every((value) => value === 0));
  assert.equal(flow.lastVolumeError, 0);
});

test('碰撞凹陷会被体积流动补回，并且蒙皮仍然能休眠', () => {
  const directions = createSurfaceDirections();
  const simulation = new HybridSlimeSimulation({
    radius: RADIUS,
    surfaceDirections: directions,
    surfaceNeighbors: createSurfaceNeighbors(directions),
    coreStiffness: 52.8,
    skinStiffness: 61.6,
    skinDamping: 14,
    neighborStiffness: 19.8,
  });
  const flow = createFlow(directions);
  const restVolume = flow.measureVolume(simulation.positions, simulation.center);

  simulation.applyCollision(1.4, 0, 1 / 60);
  const dentedVolume = flow.measureVolume(simulation.positions, simulation.center);
  assert.ok(dentedVolume < restVolume * 0.985, '碰撞必须真的挖掉体积');

  let slept = false;
  for (let step = 0; step < 600; step += 1) {
    simulation.update(1 / 60);
    if (!simulation.stats().active) {
      slept = true;
      break;
    }
  }
  assert.ok(slept, '体积流动不能阻止蒙皮休眠');

  const recoveredVolume = flow.measureVolume(simulation.positions, simulation.center);
  assert.ok(Math.abs(recoveredVolume - restVolume) < restVolume * 0.01);
  assert.ok(Math.abs(simulation.stats().surfaceVolumeError) < 1e-6);
});
