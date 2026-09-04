import assert from 'node:assert/strict';
import test from 'node:test';
import { BuildController, type BuildPort } from '../src/controllers/BuildController.ts';
import type { BuildCommand } from '../src/network/messages.ts';
import type { BuildPreviewState } from '../src/render/RenderScene.ts';
import type { ActorArchetypeDefinition } from '../src/scenes/data/SceneDefinition.ts';
import type { BuildCellStatus, BuildHullCandidate } from '../src/scene/SceneVisualSystem.ts';
import { PlayerInputTags } from '../src/input/config/playerInput.ts';
import type { TagLike } from '../src/tags/index.ts';
import {
  BUILD_REJECTION_LABELS,
  BuildSiteIndex,
  createHullBuildGrid,
} from '../shared/build/index.mjs';

const HULL_GRID = createHullBuildGrid({
  cellSize: 2, columns: 0, rows: 0, deckHeight: 0.16, extentCells: 6, maxPieces: 48,
});

const FLOAT_FOUNDATION = {
  schemaVersion: 1,
  id: 'float-foundation',
  components: {
    buildPiece: {
      kind: 'foundation', surface: 'floating', label: '水上地基', reach: 6,
      cost: [{ itemType: 'wood', quantity: 2 }], mass: 8, buoyancy: 30, hull: 'float-hull',
    },
    render: {
      model: 'line-art-build-foundation', size: 2, thickness: 0.16,
      plankColor: '#dfc99f', accentColor: '#c99f72', inkColor: '#51463e',
    },
  },
} as ActorArchetypeDefinition;

const WOOD_WALL = {
  schemaVersion: 1,
  id: 'wood-wall',
  components: {
    buildPiece: {
      kind: 'wall', surface: 'static', label: '木墙', reach: 6,
      cost: [{ itemType: 'wood', quantity: 2 }], mass: 0, buoyancy: 0,
    },
    render: {
      model: 'line-art-build-wall', width: 2, height: 1.5, thickness: 0.18,
      color: '#d6bea3', accentColor: '#b98558', inkColor: '#51463e',
    },
  },
} as ActorArchetypeDefinition;

/** 只实现 BuildController 用到的那两个成员：绑定放置键、读开关。 */
function createFakeInput() {
  const bindings = new Map<TagLike, Array<() => void>>();
  return {
    enabled: true,
    bind(tag: TagLike, handler: () => void) {
      const handlers = bindings.get(tag) ?? [];
      handlers.push(handler);
      bindings.set(tag, handlers);
      return () => {};
    },
    /** 按下某个键；没绑过这个键就什么都不发生。 */
    press(tag: TagLike) {
      for (const handler of bindings.get(tag) ?? []) handler();
    },
    boundTags() {
      return [...bindings.keys()];
    },
  };
}

/** 默认用主键放置：建造是「对着指针指的地方干这一下」。 */
function click(input: ReturnType<typeof createFakeInput>): void {
  input.press(PlayerInputTags.Primary);
}

const FRAME = {
  position: [0, 2, 0] as const,
  axes: { forward: [0, -1, 0] as const },
} as never;

interface HarnessOptions {
  point?: { x: number; y: number; z: number };
  hulls?: BuildHullCandidate[];
  sites?: BuildSiteIndex;
  cellStatus?: BuildCellStatus;
  hasLand?: boolean;
  blocked?: boolean;
  position?: { x: number; z: number };
  wood?: number;
  piece?: { actorId: string; label: string; x: number; y: number; z: number };
}

function harness(options: HarnessOptions = {}) {
  const input = createFakeInput();
  const previews: Array<BuildPreviewState | undefined> = [];
  const prompts: Array<string | undefined> = [];
  const hovered: Array<string | undefined> = [];
  const sent: BuildCommand[] = [];
  const port: BuildPort = {
    getPlayerPosition: () => options.position ?? { x: 0, z: 0 },
    pointerRay: () => undefined,
    pickPoint: () => options.point ?? { x: 1.2, y: 0, z: 0.7 },
    listHulls: () => options.hulls ?? [],
    hullGridOf: (id) => (id === 'float-hull' ? HULL_GRID : undefined),
    getSites: () => options.sites,
    foundationTop: () => undefined,
    hasLand: () => options.hasLand ?? true,
    cellStatus: () => options.cellStatus ?? 'water',
    groundTop: () => 0.5,
    seaLevel: () => -0.4,
    isBlocked: () => options.blocked ?? false,
    getInventory: () => ({ quantityOf: () => options.wood ?? 10 }),
    findPieceNear: () => options.piece,
    getInputLabel: () => 'E',
    setHoveredActorId: (actorId) => hovered.push(actorId),
    setPreview: (state) => previews.push(state),
    setPrompt: (text) => prompts.push(text),
    send: (command) => sent.push(command),
  };
  const controller = new BuildController(input as never, port);
  return { controller, input, previews, prompts, hovered, sent };
}

test('没有船可吸附的水上地基：幽灵落在世界格中心，按下交互键就在那一格立船', () => {
  const { controller, input, previews, prompts, sent } = harness({ point: { x: 1.2, y: 0, z: 0.7 } });
  controller.setSelection({ kind: 'piece', archetype: FLOAT_FOUNDATION });
  controller.update(FRAME);
  const preview = previews.at(-1)!;
  assert.equal(preview.pieceId, 'float-foundation');
  assert.equal(preview.valid, true);
  assert.deepEqual([preview.x, preview.z], [1, 1], '吸附到格 (0,0) 的中心');
  assert.ok(Math.abs(preview.y - (-0.4)) < 1e-9, '板底贴着这张图的水面');
  assert.match(prompts.at(-1)!, /立一艘船/);
  assert.deepEqual(sent, [], '没按键不发');

  click(input);
  controller.update(FRAME);
  assert.deepEqual(sent, [{
    kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX: 0, cellZ: 0,
  }], '立船的报文不带 hullActorId');
});

test('水上地基指在陆地上：幽灵变红、提示要放在水里、按键不发', () => {
  const { controller, input, previews, prompts, sent } = harness({ cellStatus: 'land' });
  controller.setSelection({ kind: 'piece', archetype: FLOAT_FOUNDATION });
  click(input);
  controller.update(FRAME);
  assert.equal(previews.at(-1)!.valid, false);
  assert.equal(prompts.at(-1), BUILD_REJECTION_LABELS['needs-water']);
  assert.deepEqual(sent, []);
});

test('指到已有的船上就吸到那艘船的格上，报文带 hullActorId 与船体格坐标', () => {
  const sites = new BuildSiteIndex();
  sites.add({ actorId: 'root', surfaceKey: 'hull-1', kind: 'foundation', cellX: 0, cellZ: 0 });
  const hull: BuildHullCandidate = { actorId: 'hull-1', x: 10, y: -0.4, z: 4, yaw: 0, grid: HULL_GRID };
  const { controller, input, previews, sent } = harness({
    point: { x: 12.3, y: 0, z: 4.1 },
    hulls: [hull],
    sites,
    position: { x: 11, z: 4 },
  });
  controller.setSelection({ kind: 'piece', archetype: FLOAT_FOUNDATION });
  click(input);
  controller.update(FRAME);
  const preview = previews.at(-1)!;
  assert.equal(preview.valid, true);
  assert.deepEqual([preview.x, preview.z], [12, 4]);
  assert.ok(Math.abs(preview.y - (-0.4)) < 1e-9, '船的高度加上本地高度');
  assert.deepEqual(sent, [{
    kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: 'hull-1', cellX: 1, cellZ: 0,
  }]);
});

test('静态墙吸到最近的格边并带上边名；被人挡住时提示挡住', () => {
  const { controller, input, previews, sent } = harness({
    point: { x: 5.2, y: 0.5, z: 1.9 },
    cellStatus: 'land',
  });
  controller.setSelection({ kind: 'piece', archetype: WOOD_WALL });
  click(input);
  controller.update(FRAME);
  const preview = previews.at(-1)!;
  assert.equal(preview.valid, true);
  assert.deepEqual([preview.x, preview.z, preview.yaw], [5, 2, 0], '格 (2,0) 的北边中点');
  assert.equal(preview.y, 0.5, '没有地基就落在地面上');
  assert.deepEqual(sent, [{
    kind: 'place', archetypeId: 'wood-wall', surface: 'static', cellX: 2, cellZ: 0, edge: 'north',
  }]);

  const blocked = harness({ point: { x: 5.2, y: 0.5, z: 1.9 }, cellStatus: 'land', blocked: true });
  blocked.controller.setSelection({ kind: 'piece', archetype: WOOD_WALL });
  click(blocked.input);
  blocked.controller.update(FRAME);
  assert.equal(blocked.previews.at(-1)!.valid, false);
  assert.equal(blocked.prompts.at(-1), BUILD_REJECTION_LABELS.blocked);
  assert.deepEqual(blocked.sent, []);
});

test('材料不够时幽灵变红并说缺材料；太远时说太远', () => {
  const poor = harness({ cellStatus: 'land', wood: 1 });
  poor.controller.setSelection({ kind: 'piece', archetype: WOOD_WALL });
  poor.controller.update(FRAME);
  assert.equal(poor.prompts.at(-1), BUILD_REJECTION_LABELS.materials);

  const far = harness({ cellStatus: 'land', position: { x: 40, z: 40 } });
  far.controller.setSelection({ kind: 'piece', archetype: WOOD_WALL });
  far.controller.update(FRAME);
  assert.equal(far.prompts.at(-1), BUILD_REJECTION_LABELS.reach);
});

test('拆除模式：指着谁就高亮谁，按键发拆除报文', () => {
  const { controller, input, previews, hovered, prompts, sent } = harness({
    piece: { actorId: 'build-3', label: '木墙', x: 1, y: 0, z: 1 },
  });
  controller.setSelection({ kind: 'remove' });
  controller.update(FRAME);
  assert.equal(previews.at(-1), undefined, '拆除没有幽灵');
  assert.equal(hovered.at(-1), 'build-3');
  assert.match(prompts.at(-1)!, /拆除「木墙」/);
  click(input);
  controller.update(FRAME);
  assert.deepEqual(sent, [{ kind: 'remove', actorId: 'build-3' }]);
});

test('主键和交互键都能放：鼠标点一下、触屏那颗按钮各走一条，但都只放一件', () => {
  const withPrimary = harness();
  withPrimary.controller.setSelection({ kind: 'piece', archetype: FLOAT_FOUNDATION });
  withPrimary.input.press(PlayerInputTags.Primary);
  withPrimary.controller.update(FRAME);
  assert.equal(withPrimary.sent.length, 1, '主键放一件');

  const withInteract = harness();
  withInteract.controller.setSelection({ kind: 'piece', archetype: FLOAT_FOUNDATION });
  withInteract.input.press(PlayerInputTags.WorldInteract);
  withInteract.controller.update(FRAME);
  assert.equal(withInteract.sent.length, 1, '触屏 / 手柄那颗键也放一件');

  // 同一帧两个键都按下也只放一件：请求是一个布尔，不是计数。
  const both = harness();
  both.controller.setSelection({ kind: 'piece', archetype: FLOAT_FOUNDATION });
  both.input.press(PlayerInputTags.Primary);
  both.input.press(PlayerInputTags.WorldInteract);
  both.controller.update(FRAME);
  assert.equal(both.sent.length, 1);
  // 提示里写的是主键：鼠标在手上时那才是玩家要按的键。
  assert.match(both.prompts.at(-1)!, /^E · /, 'getInputLabel 在这个替身里对两个键都返回 E');
});

test('取消选择收起幽灵，之后每帧不再重复发「收起」', () => {
  const { controller, previews, prompts, hovered } = harness();
  controller.setSelection({ kind: 'piece', archetype: FLOAT_FOUNDATION });
  controller.update(FRAME);
  const shown = previews.length;
  controller.setSelection(undefined);
  assert.equal(previews.at(-1), undefined);
  assert.equal(prompts.at(-1), undefined);
  assert.equal(hovered.at(-1), undefined);
  const cleared = previews.length;
  assert.equal(cleared, shown + 1);
  controller.update(FRAME);
  controller.update(FRAME);
  assert.equal(previews.length, cleared, '没在画幽灵时不再每帧发一条收起');
});
