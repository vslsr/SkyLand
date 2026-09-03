import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import {
  BITE_COMPONENT,
  SOFT_BODY_DEFORMATION_COMPONENT,
} from '../../shared/actor/index.mjs';
import './initRapier.mjs';

/** 可控时钟：自己上报的那份形变要过超时，得能把时间推着走。 */
function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) { current += seconds * 1000; },
  };
}

async function createSoftBodyScene(clock) {
  const catalog = await SceneCatalog.load();
  // pbf-slime 才是软体：普通球形玩家原型没有 softBodyDeformation，也就没有形变。
  return new ServerScene(catalog.require('pbf-slime-test'), { now: clock.now });
}

const CONTACT = { contactX: 0, contactY: 0.9, contactZ: 0.1 };

function readDrag(scene, playerId) {
  return scene.createSnapshot().players.find((player) => player.id === playerId)?.slimeDrag;
}

test('自己上报的形变只被净化转发：换抓取时递增 revision，超时后自动清除', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });
  const spawnX = scene.createSnapshot().players[0].x;

  assert.equal(readDrag(scene, 'player-1'), undefined, '没有拖拽时不应下发字段');

  scene.applySlimeDrag('player-1', { ...CONTACT, pullX: 0.4, pullY: 0.2, pullZ: 0 });
  assert.deepEqual(readDrag(scene, 'player-1'), {
    revision: 1, ...CONTACT, pullX: 0.4, pullY: 0.2, pullZ: 0,
  });
  assert.equal(
    scene.createSnapshot().players[0].x,
    spawnX,
    '形变是纯表现，不能移动权威坐标',
  );

  // 同一次抓取继续拉动：命中点不变，revision 必须保持，接收端才不会重置形变。
  scene.applySlimeDrag('player-1', { ...CONTACT, pullX: 0.7, pullY: 0.2, pullZ: 0 });
  assert.equal(readDrag(scene, 'player-1').revision, 1);
  assert.equal(readDrag(scene, 'player-1').pullX, 0.7);

  // 松手后抓到另一处：接收端需要重建影响权重，所以 revision 递增。
  scene.applySlimeDrag('player-1', {
    contactX: 0.6, contactY: 0.4, contactZ: 0.1, pullX: 0.1, pullY: 0, pullZ: 0,
  });
  assert.equal(readDrag(scene, 'player-1').revision, 2);

  // 越界与非法数值整体作废，不能把畸形负载转发给其他客户端。
  scene.applySlimeDrag('player-1', {
    contactX: 0, contactY: Number.NaN, contactZ: 0, pullX: 0, pullY: 0, pullZ: 0,
  });
  assert.equal(readDrag(scene, 'player-1'), undefined);
  scene.applySlimeDrag('player-1', {
    contactX: 0, contactY: 1e9, contactZ: 0, pullX: 0, pullY: 0, pullZ: 0,
  });
  assert.equal(readDrag(scene, 'player-1').contactY, 4, '超界坐标被夹到允许的最大本地偏移');

  // 客户端掉线或漏发松手时，形变不能永远留在快照里。
  clock.advance(2);
  assert.equal(readDrag(scene, 'player-1'), undefined);
});

/**
 * 把两名玩家摆成面对面，相距 distance 米。
 *
 * 位置要同时落到 Actor Transform 和角色刚体上，否则 KCC 还停在出生点，缰绳
 * 算的是一处、人走的是另一处。场景原点有布景占着，所以基准点选在空地上。
 */
const FIELD_X = 4;
const FIELD_Z = 4;

function place(scene, actor, x, z) {
  actor.setPosition(x, z, actor.y);
  actor.characterState.x = x;
  actor.characterState.z = z;
  scene.physics.setCharacterTranslation(actor.id, actor.characterState);
}

function faceOff(scene, distance) {
  const biter = scene.players.get('biter');
  const victim = scene.players.get('victim');
  place(scene, biter, FIELD_X, FIELD_Z);
  biter.yaw = 0;
  place(scene, victim, FIELD_X, FIELD_Z + distance);
  victim.yaw = Math.PI;
  return { biter, victim };
}

/** 推进若干 tick，每个 tick 给两边各发一条输入。真实客户端原地不动也照发。 */
function advance(scene, clock, ticks, moves) {
  for (let index = 0; index < ticks; index += 1) {
    for (const [id, move] of Object.entries(moves)) {
      scene.applyInput(id, {
        inputs: [{
          tick: index + 1, move, sprint: move.sprint === true, jump: false, yaw: 0,
        }],
      });
    }
    clock.advance(0.05);
    scene.update();
  }
}

test('咬住只在服务端留下关系与缰绳：形状一个数都不下发', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'biter', name: '咬人的', slot: 0 });
  scene.addPlayer({ id: 'victim', name: '被咬的', slot: 1 });
  const { biter, victim } = faceOff(scene, 1.2);
  const deformation = victim.requireComponent(SOFT_BODY_DEFORMATION_COMPONENT);

  assert.equal(scene.toggleBite('biter'), true);
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, 'victim');
  assert.equal(deformation.sourceId, 'biter');
  assert.equal(deformation.heldExternally, true);

  // 关于「咬」过网络的只有这一个离散状态。尖长什么样由各客户端按两边位置自己算，
  // 服务端算一遍再下发既多占带宽，画面上还比位置慢一个快照。
  assert.equal(scene.createSnapshot().players.find((p) => p.id === 'biter').bitingPlayerId, 'victim');
  assert.equal(readDrag(scene, 'victim'), undefined, '被咬住不下发形状，只有自己的鼠标拖拽才下发');
  assert.equal(readDrag(scene, 'biter'), undefined);

  // 缰绳照旧：它是玩法，共享固定步两侧都要跑同一份。
  const leash = scene.createSnapshot().players.find((p) => p.id === 'victim').leash;
  assert.ok(leash, '被拴住的一方要下发缰绳');
  assert.ok(Math.abs(leash.anchorZ - biter.z) < 0.5, '锚点是咬人者的位置');

  // 咬着的时候，被咬者自己上报的鼠标拖拽让位：一块外壳只有一个来源。
  scene.applySlimeDrag('victim', { ...CONTACT, pullX: 0.9, pullY: 0, pullZ: 0 });
  assert.equal(deformation.sourceId, 'biter');
  assert.equal(readDrag(scene, 'victim'), undefined);

  assert.equal(scene.toggleBite('biter'), true, '再按一次松口');
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, null);
  assert.equal(deformation.active, false);
  assert.equal(scene.createSnapshot().players.find((p) => p.id === 'biter').bitingPlayerId, undefined);
});

test('够不着、背对着、已经被咬着都咬不上；拉太远自动脱口', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'biter', name: '咬人的', slot: 0 });
  scene.addPlayer({ id: 'victim', name: '被咬的', slot: 1 });
  const { biter, victim } = faceOff(scene, 6);
  assert.equal(scene.toggleBite('biter'), false, '够不着');

  faceOff(scene, 1.2);
  biter.yaw = Math.PI;
  assert.equal(scene.toggleBite('biter'), false, '背对着咬不到');

  biter.yaw = 0;
  assert.equal(scene.toggleBite('biter'), true);
  scene.addPlayer({ id: 'other', name: '第三个', slot: 2 });
  const other = scene.players.get('other');
  place(scene, other, FIELD_X, FIELD_Z + 1.2);
  other.yaw = 0;
  assert.equal(scene.toggleBite('other'), false, '已经被别人咬着的不接受第二张嘴');

  // 瞬移着走远：超过 breakDistance 就自动脱口。正常走开时缰绳会把人拖着跟上，
  // 所以这条兜底针对的是传送、被地形卡住这类拖不动的情况。
  place(scene, biter, FIELD_X, FIELD_Z - 20);
  scene.update();
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, null);
  assert.equal(
    victim.requireComponent(SOFT_BODY_DEFORMATION_COMPONENT).active,
    false,
  );
  assert.equal(readDrag(scene, 'victim'), undefined);
});

test('咬住的人被缰绳越拉越紧地限制在原地附近', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'biter', name: '咬人的', slot: 0 });
  scene.addPlayer({ id: 'victim', name: '被咬的', slot: 1 });
  const { biter, victim } = faceOff(scene, 1.2);

  // 先量一次没被咬时能跑多远，作为对照。
  const freeStart = victim.z;
  advance(scene, clock, 40, { victim: { x: 0, z: 1, sprint: true } });
  const free = victim.z - freeStart;
  assert.ok(free > 3, `没被咬时应该跑得掉，实际只走了 ${free}`);

  faceOff(scene, 1.2);
  assert.equal(scene.toggleBite('biter'), true);
  const leash = scene.createSnapshot().players.find((p) => p.id === 'victim').leash;
  assert.ok(leash, '被拴住的一方要下发缰绳，客户端预测得用同一份');
  assert.ok(Math.abs(leash.anchorZ - biter.z) < 0.5, '锚点是咬人者的位置');

  const leashedStart = victim.z;
  advance(scene, clock, 40, {
    biter: { x: 0, z: 0 },
    victim: { x: 0, z: 1, sprint: true },
  });
  const leashed = victim.z - leashedStart;
  assert.ok(leashed > 0, '绳长以内还是能动的，不是被钉死');
  assert.ok(leashed < free * 0.6, `缰绳应该明显限制活动范围：自由 ${free}，被拴 ${leashed}`);

  // 越走越拉不动：再跑同样久，几乎推不出去了；而且是停在绳边上，不是来回荡。
  const settled = victim.z;
  advance(scene, clock, 40, {
    biter: { x: 0, z: 0 },
    victim: { x: 0, z: 1, sprint: true },
  });
  assert.ok(
    Math.abs(victim.z - settled) < 0.05,
    `拉力应该越来越大直到停住，实际又走了 ${victim.z - settled}`,
  );
});

test('咬着的时候可以把人拖走：拖拽的力压过被咬者自己的移动', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'biter', name: '咬人的', slot: 0 });
  scene.addPlayer({ id: 'victim', name: '被咬的', slot: 1 });
  const { biter, victim } = faceOff(scene, 1.2);
  assert.equal(scene.toggleBite('biter'), true);

  // 咬人者往后走，被咬者朝反方向全力挣扎。
  const biterStart = biter.z;
  const victimStart = victim.z;
  advance(scene, clock, 120, {
    biter: { x: 0, z: -1 },
    victim: { x: 0, z: 1 },
  });
  const towed = victimStart - victim.z;
  const walked = biterStart - biter.z;
  assert.ok(walked > 3, `咬人者应该走得动，实际 ${walked}`);
  assert.ok(
    towed > walked * 0.6,
    `挣扎也该被拖着走：咬人者 ${walked}，被咬者只跟了 ${towed}`,
  );
  assert.ok(
    biter.getComponent(BITE_COMPONENT).targetActorId === 'victim',
    '拖行途中不该脱口',
  );

  // 缰绳带上了咬人者的速度，客户端预测才知道自己正被拖着走。
  const leash = scene.createSnapshot().players.find((p) => p.id === 'victim').leash;
  assert.ok(leash.anchorVelocityZ < -1, `锚点速度要下发，实际 ${leash.anchorVelocityZ}`);
});

test('被咬的人离开房间，咬着他的那张嘴也松开', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'biter', name: '咬人的', slot: 0 });
  scene.addPlayer({ id: 'victim', name: '被咬的', slot: 1 });
  faceOff(scene, 1.2);
  assert.equal(scene.toggleBite('biter'), true);

  scene.removePlayer('victim');
  scene.update();
  const biter = scene.players.get('biter');
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, null);
  // 松开之后还能再咬下一个人，状态没有卡住。
  scene.addPlayer({ id: 'victim-2', name: '下一个', slot: 2 });
  const next = scene.players.get('victim-2');
  place(scene, next, FIELD_X, FIELD_Z + 1.2);
  assert.equal(scene.toggleBite('biter'), true);
});
