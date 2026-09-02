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

const DEFAULT_TIMESTEP = 1 / 20;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value, fallback) {
  return Math.max(0.0001, finite(value, fallback));
}

function yawQuaternion(yaw) {
  // simpleCollision uses the inverse sign of Rapier's conventional positive Y rotation.
  const half = -finite(yaw) * 0.5;
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
  #characterColliderHandles = new Set();
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
        .setCollisionGroups(colliderInteractionGroups(1)),
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
    this.#characterColliderHandles.add(collider.handle);
    this.#queriesDirty = true;
    return character;
  }

  removeCharacter(id) {
    const character = this.#characters.get(id);
    if (!character) return false;
    character.controller.free();
    this.#characterColliderHandles.delete(character.collider.handle);
    if (character.body.isValid()) this.#world.removeRigidBody(character.body);
    this.#characters.delete(id);
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
    const body = this.#world.createRigidBody(
      this.#rapier.RigidBodyDesc.dynamic()
        .setTranslation(finite(options.x), finite(options.y), finite(options.z))
        .setLinearDamping(Math.max(0, finite(options.linearDamping, 1.8)))
        .setAngularDamping(Math.max(0, finite(options.angularDamping, 2))),
    );
    const collider = this.#world.createCollider(
      this.#rapier.ColliderDesc.ball(positive(options.radius, 0.28))
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

  getDynamicActorState(id) {
    const entry = this.#dynamicActors.get(id);
    if (!entry) return undefined;
    const position = entry.body.translation();
    const velocity = entry.body.linvel();
    return { position: { ...position }, velocity: { ...velocity } };
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
      (collider) => !this.#characterColliderHandles.has(collider.handle),
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
    this.#characterColliderHandles.clear();
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
    const yaw = finite(definition?.yaw);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const centerX = finite(definition?.centerX);
    const centerZ = finite(definition?.centerZ);
    descriptor.setTranslation(
      finite(definition?.x) + cosYaw * centerX + sinYaw * centerZ,
      finite(definition?.y) + minimumY + halfHeight,
      finite(definition?.z) - sinYaw * centerX + cosYaw * centerZ,
    );
    descriptor.setRotation(yawQuaternion(yaw));
    descriptor.setFriction(0);
    descriptor.setCollisionGroups(colliderInteractionGroups(definition?.layers));
    return descriptor;
  }

  #assertAlive() {
    if (this.#disposed) throw new Error('PhysicsWorld has been disposed.');
  }
}
