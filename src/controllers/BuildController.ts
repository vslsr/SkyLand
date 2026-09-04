import type { CameraFrame } from '../camera/CameraTransform';
import type { WorldRay } from '../camera/cameraRay';
import { PlayerInputTags } from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import type { BuildCommand } from '../network/messages';
import type { BuildPreviewState } from '../render/RenderScene';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';
import type {
  BuildCellStatus,
  BuildHullCandidate,
  BuildPieceCandidate,
} from '../scene/SceneVisualSystem';
import type { TagLike } from '../tags';
import { createSimpleCollisionFromRender } from '../../shared/actor/simpleCollision.mjs';
import type { BuildFootprint } from '../../shared/build/buildFootprint.mjs';
import type { HullBuildGrid } from '../../shared/build/buildGrid.mjs';
import {
  BUILD_REJECTION_LABELS,
  BUILD_REJECTIONS,
  canAffordCost,
  pieceFootprint,
  resolveBuildElevation,
  resolveBuildPlacement,
  validateBuildPlacement,
} from '../../shared/build/index.mjs';

/** 建造栏里选中的东西：一种件，或者「拆除」。 */
export type BuildSelection =
  | { readonly kind: 'piece'; readonly archetype: ActorArchetypeDefinition }
  | { readonly kind: 'remove' };

/** 占位表里幽灵要问的那两样；`BuildSiteIndex` 天然满足。 */
export interface BuildSiteQuery {
  isOccupied(surfaceKey: string, cellX: number, cellZ: number, slot: string): boolean;
  hasFoundation(surfaceKey: string, cellX: number, cellZ: number): boolean;
}

export interface BuildPort {
  /** 本地角色的权威位置；自由镜头的图没有角色，距离交给服务端判。 */
  getPlayerPosition(): { x: number; z: number } | undefined;
  /** 指针在画布上时的世界射线；没有指针（触屏抬起后、指针锁定）就退回准星。 */
  pointerRay(): WorldRay | undefined;
  pickPoint(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { x: number; y: number; z: number } | undefined;
  /** 视野里每一艘能建的船。 */
  listHulls(): readonly BuildHullCandidate[];
  /** 某种水上地基立起来的船用什么网格；件的原型上写着船体原型的 id。 */
  hullGridOf(hullArchetypeId: string): HullBuildGrid | undefined;
  getSites(): BuildSiteQuery | undefined;
  foundationTop(surfaceKey: string, cellX: number, cellZ: number): number | undefined;
  hasLand(): boolean;
  cellStatus(cellX: number, cellZ: number): BuildCellStatus;
  groundTop(cellX: number, cellZ: number): number | undefined;
  seaLevel(): number;
  /** 放置位有没有被玩家、掉落物或场景物件挡住。 */
  isBlocked(footprint: BuildFootprint, surfaceKey: string | undefined): boolean;
  getInventory(): { quantityOf(itemType: string): number } | undefined;
  findPieceNear(x: number, z: number, radius: number): BuildPieceCandidate | undefined;
  getInputLabel(tag: TagLike): string | undefined;
  setHoveredActorId(actorId?: string): void;
  setPreview(state: BuildPreviewState | undefined): void;
  setPrompt(text?: string): void;
  send(command: BuildCommand): void;
}

/** 拆除模式下指针离件多远还算指着它：一格宽的一半再多一点。 */
const REMOVE_PICK_RADIUS = 1.4;

/**
 * 放下这一件的键。
 *
 * 主键（鼠标左键 / 手柄下键）排第一：建造是「对着指针指的地方干这一下」，
 * 而指针本来就在鼠标上——让手离开鼠标去按 E 是把一个连续动作掰成两半。
 * 交互键跟在后面，因为触屏那颗按钮和手柄北键都绑在它上面，少了它触屏就没法建造。
 *
 * 建造模式下这两个键都不再有别的含义：`GrasslandScene` 在建造时关掉手持物的
 * 使用与就近交互，所以点一下不会既放一件又吃掉手上的果子。
 */
const PLACE_TAGS = [PlayerInputTags.Primary, PlayerInputTags.WorldInteract] as const;

/**
 * 建造模式的输入驱动。
 *
 * 每帧做三件事：把指针（或准星）打到的点吸附成一个放置位、按共享规则给幽灵判红绿、
 * 在放置键按下那一帧把**格坐标**发给服务端。它**不判定结果**：能不能放由服务端按
 * 权威状态再跑一遍同一份规则，幽灵是预期，不是许可。
 *
 * 没有选中件时它完全惰性——`update` 收起幽灵就返回，放置键的按下也会被丢掉，
 * 所以建造栏「收起 = 退出建造」不需要额外的开关。
 */
export class BuildController {
  private selection?: BuildSelection;
  private interactionRequested = false;
  /** 上一帧有没有在画幽灵；没画时不再每帧发一条「收起」。 */
  private presenting = false;
  private readonly disposeBindings: readonly (() => void)[];

  public constructor(
    private readonly input: InputSubsystem,
    private readonly port: BuildPort,
  ) {
    this.disposeBindings = PLACE_TAGS.map((tag) => input.bind(
      tag,
      () => { this.interactionRequested = true; },
      { phases: ['triggered'] },
    ));
  }

  public get active(): boolean {
    return this.selection !== undefined;
  }

  public setSelection(selection?: BuildSelection): void {
    this.selection = selection;
    // 换件那一下不该顺手放一件。
    this.interactionRequested = false;
    if (!selection) this.clear();
  }

  public update(frame: CameraFrame): void {
    if (!this.selection || !this.input.enabled) {
      this.interactionRequested = false;
      this.clear();
      return;
    }
    const requested = this.interactionRequested;
    this.interactionRequested = false;
    const ray = this.port.pointerRay()
      ?? { origin: frame.position, direction: frame.axes.forward };
    const point = this.port.pickPoint(ray.origin, ray.direction);
    if (!point) {
      this.clear();
      return;
    }
    if (this.selection.kind === 'remove') {
      this.updateRemove(point, requested);
      return;
    }
    this.updatePlace(this.selection.archetype, point, requested);
  }

  public reset(): void {
    this.interactionRequested = false;
    this.clear();
  }

  public dispose(): void {
    this.reset();
    for (const dispose of this.disposeBindings) dispose();
  }

  /** 提示里写哪个键：优先主键，触屏上没有主键时退回交互键。 */
  private placeLabel(): string | undefined {
    for (const tag of PLACE_TAGS) {
      const label = this.port.getInputLabel(tag);
      if (label) return label;
    }
    return undefined;
  }

  private updateRemove(point: { x: number; z: number }, requested: boolean): void {
    const target = this.port.findPieceNear(point.x, point.z, REMOVE_PICK_RADIUS);
    this.port.setPreview(undefined);
    this.port.setHoveredActorId(target?.actorId);
    const label = this.placeLabel();
    this.port.setPrompt(target
      ? this.withLabel(label, `拆除「${target.label}」`)
      : '拆除：指向一件建造件');
    this.presenting = true;
    if (requested && target) this.port.send({ kind: 'remove', actorId: target.actorId });
  }

  private updatePlace(
    archetype: ActorArchetypeDefinition,
    point: { x: number; y: number; z: number },
    requested: boolean,
  ): void {
    const piece = archetype.components.buildPiece;
    const render = archetype.components.render;
    if (!piece || !render) {
      this.clear();
      return;
    }
    const hullGrid = piece.hull ? this.port.hullGridOf(piece.hull) : undefined;
    const sites = this.port.getSites();
    const placement = resolveBuildPlacement(point, piece, this.port.listHulls(), {
      hullGrid,
      // 地基靠这条判「挨没挨着这座船坞」：挨着就接上去，不挨着就是新的一座。
      hasDeck: (surfaceKey, cellX, cellZ) => sites?.hasFoundation(surfaceKey, cellX, cellZ) ?? false,
    });
    const position = this.port.getPlayerPosition();
    const inventory = this.port.getInventory();
    const thickness = render.model === 'line-art-build-foundation' ? render.thickness : 0;
    const elevation = resolveBuildElevation(placement, { kind: piece.kind, thickness }, {
      groundTopAt: (cellX, cellZ) => this.port.groundTop(cellX, cellZ),
      foundationTopAt: (surfaceKey, cellX, cellZ) => this.port.foundationTop(surfaceKey, cellX, cellZ),
    });
    // 水上件的高度是船体本地的：挂在已有的船上就加船的高度，立新船就加水面高度。
    let y = point.y;
    if (elevation !== undefined) {
      y = placement.surface === 'floating'
        ? (placement.founding ? this.port.seaLevel() : (placement.hullY ?? 0)) + elevation
        : elevation;
    }
    const collision = createSimpleCollisionFromRender(render);
    const verdict = validateBuildPlacement(placement, piece, {
      // 没有本地角色（自由镜头）时不判距离：服务端会按它的权威角色再判一次。
      distance: position ? Math.hypot(placement.x - position.x, placement.z - position.z) : 0,
      hasLand: this.port.hasLand(),
      cellStatus: (cellX, cellZ) => this.port.cellStatus(cellX, cellZ),
      isOccupied: (surfaceKey, cellX, cellZ, slot) => (
        sites?.isOccupied(surfaceKey, cellX, cellZ, slot) ?? false
      ),
      hasFoundation: (surfaceKey, cellX, cellZ) => sites?.hasFoundation(surfaceKey, cellX, cellZ) ?? false,
      isBlocked: () => elevation === undefined || this.port.isBlocked(
        pieceFootprint({ x: placement.x, z: placement.z, yaw: placement.yaw }, collision, y),
        placement.surfaceKey,
      ),
      canAfford: inventory ? canAffordCost(inventory, piece.cost) : true,
      // 预算只有服务端知道全貌；这里不替它拒。
      withinBudget: true,
    });
    const valid = verdict.ok && elevation !== undefined;
    this.port.setHoveredActorId(undefined);
    this.port.setPreview({
      pieceId: archetype.id,
      render,
      x: placement.x,
      y,
      z: placement.z,
      yaw: placement.yaw,
      valid,
    });
    const label = this.placeLabel();
    const reason = verdict.ok ? BUILD_REJECTIONS.SUPPORT : verdict.reason;
    const action = placement.founding ? `在这里立一艘船（${piece.label}）` : `放置「${piece.label}」`;
    this.port.setPrompt(valid
      ? this.withLabel(label, action)
      : (BUILD_REJECTION_LABELS as Record<string, string>)[reason] ?? '这里不能放');
    this.presenting = true;
    if (!requested || !valid) return;
    this.port.send({
      kind: 'place',
      archetypeId: archetype.id,
      surface: placement.surface,
      ...(placement.hullActorId ? { hullActorId: placement.hullActorId } : {}),
      cellX: placement.cellX,
      cellZ: placement.cellZ,
      ...(placement.edge ? { edge: placement.edge } : {}),
    });
  }

  private withLabel(label: string | undefined, action: string): string {
    return label ? `${label} · ${action}` : action;
  }

  private clear(): void {
    if (!this.presenting) return;
    this.presenting = false;
    this.port.setPreview(undefined);
    this.port.setHoveredActorId(undefined);
    this.port.setPrompt(undefined);
  }
}
