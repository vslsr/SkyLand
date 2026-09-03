import assert from 'node:assert/strict';
import test from 'node:test';
import { CHUNK_SIZE, PROP_KIND } from '../shared/world/worldConfig.mjs';
import {
  DEFAULT_GRASS_PATCH_CONFIG,
  generateChunkGrassPatches,
  isInsideConvexPolygon,
  polygonArea,
  type GrassPatch,
  type GrassPatchConfig,
} from '../src/grass/grassPatchField';
import { StreamingGrassSystem } from '../src/grass/StreamingGrassSystem';
import { createGrassPatchGeometry } from '../src/models/grassPatch';

const CONFIG: GrassPatchConfig = {
  maxPerChunk: 3,
  spawnChance: 1,
  minRadius: 2,
  maxRadius: 5,
  bladeDensity: 12,
};

function collectPatches(chunkRange: number, config = CONFIG): GrassPatch[] {
  const patches: GrassPatch[] = [];
  for (let chunkX = -chunkRange; chunkX <= chunkRange; chunkX += 1) {
    for (let chunkZ = -chunkRange; chunkZ <= chunkRange; chunkZ += 1) {
      patches.push(...generateChunkGrassPatches(0x51a9, chunkX, chunkZ, config));
    }
  }
  return patches;
}

test('同一世界种子与 chunk 坐标始终得到同一批草丛', () => {
  const first = generateChunkGrassPatches(0x51a9, 3, -7, CONFIG);
  const second = generateChunkGrassPatches(0x51a9, 3, -7, CONFIG);
  const other = generateChunkGrassPatches(0x51aa, 3, -7, CONFIG);

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
});

test('每丛草都是完整落在自己 chunk 内的不规则凸多边形', () => {
  for (let chunkX = -2; chunkX <= 2; chunkX += 1) {
    for (let chunkZ = -2; chunkZ <= 2; chunkZ += 1) {
      const minimumX = chunkX * CHUNK_SIZE;
      const minimumZ = chunkZ * CHUNK_SIZE;
      for (const patch of generateChunkGrassPatches(0x51a9, chunkX, chunkZ, CONFIG)) {
        assert.ok(patch.vertices.length / 2 >= 3, '凸包至少三个顶点');
        assert.ok(polygonArea(patch.vertices) > 0);
        for (let index = 0; index < patch.vertices.length; index += 2) {
          const x = patch.vertices[index];
          const z = patch.vertices[index + 1];
          assert.ok(x >= minimumX && x <= minimumX + CHUNK_SIZE, `顶点 x 越出 chunk：${x}`);
          assert.ok(z >= minimumZ && z <= minimumZ + CHUNK_SIZE, `顶点 z 越出 chunk：${z}`);
          assert.ok(Math.hypot(x - patch.centerX, z - patch.centerZ) <= patch.radius + 1e-9);
        }
        // 中心一定在自己的轮廓里：绕向被归一过，内外判定才是有意义的。
        assert.ok(isInsideConvexPolygon(patch.vertices, patch.centerX, patch.centerZ));
      }
    }
  }
});

test('草丛大小与边数各不相同', () => {
  const patches = collectPatches(3);
  const areas = new Set(patches.map((patch) => Math.round(polygonArea(patch.vertices))));
  const vertexCounts = new Set(patches.map((patch) => patch.vertices.length / 2));

  assert.ok(patches.length > 20);
  assert.ok(areas.size > 5, `草丛大小过于单一：${[...areas].join(',')}`);
  assert.ok(vertexCounts.size > 1, `轮廓边数过于单一：${[...vertexCounts].join(',')}`);
});

test('每个 chunk 的草丛数不超过配置上限，概率为零时不生成', () => {
  for (let chunkX = -4; chunkX <= 4; chunkX += 1) {
    const patches = generateChunkGrassPatches(0x51a9, chunkX, 11, CONFIG);
    assert.ok(patches.length <= CONFIG.maxPerChunk);
  }
  assert.equal(
    generateChunkGrassPatches(0x51a9, 0, 0, { ...CONFIG, spawnChance: 0 }).length,
    0,
  );
  assert.equal(
    generateChunkGrassPatches(0x51a9, 0, 0, { ...CONFIG, maxPerChunk: 0 }).length,
    0,
  );
});

test('叶片只落在轮廓内部，并贴着采样到的地表', () => {
  const patches = generateChunkGrassPatches(0x51a9, 0, 0, CONFIG);
  assert.ok(patches.length > 0);
  const geometry = createGrassPatchGeometry(patches, {
    bladeDensity: CONFIG.bladeDensity,
    sampleAnchor: (x, z) => (x + z) * 0.01,
    maximumBladeCount: 4_000,
  });
  assert.ok(geometry, '有草丛时应当产出几何体');

  const offsets = geometry.fill.getAttribute('aOffset');
  assert.equal(offsets.count, geometry.instanceCount);
  for (let index = 0; index < offsets.count; index += 1) {
    const x = offsets.getX(index);
    const z = offsets.getZ(index);
    assert.ok(
      patches.some((patch) => isInsideConvexPolygon(patch.vertices, x, z)),
      `叶片落在所有轮廓之外：${x}, ${z}`,
    );
    // 0.018 是叶根抬离地表的固定量，避免与地面 z-fighting。
    assert.ok(Math.abs(offsets.getY(index) - ((x + z) * 0.01 + 0.018)) < 1e-5);
  }
  geometry.fill.dispose();
  geometry.outline.dispose();
});

test('采样点被拒绝的地方不长草，全被拒时不产出几何体', () => {
  const patches = generateChunkGrassPatches(0x51a9, 0, 0, CONFIG);
  const allWater = createGrassPatchGeometry(patches, {
    bladeDensity: CONFIG.bladeDensity,
    sampleAnchor: () => undefined,
    maximumBladeCount: 4_000,
  });
  assert.equal(allWater, undefined);

  const halfWater = createGrassPatchGeometry(patches, {
    bladeDensity: CONFIG.bladeDensity,
    sampleAnchor: (x) => (x < 0 ? undefined : 0),
    maximumBladeCount: 4_000,
  });
  assert.ok(halfWater);
  const offsets = halfWater.fill.getAttribute('aOffset');
  for (let index = 0; index < offsets.count; index += 1) {
    assert.ok(offsets.getX(index) >= 0, '水面一侧不应该长出草');
  }
  halfWater.fill.dispose();
  halfWater.outline.dispose();
});

test('叶片数受单 chunk 预算约束', () => {
  const patches = generateChunkGrassPatches(0x51a9, 0, 0, {
    ...CONFIG,
    bladeDensity: 400,
  });
  const geometry = createGrassPatchGeometry(patches, {
    bladeDensity: 400,
    sampleAnchor: () => 0,
    maximumBladeCount: 128,
  });
  assert.ok(geometry);
  assert.equal(geometry.instanceCount, 128);
  geometry.fill.dispose();
  geometry.outline.dispose();
});

test('密草叠在稀疏草簇之上，卸载后一并释放', () => {
  const system = new StreamingGrassSystem({
    color: '#b8d39f',
    environment: { fogColor: '#fbf7ec', fogNear: 26, fogFar: 60 },
    patches: DEFAULT_GRASS_PATCH_CONFIG,
  });
  // 一条草簇放置记录，字段顺序见 shared/world/chunkContent.mjs 的 PROP_FIELD。
  const data = {
    fillPositions: new Float32Array(0),
    fillNormals: new Float32Array(0),
    fillTints: new Float32Array(0),
    linePositions: new Float32Array(0),
    props: new Int32Array([PROP_KIND.GRASS, 12_500, 4_250, 700, 1_100, 0]),
    propCount: 1,
  };

  system.mountChunk('0:0', data, {
    worldSeed: 0x51a9,
    chunkX: 0,
    chunkZ: 0,
    sampleAnchor: () => 0,
  });
  const mounted = system.root.children.find((child) => child.name === 'grass-chunk-0:0');
  assert.ok(mounted, '挂载后应当有这个 chunk 的草');
  // 稀疏草簇与密草各一对填充/描边。
  assert.equal(mounted.children.length, 4);

  system.mountChunk('1:0', data, {
    worldSeed: 0x51a9,
    chunkX: 1,
    chunkZ: 0,
    sampleAnchor: () => undefined,
  });
  const waterChunk = system.root.children.find((child) => child.name === 'grass-chunk-1:0');
  assert.ok(waterChunk);
  assert.equal(waterChunk.children.length, 2, '水面 chunk 只剩稀疏草簇');

  system.unmountChunk('0:0');
  assert.equal(
    system.root.children.find((child) => child.name === 'grass-chunk-0:0'),
    undefined,
  );
  system.dispose();
});
