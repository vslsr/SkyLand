import {
  ACTOR_CONTROL_COMPONENT,
  BUILD_GRID_COMPONENT,
  BUILD_PIECE_COMPONENT,
  BUOYANCY_COMPONENT,
  INVENTORY_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { createSimpleCollisionFromRender } from '../../shared/actor/simpleCollision.mjs';
import {
  BUILD_REJECTIONS,
  MAX_BUILD_PIECES_PER_PLAYER,
  MAX_BUILD_PIECES_PER_ROOM,
  WORLD_BUILD_GRID,
  canAffordCost,
  createHullBuildGrid,
  findDependentPieces,
  pieceFootprint,
  resolveBuildElevation,
  restoreBuildPlacement,
  validateBuildPlacement,
} from '../../shared/build/index.mjs';
import { findItemArchetypeId } from './InventoryMutations.mjs';
import {
  addVesselStructurePart,
  removeVesselStructurePart,
} from './VesselStateMutations.mjs';

/**
 * 建造的权威变更：放一件、拆一件。
 *
 * 客户端发的是**格坐标**，不是世界坐标：服务端按自己手里的船体位姿把它还原成
 * 世界位姿，再跑和客户端同一份 `validateBuildPlacement`。幽灵是绿的、服务端却拒
 * 的情况只可能来自状态不同步（材料刚被别人拿走、格子刚被别人占了），不会来自
 * 两端各写了一套规则。
 *
 * 一件建造件就是一个普通 Actor：有 Transform、碰撞盒、复制策略，走同一条快照。
 * 水上件是船体根节点的子 Actor，`AttachmentSystem` 带着它跟船走；地基还进船的
 * 浮力结算——多铺几块板，船就更稳也更重。最初的一块水上地基放在开阔水面上时，
 * 先按它原型里写的 `hull` 立一个看不见的船体根节点，板成为那艘船的第 (0, 0) 格。
 */

const ARCHETYPE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

const reject = (reason) => ({ ok: false, reason });

/** 件沿格边的尺寸：地基是边长，墙是宽度。它必须等于所在网格的格宽；物件没有这一说。 */
function pieceFootprintSize(archetype) {
  const render = archetype.components.render;
  if (render?.model === 'line-art-build-foundation') return render.size;
  if (render?.model === 'line-art-build-wall') return render.width;
  return undefined;
}

/** 地基的厚度决定它站多高、墙脚落在哪；墙和物件没有厚度这一说。 */
function pieceThickness(archetype) {
  const render = archetype.components.render;
  return render?.model === 'line-art-build-foundation' ? render.thickness : 0;
}

/**
 * 一艘能建的船：有 buildGrid 的 Actor 与它此刻的权威位姿。
 * @returns {{ actor: object, actorId: string, x: number, y: number, z: number, yaw: number, grid: object } | undefined}
 */
export function resolveHullSurface(scene, actorId) {
  const id = typeof actorId === 'string' && ACTOR_ID_PATTERN.test(actorId) ? actorId : undefined;
  const actor = id ? scene.actorWorld.getActor(id) : undefined;
  const grid = actor?.getComponent(BUILD_GRID_COMPONENT);
  const transform = actor?.getComponent(TRANSFORM_COMPONENT);
  if (!actor || !grid || !transform) return undefined;
  return {
    actor,
    actorId: actor.id,
    x: transform.x,
    y: transform.y,
    z: transform.z,
    yaw: transform.yaw,
    grid: grid.grid,
  };
}

/**
 * 放一件。
 *
 * @returns {{ ok: true, actor: object, hullActor?: object } | { ok: false, reason: string }}
 */
export function placeBuildPiece(scene, player, command) {
  const world = scene.actorWorld;
  const archetypeId = typeof command?.archetypeId === 'string'
    && ARCHETYPE_ID_PATTERN.test(command.archetypeId)
    ? command.archetypeId
    : undefined;
  const archetype = archetypeId ? world.context.archetypes?.get(archetypeId) : undefined;
  const piece = archetype?.components.buildPiece;
  const render = archetype?.components.render;
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  if (!piece || !render || !inventory) return reject(BUILD_REJECTIONS.SURFACE);

  const hullRequested = command.surface === 'floating' && command.hullActorId !== undefined;
  const hull = hullRequested ? resolveHullSurface(scene, command.hullActorId) : undefined;
  if (hullRequested && !hull) return reject(BUILD_REJECTIONS.SURFACE);
  const hullArchetype = piece.hull ? world.context.archetypes?.get(piece.hull) : undefined;
  const hullGrid = hullArchetype?.components.buildGrid
    ? createHullBuildGrid(hullArchetype.components.buildGrid)
    : undefined;
  const placement = restoreBuildPlacement(command, piece, hull, hullGrid);
  if (!placement) return reject(BUILD_REJECTIONS.SURFACE);
  // 件的尺寸必须和网格格宽一致，否则墙会伸出格边、地基会和邻格重叠。
  const footprintSize = pieceFootprintSize(archetype);
  const cellSize = placement.founding ? hullGrid?.cellSize : placement.grid.cellSize;
  if (footprintSize !== undefined
    && (cellSize === undefined || Math.abs(footprintSize - cellSize) > 1e-6)) {
    return reject(BUILD_REJECTIONS.SURFACE);
  }

  const sites = scene.buildSites;
  const thickness = pieceThickness(archetype);
  const collision = createSimpleCollisionFromRender(render);
  let localY;
  const verdict = validateBuildPlacement(placement, piece, {
    distance: Math.hypot(placement.x - player.x, placement.z - player.z),
    hasLand: scene.landBuildable,
    cellStatus: (cellX, cellZ) => scene.buildCellStatus(cellX, cellZ),
    isOccupied: (surfaceKey, cellX, cellZ, slot) => sites.isOccupied(surfaceKey, cellX, cellZ, slot),
    hasFoundation: (surfaceKey, cellX, cellZ) => sites.hasFoundation(surfaceKey, cellX, cellZ),
    // 几何规则都过了才问实体：高度算不出来就是没有可站的面。
    isBlocked: () => {
      localY = resolveBuildElevation(placement, { kind: piece.kind, thickness }, {
        groundTopAt: (cellX, cellZ) => scene.groundTopHeight(cellX, cellZ),
        foundationTopAt: (surfaceKey, cellX, cellZ) => scene.buildFoundationTop(surfaceKey, cellX, cellZ),
      });
      if (localY === undefined) return true;
      const worldY = placement.surface === 'floating'
        ? (placement.founding ? scene.seaLevel : hull.y) + localY
        : localY;
      const footprint = pieceFootprint({ x: placement.x, z: placement.z, yaw: placement.yaw }, collision, worldY);
      return scene.buildFootprintBlocked(footprint, placement.surfaceKey);
    },
    canAfford: canAffordCost(inventory, piece.cost),
    withinBudget: sites.size < MAX_BUILD_PIECES_PER_ROOM
      && sites.countByBuilder(player.id) < MAX_BUILD_PIECES_PER_PLAYER
      && (!hull || sites.countBySurface(hull.actorId) < hull.grid.maxPieces),
  });
  if (!verdict.ok) return verdict;
  if (localY === undefined) return reject(BUILD_REJECTIONS.SUPPORT);

  // 材料够是刚校验过的，这里不会扣到一半；先扣再生成，生成失败也不会凭空多出一件。
  for (const entry of piece.cost) inventory.remove(entry.itemType, entry.quantity);

  let hullActor = hull?.actor;
  let surfaceKey = placement.surfaceKey;
  let { cellX, cellZ, localX, localZ, localYaw } = placement;
  if (placement.founding) {
    // 最初的一块板：先立一个看不见的船体根节点，板成为它的第 (0, 0) 格。
    const hullId = `hull-${(scene.nextBuildId++).toString(36)}`;
    hullActor = world.context.createActor({
      id: hullId,
      archetypeId: hullArchetype.id,
      localTransform: { position: [placement.x, scene.seaLevel, placement.z], yaw: 0 },
    }, hullArchetype);
    world.addActor(hullActor);
    surfaceKey = hullId;
    cellX = 0;
    cellZ = 0;
    localX = 0;
    localZ = 0;
    localYaw = 0;
  }

  const id = `build-${(scene.nextBuildId++).toString(36)}`;
  const actor = world.context.createActor({
    id,
    archetypeId: archetype.id,
    localTransform: hullActor
      ? { position: [localX, localY, localZ], yaw: localYaw }
      : { position: [placement.x, localY, placement.z], yaw: placement.yaw },
  }, archetype, {
    buildPiece: {
      thickness,
      cellX,
      cellZ,
      edge: placement.edge ?? null,
      builderPlayerId: player.id,
      placedSurface: placement.surface,
    },
  });
  world.addActor(actor);
  if (hullActor) {
    // 本地位姿已经是船体网格里的位姿：挂上去时按本地重算世界，不保留世界位姿。
    world.setActorParent(actor.id, hullActor.id, { worldPositionStays: false });
    const buoyancy = hullActor.getComponent(BUOYANCY_COMPONENT);
    if (buoyancy && (piece.mass > 0 || piece.buoyancy > 0)) {
      addVesselStructurePart(buoyancy, {
        id: actor.id,
        mass: piece.mass,
        buoyancy: piece.buoyancy,
        localX,
        localZ,
      });
    }
  }
  sites.add({
    actorId: actor.id,
    surfaceKey,
    kind: piece.kind,
    cellX,
    cellZ,
    edge: placement.edge,
    slot: piece.slot ?? undefined,
    builderPlayerId: player.id,
  });
  // 新件的碰撞体立刻登记：放完这一下玩家就能站上去，不用等下一个 tick。
  world.context.refreshActorColliders?.();
  return { ok: true, actor, ...(hullActor ? { hullActor } : {}) };
}

/**
 * 拆一件。材料全额退回背包；装不下的那部分掉在件的位置上，不能凭空消失。
 * 船上最后一件拆掉，那艘船（看不见的根节点）也跟着没了。
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function removeBuildPiece(scene, player, command) {
  const world = scene.actorWorld;
  const actorId = typeof command?.actorId === 'string' && ACTOR_ID_PATTERN.test(command.actorId)
    ? command.actorId
    : undefined;
  const actor = actorId ? world.getActor(actorId) : undefined;
  const piece = actor?.getComponent(BUILD_PIECE_COMPONENT);
  const transform = actor?.getComponent(TRANSFORM_COMPONENT);
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const record = actor ? scene.buildSites.getByActor(actor.id) : undefined;
  if (!actor || !piece || !transform || !inventory || !record) return reject(BUILD_REJECTIONS.SURFACE);
  if (Math.hypot(transform.x - player.x, transform.z - player.z) > piece.reach) {
    return reject(BUILD_REJECTIONS.REACH);
  }
  const hull = piece.placedSurface === 'floating'
    ? resolveHullSurface(scene, actor.parent?.id)
    : undefined;
  const placementLike = {
    surface: piece.placedSurface,
    surfaceKey: record.surfaceKey,
    grid: hull?.grid ?? WORLD_BUILD_GRID,
  };
  // 上面还立着墙或摆着物件的地基不能拆——它们会悬空。先拆上面的。
  if (findDependentPieces(record, scene.buildSites, placementLike).length > 0) {
    return reject(BUILD_REJECTIONS.SUPPORT);
  }

  for (const entry of piece.cost) {
    const accepted = inventory.add(entry.itemType, entry.quantity);
    const leftover = entry.quantity - accepted;
    if (leftover <= 0) continue;
    const dropArchetypeId = findItemArchetypeId(world.context.archetypes, entry.itemType);
    if (!dropArchetypeId) continue;
    scene.spawnItemStack(dropArchetypeId, {
      position: [transform.x, transform.y + 0.6, transform.z],
      quantity: leftover,
      velocity: [0, 1.6, 0],
      yaw: transform.yaw,
    });
  }
  const buoyancy = hull?.actor.getComponent(BUOYANCY_COMPONENT);
  if (buoyancy) removeVesselStructurePart(buoyancy, actor.id);
  scene.buildSites.remove(actor.id);
  world.removeActor(actor.id);
  if (hull && scene.buildSites.countBySurface(hull.actorId) === 0) {
    // 空船没有意义：根节点看不见，留着只是一个悬在水面上的可驾驶点。
    const control = hull.actor.getComponent(ACTOR_CONTROL_COMPONENT);
    if (control?.ownerPlayerId) scene.releaseActorControl(control.ownerPlayerId, hull.actorId);
    world.removeActorTree(hull.actorId);
  }
  world.context.refreshActorColliders?.();
  return { ok: true };
}
