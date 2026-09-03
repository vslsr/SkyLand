import {
  AUTOSTEP_MAX_HEIGHT,
  AUTOSTEP_MIN_WIDTH,
  CHARACTER_OFFSET,
  MAX_SLOPE_CLIMB_ANGLE,
  MIN_SLOPE_SLIDE_ANGLE,
  SNAP_TO_GROUND_DISTANCE,
} from './characterParams.mjs';
import {
  CAMERA_QUERY_GROUPS,
  MOVEMENT_QUERY_GROUPS,
  SOLID_COLLIDER_GROUPS,
  colliderInteractionGroups,
} from './collisionGroups.mjs';
import { COLLISION_LAYER } from '../collision/collisionLayers.mjs';

const DEFAULT_TIMESTEP = 1 / 20;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value, fallback) {
  return Math.max(0.0001, finite(value, fallback));
}

/**
 * 绕 +Y 轴转 yaw 的四元数。
 *
 * 这里**不能**取反。Rapier 与 Three.js 都是右手 Y 上系，正的 Y 旋转是同一个方向：
 * 线稿物件的合批（`chunkGenerator.mjs`）与 `simpleCollision` 把局部坐标转到世界的
 * 矩阵都是 [[cos, sin], [-sin, cos]]，与这个四元数一致。取反会让 Rapier 里的盒子
 * 相对看得见的模型镜像过去——正方形足迹看不出来，长方形（比如流式世界的石头，
 * 0.48 × 0.40）会偏出最多 0.26 米，玩家被不存在的墙挡住、又能踩进石头里。
 * 同一个函数里的 centerX/centerZ 平移用的也是不取反的 +yaw。
 */
function yawQuaternion(yaw) {
  const half = finite(yaw) * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/** Rapier ownership boundary shared by browser prediction and room authority. */
export class PhysicsWorld {
  #rapier;
  #world;
  #chunks = new Map();
  #staticGroups = new Map();
  #actors = new Map();
  #dynamicActors = new Map();
  #characters = new Map();
  #proxies = new Map();
  #disposed = false;
  #queriesDirty = false;

  constructor(rapier, options = {}) {
    if (!rapier?.World || !rapier?.ColliderDesc || !rapier?.RigidBodyDesc) {
      throw new TypeError('PhysicsWorld requires an initialized Rapier runtime.');
    }
    this.#rapier = rapier;
    this.#world = new rapier.World({ x: 0, y: 0, z: 0 });
    this.#world.timestep = positive(options.timestep, DEFAULT_TIMESTEP);
  }

  get colliderCount() {
    let count = 0;
    this.#world.forEachCollider(() => { count += 1; });
    return count;
  }

  createCharacter(id, options) {
    this.#assertAlive();
    if (this.#characters.has(id)) throw new Error(`Physics character already exists: ${id}`);
    const radius = positive(options?.radius, 0.42);
    const halfHeight = positive(options?.halfHeight, radius);
    const body = this.#world.createRigidBody(
      this.#rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        finite(options?.x),
        finite(options?.y) + halfHeight + CHARACTER_OFFSET,
        finite(options?.z),
      ),
    );
    const collider = this.#world.createCollider(
      this.#rapier.ColliderDesc.cylinder(halfHeight, radius)
        .setFriction(0)
        .setCollisionGroups(colliderInteractionGroups(COLLISION_LAYER.MOVEMENT)),
      body,
    );
    const controller = this.#world.createCharacterController(CHARACTER_OFFSET);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    controller.enableAutostep(AUTOSTEP_MAX_HEIGHT, AUTOSTEP_MIN_WIDTH, false);
    controller.enableSnapToGround(SNAP_TO_GROUND_DISTANCE);
    controller.setMaxSlopeClimbAngle(MAX_SLOPE_CLIMB_ANGLE);
    controller.setMinSlopeSlideAngle(MIN_SLOPE_SLIDE_ANGLE);
    const character = { body, collider, controller, radius, halfHeight };
    this.#characters.set(id, character);
    this.#queriesDirty = true;
    return character;
  }

  removeCharacter(id) {
    const character = this.#characters.get(id);
    if (!character) return false;
    character.controller.free();
    if (character.body.isValid()) this.#world.removeRigidBody(character.body);
    this.#characters.delete(id);
    this.#queriesDirty = true;
    return true;
  }

  /**
   * 远端玩家的碰撞代理。
   *
   * 房间进程里每名玩家都是一具角色刚体，所以权威模拟中玩家本来就互相阻挡；
   * 浏览器里却只有本地玩家有角色控制器。少了别人的形体，本地预测会直接从
   * 对方身上穿过去，再被每份快照拉回来——贴身时就是持续的橡皮筋。
   *
   * 代理用运动学刚体承载与角色同形的圆柱：位置由快照插值直接写入，移动它
   * 不需要销毁重建 collider，宽相也就不必每帧重排。代理位置比权威落后一个
   * 插值延迟，所以贴身接触的预测只是近似，残差仍由和解收敛。
   *
   * @param {string} id
   * @param {{ x: number, y: number, z: number, radius: number, halfHeight: number }} options
   */
  setCharacterProxy(id, options) {
    this.#assertAlive();
    const radius = positive(options?.radius, 0.42);
    const halfHeight = positive(options?.halfHeight, radius);
    const existing = this.#proxies.get(id);
    // 半径或高度换了原型就重建，其余情况只挪位置。
    if (existing && (existing.radius !== radius || existing.halfHeight !== halfHeight)) {
      this.removeCharacterProxy(id);
    }
    const center = {
      x: finite(options?.x),
      y: finite(options?.y) + halfHeight + CHARACTER_OFFSET,
      z: finite(options?.z),
    };
    const proxy = this.#proxies.get(id) ?? this.#createCharacterProxy(id, radius, halfHeight);
    proxy.body.setTranslation(center, true);
    proxy.body.setNextKinematicTranslation(center);
    this.#world.propagateModifiedBodyPositionsToColliders();
    this.#queriesDirty = true;
    return proxy;
  }

  removeCharacterProxy(id) {
    const proxy = this.#proxies.get(id);
    if (!proxy) return false;
    if (proxy.body.isValid()) this.#world.removeRigidBody(proxy.body);
    this.#proxies.delete(id);
    this.#queriesDirty = true;
    return true;
  }

  setChunkCollider(key, mesh) {
    this.#assertAlive();
    this.removeChunkCollider(key);
    const vertices = mesh?.vertices instanceof Float32Array
      ? mesh.vertices
      : new Float32Array(mesh?.vertices ?? []);
    const indices = mesh?.indices instanceof Uint32Array
      ? mesh.indices
      : new Uint32Array(mesh?.indices ?? []);
    if (vertices.length < 9 || vertices.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0) {
      throw new RangeError('Chunk trimesh requires xyz vertices and triangle indices.');
    }
    const collider = this.#world.createCollider(
      this.#rapier.ColliderDesc.trimesh(
        vertices,
        indices,
        this.#rapier.TriMeshFlags.FIX_INTERNAL_EDGES,
      ).setCollisionGroups(SOLID_COLLIDER_GROUPS),
    );
    this.#chunks.set(key, collider);
    this.#queriesDirty = true;
    return collider.handle;
  }

  removeChunkCollider(key) {
    const collider = this.#chunks.get(key);
    if (!collider) return false;
    if (collider.isValid()) this.#world.removeCollider(collider, false);
    this.#chunks.delete(key);
    this.#queriesDirty = true;
    return true;
  }

  setStaticColliderGroup(key, definitions) {
    this.#assertAlive();
    this.removeStaticColliderGroup(key);
    const colliders = [];
    for (const definition of definitions ?? []) {
      colliders.push(this.#world.createCollider(this.#createActorDescriptor(definition)));
    }
    this.#staticGroups.set(key, colliders);
    this.#queriesDirty = true;
    return colliders.map((collider) => collider.handle);
  }

  removeStaticColliderGroup(key) {
    const colliders = this.#staticGroups.get(key);
    if (!colliders) return false;
    for (const collider of colliders) {
      if (collider.isValid()) this.#world.removeCollider(collider, false);
    }
    this.#staticGroups.delete(key);
    this.#queriesDirty = true;
    return true;
  }

  setActorCollider(id, definition) {
    this.#assertAlive();
    this.removeActorCollider(id);
    const definitions = Array.isArray(definition) ? definition : [definition];
    const colliders = definitions.map((item) => (
      this.#world.createCollider(this.#createActorDescriptor(item))
    ));
    this.#actors.set(id, colliders);
    this.#queriesDirty = true;
    return colliders.map((collider) => collider.handle);
  }

  /**
   * 只挪已有的 Actor 碰撞体，不删了重建。
   *
   * 每帧把全部 Actor 碰撞体删掉再建一遍是主线程 `sim-colliders` 那 0.5–4ms 的来源：
   * Rapier 每建一个 collider 都要进宽相，还把查询管线标脏、逼下一次查询前多跑一次
   * `world.step()`。形状没变、只是挪了位置的，改位姿就够。数量或形状变了才回落到
   * `setActorCollider` 重建。
   *
   * @returns {boolean} 挪成功；false 表示没登记过或数量不符，调用方应改走 setActorCollider。
   */
  moveActorCollider(id, definition) {
    this.#assertAlive();
    const colliders = this.#actors.get(id);
    const definitions = Array.isArray(definition) ? definition : [definition];
    if (!colliders || colliders.length !== definitions.length) return false;
    for (let index = 0; index < colliders.length; index += 1) {
      if (!colliders[index].isValid()) return false;
    }
    for (let index = 0; index < colliders.length; index += 1) {
      const pose = this.#actorColliderPose(definitions[index]);
      colliders[index].setTranslation(pose.translation);
      colliders[index].setRotation(pose.rotation);
    }
    this.#queriesDirty = true;
    return true;
  }

  removeActorCollider(id) {
    const colliders = this.#actors.get(id);
    if (!colliders) return false;
    for (const collider of colliders) {
      if (collider.isValid()) this.#world.removeCollider(collider, false);
    }
    this.#actors.delete(id);
    this.#queriesDirty = true;
    return true;
  }

  /** 为已脱离 Actor 建立真正的 Rapier 动态刚体，并返回一次性弹出冲量入口。 */
  createDynamicActor(id, options = {}) {
    this.#assertAlive();
    this.removeActorCollider(id);
    this.removeDynamicActor(id);
    const descriptor = this.#rapier.RigidBodyDesc.dynamic()
      .setTranslation(finite(options.x), finite(options.y), finite(options.z))
      .setLinearDamping(Math.max(0, finite(options.linearDamping, 1.8)))
      .setAngularDamping(Math.max(0, finite(options.angularDamping, 2)));
    // 重建一个已经躺在地上的物件时必须带回它的朝向，否则它会当场站起来。
    const rotation = options.rotation;
    if (rotation && Math.abs(Math.hypot(
      finite(rotation.x), finite(rotation.y), finite(rotation.z), finite(rotation.w),
    ) - 1) < 1e-3) {
      descriptor.setRotation({
        x: finite(rotation.x),
        y: finite(rotation.y),
        z: finite(rotation.z),
        w: finite(rotation.w, 1),
      });
    }
    const body = this.#world.createRigidBody(descriptor);
    const collider = this.#world.createCollider(
      this.#rapier.ColliderDesc.ball(positive(options.radius, 0.28))
        // 让玩法层配置的 impulse 数值可直接按约 1kg 物体理解，避免球体体积
        // 改变时同一份蘑菇弹出配置得到完全不同的初速度。
        .setMass(positive(options.mass, 1))
        .setRestitution(Math.max(0, Math.min(1, finite(options.restitution, 0.28))))
        .setFriction(Math.max(0, finite(options.friction, 0.8)))
        .setCollisionGroups(SOLID_COLLIDER_GROUPS),
      body,
    );
    this.#dynamicActors.set(id, { body, collider });
    this.#queriesDirty = true;
    return body;
  }

  hasDynamicActor(id) {
    return this.#dynamicActors.has(id);
  }

  applyDynamicActorImpulse(id, impulse) {
    const entry = this.#dynamicActors.get(id);
    if (!entry) return false;
    entry.body.applyImpulse({
      x: finite(impulse?.x), y: finite(impulse?.y), z: finite(impulse?.z),
    }, true);
    return true;
  }


  setDynamicActorTranslation(id, position) {
    const entry = this.#dynamicActors.get(id);
    if (!entry) return false;
    entry.body.setTranslation({
      x: finite(position?.x), y: finite(position?.y), z: finite(position?.z),
    }, true);
    this.#queriesDirty = true;
    return true;
  }

  setDynamicActorVelocity(id, velocity) {
    const entry = this.#dynamicActors.get(id);
    if (!entry) return false;
    entry.body.setLinvel({
      x: finite(velocity?.x), y: finite(velocity?.y), z: finite(velocity?.z),
    }, true);
    return true;
  }

  applyDynamicActorGravity(id, gravity, deltaSeconds) {
    const entry = this.#dynamicActors.get(id);
    if (!entry) return false;
    const velocity = entry.body.linvel();
    entry.body.setLinvel({
      x: velocity.x,
      y: velocity.y - Math.max(0, finite(gravity, 9.8)) * Math.max(0, finite(deltaSeconds)),
      z: velocity.z,
    }, true);
    return true;
  }

  /** 朝向和位置一样是刚体解算出来的：掉在地上的物件要能躺着，而不是永远立着。 */
  getDynamicActorState(id) {
    const entry = this.#dynamicActors.get(id);
    if (!entry) return undefined;
    const position = entry.body.translation();
    const velocity = entry.body.linvel();
    const rotation = entry.body.rotation();
    return {
      position: { ...position },
      velocity: { ...velocity },
      rotation: { ...rotation },
    };
  }

  removeDynamicActor(id) {
    const entry = this.#dynamicActors.get(id);
    if (!entry) return false;
    if (entry.body.isValid()) this.#world.removeRigidBody(entry.body);
    this.#dynamicActors.delete(id);
    this.#queriesDirty = true;
    return true;
  }

  setCharacterTranslation(id, position) {
    const character = this.#requireCharacter(id);
    const center = {
      x: finite(position?.x),
      y: finite(position?.y) + character.halfHeight + CHARACTER_OFFSET,
      z: finite(position?.z),
    };
    character.body.setTranslation(center, true);
    // position-based kinematic bodies retain their previous next target; rewinds and
    // teleports must replace both or the next step restores a stale predicted position.
    character.body.setNextKinematicTranslation(center);
    this.#world.propagateModifiedBodyPositionsToColliders();
    this.#queriesDirty = true;
  }

  getCharacterTranslation(id) {
    const character = this.#requireCharacter(id);
    const center = character.body.translation();
    return {
      x: center.x,
      y: center.y - character.halfHeight - CHARACTER_OFFSET,
      z: center.z,
    };
  }

  setCharacterSnapToGround(id, enabled) {
    const character = this.#requireCharacter(id);
    if (enabled) character.controller.enableSnapToGround(SNAP_TO_GROUND_DISTANCE);
    else character.controller.disableSnapToGround();
  }

  /**
   * 角色之间互相阻挡：这里不再排除其它角色的 collider。
   *
   * Rapier 的角色控制器在内部就排除了正在移动的那一个 collider，所以不需要
   * 自定义谓词来避免自撞；而排除**别的**角色会让玩家互相穿过去，客户端预测
   * 与服务端权威也就没法对齐。过滤只靠 MOVEMENT 层的 InteractionGroups。
   */
  computeCharacterMovement(id, desired) {
    const character = this.#requireCharacter(id);
    character.controller.computeColliderMovement(
      character.collider,
      {
        x: finite(desired?.x),
        y: finite(desired?.y),
        z: finite(desired?.z),
      },
      undefined,
      MOVEMENT_QUERY_GROUPS,
    );
    const movement = character.controller.computedMovement();
    const center = character.body.translation();
    character.body.setNextKinematicTranslation({
      x: center.x + movement.x,
      y: center.y + movement.y,
      z: center.z + movement.z,
    });
    const collisions = [];
    for (let index = 0; index < character.controller.numComputedCollisions(); index += 1) {
      const collision = character.controller.computedCollision(index);
      if (collision) collisions.push({
        normal: { ...collision.normal1 },
        movement: { ...collision.translationDeltaApplied },
      });
    }
    return {
      movement: { x: movement.x, y: movement.y, z: movement.z },
      grounded: character.controller.computedGrounded(),
      collisions,
    };
  }

  /** New colliders become query-visible here; do not remove this apparently empty tick. */
  step(timestep) {
    this.#assertAlive();
    if (timestep !== undefined) this.#world.timestep = positive(timestep, this.#world.timestep);
    this.#world.step();
    this.#queriesDirty = false;
  }

  prepareQueries() {
    if (this.#queriesDirty) this.step();
  }

  castRay(origin, direction, maximumDistance = 100) {
    this.#assertAlive();
    const ray = new this.#rapier.Ray(origin, direction);
    const hit = this.#world.castRayAndGetNormal(ray, maximumDistance, true);
    return hit ? { timeOfImpact: hit.timeOfImpact, normal: { ...hit.normal } } : undefined;
  }

  /** 沿线段扫掠球体，返回 0–1 的最早命中比例；地形与 CAMERA authoring 都参与。 */
  castCameraSphere(start, end, radius) {
    this.#assertAlive();
    this.prepareQueries();
    const delta = {
      x: finite(end?.[0]) - finite(start?.[0]),
      y: finite(end?.[1]) - finite(start?.[1]),
      z: finite(end?.[2]) - finite(start?.[2]),
    };
    const distance = Math.hypot(delta.x, delta.y, delta.z);
    if (distance <= 1e-8) return 1;
    const direction = { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance };
    const hit = this.#world.castShape(
      { x: finite(start?.[0]), y: finite(start?.[1]), z: finite(start?.[2]) },
      { x: 0, y: 0, z: 0, w: 1 },
      direction,
      new this.#rapier.Ball(Math.max(0.001, finite(radius, 0.32))),
      0,
      distance,
      true,
      undefined,
      CAMERA_QUERY_GROUPS,
    );
    const time = hit?.timeOfImpact ?? hit?.time_of_impact;
    return Number.isFinite(time) ? Math.max(0, Math.min(1, time / distance)) : 1;
  }

  /** Rapier 原生调试线；流式 collider 集合本身已有固定 keep-radius 上界。 */
  debugRender() {
    this.#assertAlive();
    this.prepareQueries();
    return this.#world.debugRender();
  }

  dispose() {
    if (this.#disposed) return;
    for (const character of this.#characters.values()) character.controller.free();
    this.#characters.clear();
    this.#proxies.clear();
    this.#chunks.clear();
    this.#staticGroups.clear();
    this.#actors.clear();
    this.#dynamicActors.clear();
    this.#world.free();
    this.#disposed = true;
  }

  #requireCharacter(id) {
    this.#assertAlive();
    const character = this.#characters.get(id);
    if (!character) throw new Error(`Unknown physics character: ${id}`);
    return character;
  }

  #createCharacterProxy(id, radius, halfHeight) {
    const body = this.#world.createRigidBody(this.#rapier.RigidBodyDesc.kinematicPositionBased());
    const collider = this.#world.createCollider(
      this.#rapier.ColliderDesc.cylinder(halfHeight, radius)
        .setFriction(0)
        // 与 createCharacter 同层：只挡移动，不参与相机遮挡。
        .setCollisionGroups(colliderInteractionGroups(COLLISION_LAYER.MOVEMENT)),
      body,
    );
    const proxy = { body, collider, radius, halfHeight };
    this.#proxies.set(id, proxy);
    return proxy;
  }

  #createActorDescriptor(definition) {
    const minimumY = finite(definition?.minimumY);
    const maximumY = Math.max(minimumY + 0.001, finite(definition?.maximumY, minimumY + 1));
    const halfHeight = (maximumY - minimumY) * 0.5;
    let descriptor;
    if (definition?.shape === 'cylinder') {
      descriptor = this.#rapier.ColliderDesc.cylinder(
        halfHeight,
        positive(Math.min(definition?.halfWidth, definition?.halfLength), 0.01),
      );
    } else {
      descriptor = this.#rapier.ColliderDesc.cuboid(
        positive(definition?.halfWidth, 0.01),
        halfHeight,
        positive(definition?.halfLength, 0.01),
      );
    }
    const pose = this.#actorColliderPose(definition);
    descriptor.setTranslation(pose.translation.x, pose.translation.y, pose.translation.z);
    descriptor.setRotation(pose.rotation);
    descriptor.setFriction(0);
    descriptor.setCollisionGroups(colliderInteractionGroups(definition?.layers));
    return descriptor;
  }

  /** 一份 Actor 碰撞定义对应的世界位姿：建碰撞体与挪碰撞体算的是同一个。 */
  #actorColliderPose(definition) {
    const minimumY = finite(definition?.minimumY);
    const maximumY = Math.max(minimumY + 0.001, finite(definition?.maximumY, minimumY + 1));
    const halfHeight = (maximumY - minimumY) * 0.5;
    const yaw = finite(definition?.yaw);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const centerX = finite(definition?.centerX);
    const centerZ = finite(definition?.centerZ);
    return {
      translation: {
        x: finite(definition?.x) + cosYaw * centerX + sinYaw * centerZ,
        y: finite(definition?.y) + minimumY + halfHeight,
        z: finite(definition?.z) - sinYaw * centerX + cosYaw * centerZ,
      },
      rotation: yawQuaternion(yaw),
    };
  }

  #assertAlive() {
    if (this.#disposed) throw new Error('PhysicsWorld has been disposed.');
  }
}
