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
    revision: 1, pinch: 0, ...CONTACT, pullX: 0.4, pullY: 0.2, pullZ: 0,
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
  // 命中点落在朝着咬人者的那一侧。坐标是**外壳坐标**：Actor 原点 + 世界轴向，
  // 不转 yaw——软体外壳本来就不跟着 Actor 转身（渲染侧把 rig 反着转了 -yaw）。
  // 咬人者摆在被咬者的 -Z 一侧，所以命中点也在 -Z。按 Actor 本地坐标算的话，
  // 这里会得到 +Z，尖就从被咬者的背面冒出来——这条断言是那个偏差的哨兵。
  assert.ok(bitten.contactZ < -0.5, `命中点应落在正对咬人者的那一面，实际 ${bitten.contactZ}`);
  assert.ok(
    Math.abs(Math.hypot(bitten.contactX, bitten.contactZ) - 0.95) < 0.35,
    `命中点应落在外壳上而不是身体里，实际 ${bitten.contactX}, ${bitten.contactZ}`,
  );
  assert.equal(readDrag(scene, 'biter'), undefined, '咬人的一方自己不变形');
  assert.equal(scene.createSnapshot().players.find((p) => p.id === 'biter').bitingPlayerId, 'victim');

  assert.equal(bitten.pinch, 1, '牙齿要在命中处捏出一个尖，而不是把整团推成圆包');
  // 咬住的当下就该看得见：那块皮已经在牙上了。1.2 m 是贴身咬，嘴（身前 0.42 m）
  // 落在被咬者的外壳里面，纯几何差向量指进身体——`gripDepth` 就是为这一段存在的。
  const grabPull = Math.hypot(bitten.pullX, bitten.pullY, bitten.pullZ);
  assert.ok(grabPull > 0.3, `咬住的当下就要捏起一块皮，实际 ${grabPull}`);
  const outwardAtGrab = bitten.pullX * bitten.contactX + bitten.pullZ * bitten.contactZ;
  assert.ok(outwardAtGrab > 0, `贴身咬也只能往外扯，不能压出一个凹包，实际 ${outwardAtGrab}`);

  // 位移跟着两边位姿走：咬人的一方往后退，被咬者的外壳就被拉长。
  place(scene, biter, FIELD_X, FIELD_Z - 1.7);
  scene.update();
  const stretched = readDrag(scene, 'victim');
  const length = Math.hypot(stretched.pullX, stretched.pullY, stretched.pullZ);
  assert.ok(length > grabPull + 0.5, `退后应该把外壳拉得更长，实际 ${length}`);
  assert.equal(stretched.revision, bitten.revision, '同一次咬住不能换抓取计数');

  // 方向必须把命中处那块皮**往外**扯。早先拿「锚点减命中点」当位移，而锚点取的
  // 是咬人者本人：他站在被咬者外壳外面没问题，一旦贴近，那个差向量就指进身体，
  // 画面上成了一个圆钝的凹包。现在锚的是嘴，并且沿法线兜了底。
  const outward = (
    stretched.pullX * stretched.contactX + stretched.pullZ * stretched.contactZ
  );
  assert.ok(outward > 0, `形变必须朝咬人者那一侧扯出去，实际点积 ${outward}`);

  // 尖端要落在牙上：命中点加位移就是那张嘴。差得远的话画面上就是一根扯向空气的
  // 刺，和「咬住」对不上。咬人者 yaw = 0，嘴在他身前 0.42 m。
  const mouthOffset = (biter.z + 0.42) - victim.z;
  assert.ok(
    Math.abs((stretched.contactZ + stretched.pullZ) - mouthOffset) < 0.12,
    `尖端应落在嘴上：命中 ${stretched.contactZ} + 位移 ${stretched.pullZ}，嘴在 ${mouthOffset}`,
  );

  // 咬着的时候，被咬者自己上报的鼠标拖拽让位：一块外壳只有一个形变来源。
  scene.applySlimeDrag('victim', { ...CONTACT, pullX: 0.9, pullY: 0, pullZ: 0 });
  assert.equal(deformation.sourceId, 'biter');
  assert.equal(readDrag(scene, 'victim').contactZ, stretched.contactZ);

  assert.equal(scene.toggleBite('biter'), true, '再按一次松口');
  assert.equal(biter.requireComponent(BITE_COMPONENT).targetActorId, null);
  assert.equal(readDrag(scene, 'victim'), undefined);
  assert.equal(scene.createSnapshot().players.find((p) => p.id === 'biter').bitingPlayerId, undefined);
});

test('咬人者从目标身上越过之后，那块皮跟着牙绕过去，尖不会指向反方向', async () => {
  const clock = createClock();
  const scene = await createSoftBodyScene(clock);
  scene.addPlayer({ id: 'biter', name: '咬人的', slot: 0 });
  scene.addPlayer({ id: 'victim', name: '被咬的', slot: 1 });
  const { biter, victim } = faceOff(scene, 1.2);
  assert.equal(scene.toggleBite('biter'), true);
  const deformation = victim.requireComponent(SOFT_BODY_DEFORMATION_COMPONENT);
  const grabbed = { contactZ: deformation.contactZ, revision: deformation.revision };
  assert.ok(grabbed.contactZ < -0.5, '咬住时命中点在咬人者那一面（-Z）');

  // 一路从被咬者身上越过去。每一步都检查形变**朝着嘴那一侧**：这条路径上
  // 「嘴 − 命中点」会从朝外翻成朝里，法线兜底砍掉朝里那一半之后，如果命中点
  // 还留在原来那一面，剩下的就只有沿旧法线的一点点——尖指向背对咬人者的方向。
  for (let step = -12; step <= 12; step += 1) {
    const offset = step * 0.2;
    place(scene, biter, FIELD_X, FIELD_Z + 1.2 + offset);
    scene.update();
    // 嘴在世界里的位置（咬人者 yaw = 0，嘴在身前 0.42 m），换算到外壳坐标。
    const mouthZ = (biter.z + 0.42) - victim.z;
    // 嘴几乎落在身体中轴上时方向本身就不稳，这几帧不做判定。
    if (Math.abs(mouthZ) < 0.25) continue;
    const alongMouth = deformation.pullZ * Math.sign(mouthZ);
    assert.ok(
      alongMouth > 0,
      `嘴在 z=${mouthZ.toFixed(2)}，位移却是 ${deformation.pullZ.toFixed(2)}（指向反方向）`,
    );
    assert.ok(
      deformation.contactZ * Math.sign(mouthZ) > 0,
      `命中点应该跟着牙挪到嘴那一面，实际 ${deformation.contactZ.toFixed(2)}`,
    );
    const outward = (
      deformation.pullX * deformation.normalX
      + deformation.pullY * deformation.normalY
      + deformation.pullZ * deformation.normalZ
    );
    assert.ok(
      outward >= deformation.gripDepth - 1e-6,
      `法线方向至少要保留抓握深度，实际 ${outward}`,
    );
  }

  // 换了一面就是换了一次抓取：接收端得据此重建影响权重，否则尖会留在旧顶点上。
  assert.ok(
    deformation.revision > grabbed.revision,
    '挪过去必须算一次新的抓取（revision 递增）',
  );
  assert.ok(deformation.gripDepth > 0, '牙齿要有抓握深度，否则贴身咬看不见');
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

  // 拖行时的形变要留在求解器的可见量程内，否则每次拖都是同一个夹死的最大拉伸。
  const drag = readDrag(scene, 'victim');
  const stretch = Math.hypot(drag.pullX, drag.pullY, drag.pullZ);
  assert.ok(stretch > 0.2, `拖行时应该看得出被扯着，实际 ${stretch}`);
  assert.ok(stretch < 1.05, `拖行形变不该顶满可见量程，实际 ${stretch}`);

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
