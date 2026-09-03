import * as THREE from 'three';
import {
  INSTANCE_ARCHETYPE,
  INSTANCE_BURNING,
  INSTANCE_ID,
  INSTANCE_QUANTITY,
  INSTANCE_RESIDENCY,
  INSTANCE_ROLL_RADIUS,
  INSTANCE_SINGLE,
  INSTANCE_X,
  INSTANCE_Y,
  INSTANCE_YAW,
  INSTANCE_Z,
  residencyName,
  type RenderInstanceBuffer,
} from '../../render/RenderInstanceBuffer';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import {
  FRUIT_PILE_PIECES,
  createFruitGeometry,
} from '../../models/actors/createFruitPileModel';
import {
  STONE_PILE_PIECES,
  createStonePieceGeometry,
} from '../../models/actors/createStonePileModel';
import {
  WOOD_LOG_STACK_LAYOUT,
  createWoodLogBodyGeometry,
  createWoodLogCutGeometry,
} from '../../models/actors/createWoodLogModel';
import type { ActorArchetypeDefinition } from '../../scenes/data/SceneDefinition';

type ActorRender = ActorArchetypeDefinition['components']['render'];
type WoodPileRender = Extract<ActorRender, { model: 'line-art-wood-pile' }>;
type WoodLogRender = Extract<ActorRender, { model: 'line-art-wood-log' }>;
type StonePileRender = Extract<ActorRender, { model: 'line-art-stone-pile' }>;
type FruitPileRender = Extract<ActorRender, { model: 'line-art-fruit-pile' }>;
type PileRender = WoodPileRender | WoodLogRender | StonePileRender | FruitPileRender;

/** 走合批绘制的堆叠模型。新增一种堆叠物就在这里登记，并补一个 pieces 构造。 */
const PILE_RENDER_MODELS = new Set<PileRender['model']>([
  'line-art-wood-pile',
  'line-art-wood-log',
  'line-art-stone-pile',
  'line-art-fruit-pile',
]);

/**
 * 模板里的一块。位置与朝向写死在矩阵里，颜色随顶点走，
 * 所以整堆合批之后仍然只用一种材质。
 */
interface PilePiece {
  readonly geometry: THREE.BufferGeometry;
  readonly matrix: THREE.Matrix4;
  readonly tint: THREE.Color;
  readonly edgeThreshold: number;
}

function isPileRender(render: ActorRender | undefined): render is PileRender {
  return render !== undefined && PILE_RENDER_MODELS.has(render.model as PileRender['model']);
}

interface BatchEntry {
  readonly root: THREE.Group;
  readonly fillGeometry: THREE.BufferGeometry;
  readonly fillMaterial: THREE.Material;
  fill: THREE.InstancedMesh;
  capacity: number;
  readonly outline: THREE.LineSegments;
  readonly outlineMaterial: THREE.LineBasicMaterial;
  readonly baseOutlinePositions: Float32Array;
  signature: string;
}

interface RollingVisualState {
  readonly quaternion: THREE.Quaternion;
  lastX: number;
  lastZ: number;
}

function nextCapacity(required: number): number {
  let capacity = 16;
  while (capacity < required) capacity *= 2;
  return capacity;
}

/** 三根交错的圆木，与 createWoodPileModel 的摆法一致。 */
function createWoodPilePieces(definition: WoodPileRender, burning: boolean): PilePiece[] {
  const wood = new THREE.Color(burning ? '#d66b38' : definition.woodColor);
  const cut = new THREE.Color(burning ? '#f2a04f' : definition.cutColor);
  const pieces: PilePiece[] = [];
  for (let index = 0; index < 3; index += 1) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3((index - 1) * definition.radius * 0.22, definition.height * (0.35 + index * 0.18), 0),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, index === 2 ? Math.PI / 2 : (index - 0.5) * 0.42, Math.PI / 2),
      ),
      new THREE.Vector3(1, 1, 1),
    );
    pieces.push({
      geometry: new THREE.CylinderGeometry(
        definition.radius * 0.15,
        definition.radius * 0.15,
        definition.radius * 1.45,
        8,
      ),
      matrix,
      tint: index === 2 ? cut : wood,
      edgeThreshold: 6,
    });
  }
  return pieces;
}

/** 单根时是一根可滚动圆木；相邻 Actor 合并后用三根交错布局表达数量。 */
function createWoodLogPieces(
  definition: WoodLogRender,
  burning: boolean,
  single: boolean,
): PilePiece[] {
  const wood = new THREE.Color(burning ? '#d66b38' : definition.woodColor);
  const cut = new THREE.Color(burning ? '#f2a04f' : definition.cutColor);
  const layouts = single
    ? [{ offsetX: 0, offsetY: 0, offsetZ: 0, yaw: 0 }] as const
    : WOOD_LOG_STACK_LAYOUT;
  const pieces: PilePiece[] = [];
  for (const layout of layouts) {
    const x = layout.offsetX * definition.length;
    const y = layout.offsetY * definition.radius;
    const z = layout.offsetZ * definition.length;
    const quaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      layout.yaw,
    );
    pieces.push({
      geometry: createWoodLogBodyGeometry(definition.radius, definition.length),
      matrix: new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        quaternion,
        new THREE.Vector3(1, 1, 1),
      ),
      tint: wood,
      edgeThreshold: 1,
    });
    for (const side of [-1, 1]) {
      const localEndX = side * definition.length * 0.505;
      pieces.push({
        geometry: createWoodLogCutGeometry(definition.radius),
        matrix: new THREE.Matrix4().compose(
          new THREE.Vector3(
            x + Math.cos(layout.yaw) * localEndX,
            y,
            z - Math.sin(layout.yaw) * localEndX,
          ),
          quaternion,
          new THREE.Vector3(1, 1, 1),
        ),
        tint: cut,
        edgeThreshold: 1,
      });
    }
  }
  return pieces;
}

/** 三块压扁的低多边形石头，与 createStonePileModel 的摆法一致。 */
function createStonePilePieces(definition: StonePileRender, burning: boolean): PilePiece[] {
  const stone = new THREE.Color(burning ? '#c98a6a' : definition.stoneColor);
  const accent = new THREE.Color(burning ? '#a86a52' : definition.accentColor);
  return STONE_PILE_PIECES.map((piece) => ({
    geometry: createStonePieceGeometry(definition.radius * piece.scale),
    matrix: new THREE.Matrix4().compose(
      new THREE.Vector3(
        definition.radius * piece.offsetX,
        definition.height * piece.offsetY,
        definition.radius * piece.offsetZ,
      ),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, piece.yaw, 0)),
      new THREE.Vector3(1, 1, 1),
    ),
    tint: piece.accent ? accent : stone,
    edgeThreshold: 0.6,
  }));
}

/** 四颗果子，与 createFruitPileModel 的摆法一致。 */
function createFruitPilePieces(
  definition: FruitPileRender,
  burning: boolean,
  single: boolean,
  groundOffset: number,
): PilePiece[] {
  const fruit = new THREE.Color(burning ? '#8a4a2c' : definition.fruitColor);
  const accent = new THREE.Color(burning ? '#6d3a24' : definition.accentColor);
  if (single) {
    return [{
      geometry: createFruitGeometry(definition.radius),
      matrix: new THREE.Matrix4(),
      tint: fruit,
      edgeThreshold: 24,
    }];
  }
  return FRUIT_PILE_PIECES.map((piece) => ({
    geometry: createFruitGeometry(definition.radius * piece.scale),
    matrix: new THREE.Matrix4().setPosition(
      definition.radius * piece.offsetX,
      definition.height * piece.offsetY - groundOffset,
      definition.radius * piece.offsetZ,
    ),
    tint: piece.accent ? accent : fruit,
    edgeThreshold: 24,
  }));
}

function createPilePieces(
  definition: PileRender,
  burning: boolean,
  single: boolean,
  groundOffset: number,
): PilePiece[] {
  if (definition.model === 'line-art-wood-pile') return createWoodPilePieces(definition, burning);
  if (definition.model === 'line-art-wood-log') {
    return createWoodLogPieces(definition, burning, single);
  }
  if (definition.model === 'line-art-stone-pile') return createStonePilePieces(definition, burning);
  return createFruitPilePieces(definition, burning, single, groundOffset);
}

function createPileTemplate(
  definition: PileRender,
  environment: FillMaterialEnvironment,
  burning: boolean,
  single: boolean,
  groundOffset: number,
): Omit<BatchEntry, 'root' | 'fill' | 'capacity' | 'outline' | 'signature'> {
  const positions: number[] = [];
  const normals: number[] = [];
  const tints: number[] = [];
  const outlinePositions: number[] = [];

  for (const piece of createPilePieces(definition, burning, single, groundOffset)) {
    const { geometry: source, matrix, tint } = piece;
    const triangles = source.toNonIndexed();
    triangles.applyMatrix4(matrix);
    triangles.computeVertexNormals();
    const position = triangles.getAttribute('position');
    const normal = triangles.getAttribute('normal');
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
      normals.push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
      tints.push(tint.r, tint.g, tint.b);
    }
    const edges = new THREE.EdgesGeometry(source, piece.edgeThreshold);
    edges.applyMatrix4(matrix);
    const edgePosition = edges.getAttribute('position');
    for (let vertex = 0; vertex < edgePosition.count; vertex += 1) {
      outlinePositions.push(edgePosition.getX(vertex), edgePosition.getY(vertex), edgePosition.getZ(vertex));
    }
    edges.dispose();
    triangles.dispose();
    source.dispose();
  }

  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  fillGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  fillGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(tints, 3));
  fillGeometry.computeBoundingSphere();
  return {
    fillGeometry,
    fillMaterial: createFillMaterial(0xffffff, environment, { vertexTint: true }),
    outlineMaterial: new THREE.LineBasicMaterial({
      color: burning ? 0x783522 : definition.inkColor,
      transparent: true,
      opacity: 0.88,
    }),
    baseOutlinePositions: new Float32Array(outlinePositions),
  };
}

/** 一个批次固定两次绘制：一份 InstancedMesh 填充 + 一份合并轮廓线。 */
export class HighCountActorBatchSystem {
  public readonly root = new THREE.Group();
  private readonly batches = new Map<string, BatchEntry>();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly rollAxis = new THREE.Vector3();
  private readonly rollStep = new THREE.Quaternion();
  /** 按**实例号**记账，不是 Actor id：渲染侧不认识 Actor。 */
  private readonly rollingVisuals = new Map<number, RollingVisualState>();
  private readonly liveRollingInstanceIds = new Set<number>();

  public constructor(
    private readonly environment: FillMaterialEnvironment,
    private readonly archetypes: ReadonlyMap<string, ActorArchetypeDefinition>,
  ) {
    this.root.name = 'high-count-actor-batches';
  }

  /**
   * 从实例通道重建这一帧的合批（实现路径文档 §3）。
   *
   * 这里以前直接扫 `ActorWorld`——一个渲染系统伸手进 Game World 拿 Component。
   * 渲染世界要进线程，这条就断了。现在输入只是一段定长记录：原型下标、几个状态位、
   * 位置与数量。**它不再认识 Actor，只认识实例号。**
   */
  public sync(instances: RenderInstanceBuffer, archetypeOrder: readonly string[]): void {
    const groups = new Map<string, number[]>();
    this.liveRollingInstanceIds.clear();
    for (let index = 0; index < instances.count; index += 1) {
      const archetypeId = archetypeOrder[instances.readInt(index, INSTANCE_ARCHETYPE)];
      const archetype = archetypeId === undefined ? undefined : this.archetypes.get(archetypeId);
      if (!isPileRender(archetype?.components.render)) continue;
      const single = instances.readInt(index, INSTANCE_SINGLE) === 1;
      if (instances.readFloat(index, INSTANCE_ROLL_RADIUS) > 0) {
        this.liveRollingInstanceIds.add(instances.readInt(index, INSTANCE_ID));
      }
      // 编号翻回名字再拼 key：合批的调试对象名要能读。
      const key = `${archetypeId}:${residencyName(instances.readInt(index, INSTANCE_RESIDENCY))}`
        + `:${instances.readInt(index, INSTANCE_BURNING) === 1 ? 'burning' : 'normal'}`
        + `:${single ? 'single' : 'pile'}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(index);
    }
    for (const instanceId of this.rollingVisuals.keys()) {
      if (!this.liveRollingInstanceIds.has(instanceId)) this.rollingVisuals.delete(instanceId);
    }

    for (const batch of this.batches.values()) batch.root.visible = false;
    for (const [key, members] of groups) {
      const [archetypeId, , burnState, shape] = key.split(':');
      const archetype = this.archetypes.get(archetypeId)!;
      const definition = archetype.components.render as PileRender;
      const batch = this.requireBatch(
        key,
        definition,
        burnState === 'burning',
        shape === 'single',
        archetype.components.dropMotion?.radius ?? 0,
        members.length,
      );
      batch.root.visible = true;
      this.updateBatch(batch, instances, members);
    }
  }

  public dispose(): void {
    for (const batch of this.batches.values()) {
      batch.fillGeometry.dispose();
      batch.fillMaterial.dispose();
      batch.outline.geometry.dispose();
      batch.outlineMaterial.dispose();
      batch.root.parent?.remove(batch.root);
    }
    this.batches.clear();
    this.rollingVisuals.clear();
    this.liveRollingInstanceIds.clear();
  }

  private requireBatch(
    key: string,
    definition: PileRender,
    burning: boolean,
    single: boolean,
    groundOffset: number,
    count: number,
  ): BatchEntry {
    let batch = this.batches.get(key);
    if (!batch) {
      const template = createPileTemplate(
        definition,
        this.environment,
        burning,
        single,
        groundOffset,
      );
      const root = new THREE.Group();
      root.name = `actor-batch-${key}`;
      const capacity = nextCapacity(count);
      const fill = new THREE.InstancedMesh(template.fillGeometry, template.fillMaterial, capacity);
      fill.name = `${key}-fill`;
      fill.frustumCulled = false;
      const outline = new THREE.LineSegments(new THREE.BufferGeometry(), template.outlineMaterial);
      outline.name = `${key}-outline`;
      outline.frustumCulled = false;
      root.add(fill, outline);
      this.root.add(root);
      batch = { ...template, root, fill, capacity, outline, signature: '' };
      this.batches.set(key, batch);
    } else if (count > batch.capacity) {
      batch.root.remove(batch.fill);
      batch.fill.dispose();
      batch.capacity = nextCapacity(count);
      batch.fill = new THREE.InstancedMesh(batch.fillGeometry, batch.fillMaterial, batch.capacity);
      batch.fill.frustumCulled = false;
      batch.root.add(batch.fill);
    }
    return batch;
  }

  private updateBatch(
    batch: BatchEntry,
    instances: RenderInstanceBuffer,
    members: readonly number[],
  ): void {
    const rollingQuaternions = members.map((index) => this.updateRollingVisual(instances, index));
    const signature = members.map((index, slot) => {
      const roll = rollingQuaternions[slot];
      const rotation = roll
        ? `,${roll.x.toFixed(3)},${roll.y.toFixed(3)},${roll.z.toFixed(3)},${roll.w.toFixed(3)}`
        : '';
      return `${instances.readInt(index, INSTANCE_ID)}`
        + `,${instances.readFloat(index, INSTANCE_X).toFixed(3)}`
        + `,${instances.readFloat(index, INSTANCE_Y).toFixed(3)}`
        + `,${instances.readFloat(index, INSTANCE_Z).toFixed(3)}`
        + `,${instances.readFloat(index, INSTANCE_YAW).toFixed(3)}`
        + `,${instances.readFloat(index, INSTANCE_QUANTITY)}${rotation}`;
    }).join('|');
    if (signature === batch.signature) return;
    batch.signature = signature;
    batch.fill.count = members.length;
    const source = batch.baseOutlinePositions;
    const outlinePositions = new Float32Array(source.length * members.length);
    let output = 0;
    for (let slot = 0; slot < members.length; slot += 1) {
      const index = members[slot];
      const quantity = instances.readFloat(index, INSTANCE_QUANTITY);
      const roll = rollingQuaternions[slot];
      const visualScale = roll
        ? 1
        : 0.74 + Math.min(0.34, Math.log2(quantity + 1) * 0.065);
      this.position.set(
        instances.readFloat(index, INSTANCE_X),
        instances.readFloat(index, INSTANCE_Y),
        instances.readFloat(index, INSTANCE_Z),
      );
      if (roll) this.quaternion.copy(roll);
      else this.quaternion.setFromAxisAngle(this.up, instances.readFloat(index, INSTANCE_YAW));
      this.scale.setScalar(visualScale);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      batch.fill.setMatrixAt(slot, this.matrix);
      for (let offset = 0; offset < source.length; offset += 3) {
        this.point.set(source[offset], source[offset + 1], source[offset + 2]).applyMatrix4(this.matrix);
        outlinePositions[output++] = this.point.x;
        outlinePositions[output++] = this.point.y;
        outlinePositions[output++] = this.point.z;
      }
    }
    batch.fill.instanceMatrix.needsUpdate = true;
    batch.outline.geometry.dispose();
    batch.outline.geometry = new THREE.BufferGeometry();
    batch.outline.geometry.setAttribute('position', new THREE.BufferAttribute(outlinePositions, 3));
    batch.outline.geometry.computeBoundingSphere();
  }

  /** 球的滚动角只由权威插值位置的位移累积，不需要再复制一套角速度。 */
  private updateRollingVisual(
    instances: RenderInstanceBuffer,
    index: number,
  ): THREE.Quaternion | undefined {
    const instanceId = instances.readInt(index, INSTANCE_ID);
    if (!this.liveRollingInstanceIds.has(instanceId)) return undefined;
    const radius = instances.readFloat(index, INSTANCE_ROLL_RADIUS);
    if (radius <= 0) return undefined;
    const x = instances.readFloat(index, INSTANCE_X);
    const z = instances.readFloat(index, INSTANCE_Z);
    let state = this.rollingVisuals.get(instanceId);
    if (!state) {
      state = {
        quaternion: new THREE.Quaternion()
          .setFromAxisAngle(this.up, instances.readFloat(index, INSTANCE_YAW)),
        lastX: x,
        lastZ: z,
      };
      this.rollingVisuals.set(instanceId, state);
      return state.quaternion;
    }
    const deltaX = x - state.lastX;
    const deltaZ = z - state.lastZ;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance > 1e-6) {
      this.rollAxis.set(deltaZ / distance, 0, -deltaX / distance);
      this.rollStep.setFromAxisAngle(this.rollAxis, distance / radius);
      state.quaternion.premultiply(this.rollStep).normalize();
      state.lastX = x;
      state.lastZ = z;
    }
    return state.quaternion;
  }
}
