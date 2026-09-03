import assert from 'node:assert/strict';
import test from 'node:test';
import { GrassBendField } from '../src/grass/GrassBendField';
import { createGrassGradient } from '../src/grass/GrassAppearance';
import { createGrassNoiseTexture } from '../src/grass/GrassNoiseTexture';
import {
  decodeGrassTrailPath,
  encodeGrassTrailPath,
  GrassTrailPath,
  grassTrailWireSize,
} from '../src/grass/GrassTrailPath';
import { GrassTrailRecorder } from '../src/grass/GrassTrailRecorder';

const BOUNDS = { minimumX: -16, maximumX: 16, minimumZ: -16, maximumZ: 16 };

function walk(path: GrassTrailPath, count: number, step = 1): void {
  for (let index = 0; index < count; index += 1) {
    path.push(index * step, 0, 0.6, 1);
  }
}

test('踩踏路径是定长的：写满之后保留最新的一段，最旧的点被覆盖', () => {
  const path = new GrassTrailPath({ capacity: 4, minimumSpacing: 0.3 });
  walk(path, 10);

  assert.equal(path.length, 4);
  assert.deepEqual(path.head, { x: 9, z: 0 });
  const oldest = { x: 0, z: 0, radius: 0, strength: 0, age: 0 };
  path.readPoint(0, oldest);
  assert.equal(oldest.x, 6);
});

test('小于最小间距的输入合并进最新点，站着不动不会吃光点数', () => {
  const path = new GrassTrailPath({ capacity: 8, minimumSpacing: 0.5 });
  for (let index = 0; index < 40; index += 1) path.push(0.01 * index, 0, 0.6, 0.4);

  assert.equal(path.length, 1);
  assert.ok(Math.abs((path.head?.x ?? 0) - 0.39) < 0.000_01);
});

test('合并会把最新点的年龄归零，原地踩着的那一处不会自己回弹', () => {
  const path = new GrassTrailPath({ capacity: 8, minimumSpacing: 0.5, recoverySeconds: 1 });
  path.push(0, 0, 0.6, 1);
  path.advance(0.9);
  const faded = path.currentStrength(0);
  path.push(0.02, 0, 0.6, 1);

  assert.ok(faded < 0.45);
  assert.equal(path.currentStrength(0), 1);
});

test('压痕按年龄衰减，回弹完的点被丢弃', () => {
  const path = new GrassTrailPath({ capacity: 8, minimumSpacing: 0.3, recoverySeconds: 0.5 });
  walk(path, 4);
  assert.equal(path.length, 4);

  path.advance(1);
  assert.ok(path.currentStrength(path.length - 1) < 0.2);
  path.advance(10);
  assert.equal(path.length, 0);
  assert.equal(path.isEmpty, true);
});

test('路径编解码在量化精度内往返，字节数有固定上界', () => {
  // 坐标故意放在 int16 厘米量程之外：编码走的是相对锚点的增量，
  // 世界放大之后远处的足迹不能被静默截断。
  const path = new GrassTrailPath({ capacity: 6, minimumSpacing: 0.3 });
  path.push(4012.34, -8045.67, 0.68, 0.8);
  path.push(4013.34, -8045.67, 0.68, 0.6);
  path.advance(0.4);

  const bytes = encodeGrassTrailPath(path);
  assert.ok(bytes.byteLength <= grassTrailWireSize(6));
  assert.equal(bytes.byteLength, grassTrailWireSize(2));

  const restored = decodeGrassTrailPath(bytes, new GrassTrailPath({
    capacity: 6,
    minimumSpacing: 0.3,
  }));
  assert.equal(restored.length, path.length);
  const source = { x: 0, z: 0, radius: 0, strength: 0, age: 0 };
  const target = { x: 0, z: 0, radius: 0, strength: 0, age: 0 };
  for (let index = 0; index < path.length; index += 1) {
    path.readPoint(index, source);
    restored.readPoint(index, target);
    assert.ok(Math.abs(source.x - target.x) <= 0.005);
    assert.ok(Math.abs(source.z - target.z) <= 0.005);
    assert.ok(Math.abs(source.radius - target.radius) <= 0.01);
    assert.ok(Math.abs(source.strength - target.strength) <= 0.004);
    assert.ok(Math.abs(source.age - target.age) <= 0.01);
  }
});

test('解码到容量更小的路径时只保留最新的那些点', () => {
  const wide = new GrassTrailPath({ capacity: 12, minimumSpacing: 0.3 });
  walk(wide, 12);

  const narrow = decodeGrassTrailPath(
    encodeGrassTrailPath(wide),
    new GrassTrailPath({ capacity: 4, minimumSpacing: 0.3 }),
  );
  assert.equal(narrow.length, 4);
  assert.deepEqual(narrow.head, { x: 11, z: 0 });
});

test('不同来源各自成路径，来源数有上界并按离焦点最远淘汰', () => {
  const recorder = new GrassTrailRecorder({ maxSources: 2, capacity: 4 });
  recorder.setFocus(0, 0);
  recorder.ingest([
    impulse('near', 1, 0),
    impulse('far', 40, 0),
  ]);
  assert.equal(recorder.sourceCount, 2);
  assert.equal(recorder.getPath('near')?.length, 1);
  assert.equal(recorder.getPath('far')?.length, 1);

  recorder.ingest([impulse('newcomer', 2, 0)]);
  assert.equal(recorder.sourceCount, 2);
  assert.equal(recorder.getPath('far'), undefined);
  assert.ok(recorder.getPath('near'));
  assert.ok(recorder.getPath('newcomer'));
});

test('空掉的来源被回收，记录器不会随时间积累条目', () => {
  const recorder = new GrassTrailRecorder({ maxSources: 4, capacity: 4, recoverySeconds: 0.2 });
  recorder.ingest([impulse('walker', 0, 0)]);
  assert.equal(recorder.sourceCount, 1);

  recorder.advance(5);
  assert.equal(recorder.sourceCount, 0);
});

test('弯曲场只为窗口内的路径生成线段，且不超过线段上界', () => {
  const field = new GrassBendField(BOUNDS, { textureSize: 4, maxSegments: 6 });
  const recorder = new GrassTrailRecorder({ maxSources: 4, capacity: 8 });

  recorder.ingest([
    impulse('inside', 0, 0),
    impulse('inside', 1, 0),
    impulse('inside', 2, 0),
    impulse('outside', 500, 500),
    impulse('outside', 501, 500),
  ]);
  // 窗口外那条路径整条跳过：3 个点连成 2 段，越界的 2 个点不产生线段。
  assert.equal(field.prepareSegments(recorder), 2);

  for (let index = 3; index < 12; index += 1) {
    recorder.ingest([impulse('inside', index, 0)]);
  }
  assert.equal(field.prepareSegments(recorder), 6);
  field.dispose();
});

test('单点路径退化成一段零长线段，站着不动脚下也有压痕', () => {
  const field = new GrassBendField(BOUNDS, { textureSize: 4 });
  const recorder = new GrassTrailRecorder({ capacity: 8 });
  recorder.ingest([impulse('standing', 3, -3)]);

  assert.equal(field.prepareSegments(recorder), 1);
  field.dispose();
});

test('大幅移动窗口后旧足迹不再被盖章，也不需要重投影', () => {
  const field = new GrassBendField(BOUNDS, { textureSize: 4 });
  const recorder = new GrassTrailRecorder({ capacity: 8 });
  recorder.ingest([impulse('walker', 0, 0), impulse('walker', 1, 0)]);
  assert.equal(field.prepareSegments(recorder), 1);

  field.setBounds({
    minimumX: 100_000,
    maximumX: 100_032,
    minimumZ: 100_000,
    maximumZ: 100_032,
  });
  assert.equal(field.prepareSegments(recorder), 0);
  field.dispose();
});

test('草地噪声贴图是确定性的、可平铺的四通道数据', () => {
  const first = createGrassNoiseTexture(32, 1234);
  const second = createGrassNoiseTexture(32, 1234);
  const different = createGrassNoiseTexture(32, 5678);
  const firstData = first.image.data as Uint8Array;
  const secondData = second.image.data as Uint8Array;
  const differentData = different.image.data as Uint8Array;

  assert.equal(firstData.length, 32 * 32 * 4);
  assert.deepEqual(Array.from(firstData), Array.from(secondData));
  assert.notDeepEqual(Array.from(firstData), Array.from(differentData));

  // 四个通道都必须真的有变化，否则高低差或阵风会退化成常量。
  for (let channel = 0; channel < 4; channel += 1) {
    let minimum = 255;
    let maximum = 0;
    for (let texel = 0; texel < 32 * 32; texel += 1) {
      const value = firstData[texel * 4 + channel];
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    assert.ok(maximum - minimum > 40, `通道 ${channel} 的噪声没有起伏`);
  }

  first.dispose();
  second.dispose();
  different.dispose();
});

test('草地噪声贴图无缝平铺：环绕接缝的落差不高于内部相邻列', () => {
  const size = 64;
  const texture = createGrassNoiseTexture(size, 4321);
  const data = texture.image.data as Uint8Array;
  const columnGap = (left: number, right: number, channel: number): number => {
    let total = 0;
    for (let row = 0; row < size; row += 1) {
      total += Math.abs(
        data[(row * size + left) * 4 + channel] - data[(row * size + right) * 4 + channel],
      );
    }
    return total / size;
  };

  for (let channel = 0; channel < 4; channel += 1) {
    let interiorGap = 0;
    for (let column = 1; column < size; column += 1) {
      interiorGap = Math.max(interiorGap, columnGap(column - 1, column, channel));
    }
    // 接缝处（最后一列与第 0 列）必须和内部相邻列一样平顺，否则草地会出现硬边。
    assert.ok(
      columnGap(size - 1, 0, channel) <= interiorGap + 1,
      `通道 ${channel} 在环绕接缝上有硬边`,
    );
  }

  texture.dispose();
});

test('渐变色从单一基色推出根深尖浅，并保住色相方向', () => {
  const gradient = createGrassGradient('#b8d39f');
  const root = { h: 0, s: 0, l: 0 };
  const tip = { h: 0, s: 0, l: 0 };
  const dry = { h: 0, s: 0, l: 0 };
  gradient.root.getHSL(root);
  gradient.tip.getHSL(tip);
  gradient.dry.getHSL(dry);

  assert.ok(root.l < tip.l, '根部必须比叶尖暗');
  assert.ok(tip.h < root.h, '叶尖应当偏黄，色相比根部小');
  assert.ok(dry.s < root.s, '枯斑的饱和度低于根部');
});

function impulse(sourceId: string, positionX: number, positionZ: number) {
  return {
    sourceId,
    positionX,
    positionZ,
    startPositionX: positionX,
    startPositionZ: positionZ,
    directionX: 1,
    directionZ: 0,
    radius: 0.65,
    strength: 1,
    radial: true,
  };
}
