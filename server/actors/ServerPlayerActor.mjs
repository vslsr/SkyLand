import {
  Actor,
  BiteComponent,
  HEALTH_COMPONENT,
  HealthComponent,
  BuoyancyComponent,
  InventoryComponent,
  PickupDropComponent,
  PLAYER_JUMP_COMPONENT,
  PlayerJumpComponent,
  PLAYER_MOVEMENT_COMPONENT,
  PlayerMovementComponent,
  SoftBodyDeformationComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
} from '../../shared/actor/index.mjs';
import {
  createCharacterSimulationParams,
  createCharacterState,
} from '../../shared/physics/index.mjs';
import {
  INPUT_TIME_BUDGET_SECONDS,
  SIMULATION_STEP_SECONDS,
} from '../../shared/networkTuning.mjs';
import {
  GAME_ABILITY_COMPONENT,
  GameAbilityComponent,
  WaterMovementEffectController,
  createHealthAttributes,
  createPlayerMovementAttributes,
} from '../../shared/abilities/index.mjs';

/**
 * 按连接动态创建的玩家 Actor。玩家不属于场景固定 placements；其高频位置仍走
 * players 快照，以保留本地预测与和解协议。
 */
export class ServerPlayerActor extends Actor {
  constructor(player, archetype, spawn, now) {
    super(player.id, archetype.id);
    this.name = player.name;
    this.addComponent(new TransformComponent({ position: [spawn.x, spawn.y ?? 0, spawn.z], yaw: Math.PI }));
    if (archetype.components.buoyancy) {
      this.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
    }
    const movement = this.addComponent(new PlayerMovementComponent(
      archetype.components.playerMovement,
    ));
    this.addComponent(new PlayerJumpComponent(archetype.components.playerJump));
    // 玩家的 GAS 一次装齐：移动速度和生命值是同一个 AbilitySystem 上的两条属性，
    // 分成两个 Component 会让「涉水减速」和「受伤」落在不同的实体上。
    const gameAbility = this.addComponent(new GameAbilityComponent({
      attributes: [
        ...createPlayerMovementAttributes(movement.walkSpeed),
        ...(archetype.components.health
          ? createHealthAttributes(archetype.components.health.maximum)
          : []),
      ],
    }));
    // 玩家的尸体不会自己消失（`corpseSeconds` 恒为 0）：人还连着，这具身体是他
    // 变成自由视角之后仍然看得见的那一个。
    if (archetype.components.health) {
      this.addComponent(new HealthComponent({ ...archetype.components.health, corpseSeconds: 0 }));
    }
    this.waterMovementEffect = new WaterMovementEffectController(gameAbility.abilitySystem);
    // applyPlayerMovement 读取这份复用对象；每次输入只更新 GAS CurrentValue，避免热路径分配。
    this.effectiveMovement = {
      walkSpeed: movement.walkSpeed,
      sprintMultiplier: movement.sprintMultiplier,
      maximumStepHeight: movement.maximumStepHeight,
    };
    this.addComponent(new InventoryComponent(archetype.components.inventory));
    if (archetype.components.pickupDrop) {
      this.addComponent(new PickupDropComponent(archetype.components.pickupDrop));
    }
    // 软体形变与咬人都是可选能力：原型给了参数才装配，普通球形玩家不受影响。
    if (archetype.components.softBodyDeformation) {
      this.addComponent(new SoftBodyDeformationComponent(
        archetype.components.softBodyDeformation,
      ));
    }
    if (archetype.components.bite) {
      this.addComponent(new BiteComponent(archetype.components.bite));
    }
    const render = archetype.components.render;
    this.collisionRadius = render.collisionRadius ?? render.radius;
    this.collisionHeight = render.collisionHeight ?? render.radius * 2;
    this.characterState = createCharacterState({
      x: spawn.x,
      y: spawn.y ?? 0,
      z: spawn.z,
      grounded: true,
    });
    this.characterParams = createCharacterSimulationParams(player.id, movement, this.jump);
    this.speed = 0;
    this.ackTick = 0;
    this.sequence = 0;
    this.actorInteractionSequence = 0;
    this.inventoryCommandSequence = 0;
    /**
     * 当前授予的那条物品使用能力。
     *
     * `{ itemType, source, slotIndex, use, succeeded }`；没有可用的东西时是
     * undefined。授予、激活、收回都由 `ItemAbilityRuntime` 驱动，见那里的说明。
     */
    this.itemAbility = undefined;
    /** 按下使用键的权威时刻；长按倒计时只认它，不认客户端上报的时长。 */
    this.itemUseStartedAt = undefined;
    this.terrainEditSequence = 0;
    this.buildCommandSequence = 0;
    this.stepBudget = Math.floor(INPUT_TIME_BUDGET_SECONDS / SIMULATION_STEP_SECONDS);
    // 客户端静默期间由 PlayerIdleSimulation 累积、消费的补步余量与代发步号。
    this.idleStepAccumulator = 0;
    this.idleStepTick = 0;
    this.lastInputAt = now;
    // ServerScene.players 过去保存普通对象；保留可枚举坐标，兼容监控/测试里
    // 通过对象展开记录一帧位置的用法，同时实际数据仍由 Transform Component 持有。
    Object.defineProperties(this, {
      x: { enumerable: true, get: () => this.transform.x, set: (value) => this.setPosition(value, this.z) },
      y: { enumerable: true, get: () => this.transform.y },
      z: { enumerable: true, get: () => this.transform.z, set: (value) => this.setPosition(this.x, value) },
      yaw: {
        enumerable: true,
        get: () => this.transform.yaw,
        set: (value) => this.transform.setWorldTransform([this.x, this.y, this.z], value),
      },
    });
  }

  get movement() {
    return this.requireComponent(PLAYER_MOVEMENT_COMPONENT);
  }

  get gameAbility() {
    return this.requireComponent(GAME_ABILITY_COMPONENT);
  }

  /** 生命值的复制面；没配 health 的玩家原型返回 undefined。 */
  get health() {
    return this.getComponent(HEALTH_COMPONENT);
  }

  /** 死了的人不再产生任何权威改动：不移动、不交互、不建造。 */
  get dead() {
    return this.health?.dead === true;
  }

  get jump() {
    return this.requireComponent(PLAYER_JUMP_COMPONENT);
  }

  get movementForSimulation() {
    this.effectiveMovement.walkSpeed = (
      this.waterMovementEffect.moveSpeed * this.jump.horizontalControlScale
    );
    return this.effectiveMovement;
  }

  get moveSpeed() {
    return this.waterMovementEffect.moveSpeed;
  }

  get inWater() {
    return this.waterMovementEffect.inWater;
  }

  syncWaterMovementEffect(inWater) {
    return this.waterMovementEffect.sync(inWater);
  }

  get transform() {
    return this.requireComponent(TRANSFORM_COMPONENT);
  }

  get x() { return this.transform.x; }
  set x(value) { this.setPosition(value, this.z); }
  get y() { return this.transform.y; }
  get z() { return this.transform.z; }
  set z(value) { this.setPosition(this.x, value); }
  get yaw() { return this.transform.yaw; }
  set yaw(value) {
    this.transform.setWorldTransform([this.x, this.y, this.z], value);
  }

  setPosition(x, z, y = this.y) {
    this.transform.setWorldTransform([x, y, z], this.yaw);
    this.characterState.x = x;
    this.characterState.y = y;
    this.characterState.z = z;
  }

  dispose() {
    this.waterMovementEffect.dispose();
    super.dispose();
  }
}
