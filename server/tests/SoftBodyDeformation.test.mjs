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

/** 把两名玩家摆成面对面，相距 distance 米。 */
function faceOff(scene, distance) {
  const biter = scene.players.get('biter');
  const victim = scene.players.get('victim');
  biter.setPosition(0, 0, biter.y);
  biter.yaw = 0;
  victim.setPosition(0, distance, victim.y);
  victim.yaw = Math.PI;
  return { biter, victim };
}

test('咬住把形变力挂到被咬者身上，再按一次松口', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'biter', name: '咬人的', slot: 0 });
  scene.addPlayer({ id: 'victim', name: '被咬的', slot: 1 });
  const { biter, victim } = faceOff(scene, 1.2);
  const deformation = victim.requireComponent(SOFT_BODY_DEFORMATION_COMPONENT);

  assert.equal(scene.toggleBite('biter'), true);
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, 'victim');
  assert.equal(deformation.sourceId, 'biter');
  const bitten = readDrag(scene, 'victim');
  assert.ok(bitten, '被咬的一方要带上形变');
  // 命中点落在朝着咬人者的那一侧。两人面对面，被咬者正对着那张嘴，
  // 所以在他自己的本地空间里就是正前方 +Z。
  assert.ok(bitten.contactZ > 0.5, `命中点应落在正对咬人者的那一面，实际 ${bitten.contactZ}`);
  assert.ok(
    Math.abs(Math.hypot(bitten.contactX, bitten.contactZ) - 0.95) < 0.35,
    `命中点应落在外壳上而不是身体里，实际 ${bitten.contactX}, ${bitten.contactZ}`,
  );
  assert.equal(readDrag(scene, 'biter'), undefined, '咬人的一方自己不变形');
  assert.equal(scene.createSnapshot().players.find((p) => p.id === 'biter').bitingPlayerId, 'victim');

  // 位移跟着两边位姿走：咬人的一方往后退，被咬者的外壳就被拉长。
  const before = Math.hypot(bitten.pullX, bitten.pullY, bitten.pullZ);
  biter.setPosition(0, -0.5, biter.y);
  scene.update();
  const stretched = readDrag(scene, 'victim');
  assert.ok(
    Math.hypot(stretched.pullX, stretched.pullY, stretched.pullZ) > before + 0.3,
    '退后应该把外壳拉得更长',
  );
  assert.equal(stretched.revision, bitten.revision, '同一次咬住不能换抓取计数');

  // 咬着的时候，被咬者自己上报的鼠标拖拽让位：一块外壳只有一个形变来源。
  scene.applySlimeDrag('victim', { ...CONTACT, pullX: 0.9, pullY: 0, pullZ: 0 });
  assert.equal(deformation.sourceId, 'biter');
  assert.equal(readDrag(scene, 'victim').contactZ, stretched.contactZ);

  assert.equal(scene.toggleBite('biter'), true, '再按一次松口');
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, null);
  assert.equal(readDrag(scene, 'victim'), undefined);
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
  other.setPosition(0, 1.2, other.y);
  other.yaw = 0;
  assert.equal(scene.toggleBite('other'), false, '已经被别人咬着的不接受第二张嘴');

  // 咬着不放地走远：超过 breakDistance 就自动脱口，而不是把人一路拽走。
  biter.setPosition(0, -20, biter.y);
  scene.update();
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, null);
  assert.equal(
    victim.requireComponent(SOFT_BODY_DEFORMATION_COMPONENT).active,
    false,
  );
  assert.equal(readDrag(scene, 'victim'), undefined);
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
  next.setPosition(0, 1.2, next.y);
  assert.equal(scene.toggleBite('biter'), true);
});
