const FIXED_STEP_SECONDS = 1 / 60;
const MAX_FRAME_SECONDS = 0.05;
const MAX_STEPS_PER_FRAME = 3;
const MAX_PARTICLE_SPEED_RADIUS_RATIO = 4;
const PLANAR_CENTER_RECENTER_RATE = 24;

export interface PbfSlimeSimulationOptions {
  particleCount: number;
  radius: number;
  gravity: number;
  centerForce: number;
  viscosity: number;
  constraintIterations: number;
  seed: number;
}

export interface PbfSlimeSimulationStats {
  readonly particleCount: number;
  readonly connectedComponentCount: number;
  readonly largestComponentSize: number;
  readonly neighborChecks: number;
}

function hashCell(x: number, y: number, z: number): number {
  return (
    Math.imul(x, 73_856_093)
    ^ Math.imul(y, 19_349_663)
    ^ Math.imul(z, 83_492_791)
  ) >>> 0;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function clampMagnitude(x: number, y: number, z: number, maximum: number): [number, number, number] {
  const lengthSquared = x * x + y * y + z * z;
  if (lengthSquared <= maximum * maximum || lengthSquared <= 1e-12) return [x, y, z];
  const scale = maximum / Math.sqrt(lengthSquared);
  return [x * scale, y * scale, z * scale];
}

/**
 * 有硬上限的客户端 PBF 内核。
 *
 * 粒子只驱动 visualRoot 下的外壳，不参与权威 Transform、碰撞或网络快照。邻域查询
 * 使用粒子半径尺度的空间哈希，因此每步成本由粒子数和固定的 27 个相邻栅格限定，
 * 不随场景或大世界尺寸增长。
 */
export class PbfSlimeSimulation {
  public readonly positions: Float32Array;
  public readonly particleShellRadius: number;
  /** 表面重建使用与 PBF 邻域相同的 Poly6 支撑半径。 */
  public readonly surfaceKernelRadius: number;
  public readonly center = new Float32Array(3);
  public connectedComponentCount = 1;
  public largestComponentSize: number;
  public neighborChecks = 0;

  private readonly velocities: Float32Array;
  private readonly velocityScratch: Float32Array;
  private readonly predicted: Float32Array;
  private readonly corrections: Float32Array;
  private readonly lambdas: Float32Array;
  private readonly componentIds: Int16Array;
  private readonly queue: Int16Array;
  private readonly componentCounts: Int16Array;
  private readonly componentCenterX: Float32Array;
  private readonly componentCenterY: Float32Array;
  private readonly componentCenterZ: Float32Array;
  private readonly grid = new Map<number, number[]>();
  private readonly bucketPool: number[][] = [];
  private readonly supportRadius: number;
  private readonly supportRadiusSquared: number;
  private readonly floorY: number;
  private readonly restDensity: number;
  private accumulator = 0;

  public constructor(private readonly options: PbfSlimeSimulationOptions) {
    const count = Math.max(16, Math.min(192, Math.round(options.particleCount)));
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.velocityScratch = new Float32Array(count * 3);
    this.predicted = new Float32Array(count * 3);
    this.corrections = new Float32Array(count * 3);
    this.lambdas = new Float32Array(count);
    this.componentIds = new Int16Array(count);
    this.queue = new Int16Array(count);
    this.componentCounts = new Int16Array(count);
    this.componentCenterX = new Float32Array(count);
    this.componentCenterY = new Float32Array(count);
    this.componentCenterZ = new Float32Array(count);
    this.largestComponentSize = count;
    this.supportRadius = options.radius * 0.48;
    this.supportRadiusSquared = this.supportRadius * this.supportRadius;
    this.surfaceKernelRadius = this.supportRadius;
    this.particleShellRadius = options.radius * 0.205;
    this.floorY = options.radius * 0.075;
    this.initializeParticles(options.seed);
    this.predicted.set(this.positions);
    this.updateCenter();
    this.buildGrid(this.positions);
    this.restDensity = Math.max(1e-4, this.measureAverageDensity(this.positions));
    this.segmentConnectedComponents(FIXED_STEP_SECONDS);
  }

  public get particleCount(): number {
    return this.positions.length / 3;
  }

  public update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    this.accumulator += Math.min(deltaSeconds, MAX_FRAME_SECONDS);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
      this.step(FIXED_STEP_SECONDS);
      this.accumulator -= FIXED_STEP_SECONDS;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = Math.min(this.accumulator, FIXED_STEP_SECONDS);
  }

  public stats(): PbfSlimeSimulationStats {
    return {
      particleCount: this.particleCount,
      connectedComponentCount: this.connectedComponentCount,
      largestComponentSize: this.largestComponentSize,
      neighborChecks: this.neighborChecks,
    };
  }

  /** 结构适应结束后清掉残余动量，下一次变化必须由新的外部碰撞触发。 */
  public sleep(): void {
    this.velocities.fill(0);
    this.velocityScratch.fill(0);
    this.predicted.set(this.positions);
    this.accumulator = 0;
  }

  /**
   * 外部碰撞发生时给上层流体一股局部冲击。底层粒子权重更低，形成黏地的压缩/回弹；
   * 普通移动不会调用它，因此冻结后的结构不会自行抖动。
   */
  public applyCollisionImpulse(impulseX: number, impulseZ: number): void {
    if (!Number.isFinite(impulseX) || !Number.isFinite(impulseZ)) return;
    const [limitedX, , limitedZ] = clampMagnitude(
      impulseX,
      0,
      impulseZ,
      this.options.radius * 1.4,
    );
    for (let offset = 0; offset < this.velocities.length; offset += 3) {
      const normalizedHeight = Math.max(0, Math.min(
        1,
        (this.positions[offset + 1] - this.floorY) / (this.options.radius * 0.72),
      ));
      const adhesionWeight = 0.16 + normalizedHeight * normalizedHeight * 0.84;
      this.velocities[offset] += limitedX * adhesionWeight;
      this.velocities[offset + 2] += limitedZ * adhesionWeight;
    }
  }

  private initializeParticles(seed: number): void {
    const random = createRandom(seed);
    const radius = this.options.radius;
    const centerY = radius * 0.39;
    let centerX = 0;
    let centerZ = 0;
    for (let index = 0; index < this.particleCount; index += 1) {
      // 体积均匀采样一个略扁的椭球；中心力和密度约束会在前几步消除随机噪声。
      const radial = Math.cbrt((index + 0.45) / this.particleCount);
      const yDirection = 1 - 2 * random();
      const longitude = random() * Math.PI * 2;
      const planar = Math.sqrt(Math.max(0, 1 - yDirection * yDirection));
      const offset = index * 3;
      this.positions[offset] = Math.cos(longitude) * planar * radial * radius * 0.64;
      this.positions[offset + 1] = Math.max(
        this.floorY,
        centerY + yDirection * radial * radius * 0.32,
      );
      this.positions[offset + 2] = Math.sin(longitude) * planar * radial * radius * 0.64;
      centerX += this.positions[offset];
      centerZ += this.positions[offset + 2];
    }
    centerX /= this.particleCount;
    centerZ /= this.particleCount;
    for (let offset = 0; offset < this.positions.length; offset += 3) {
      this.positions[offset] -= centerX;
      this.positions[offset + 2] -= centerZ;
    }
  }

  private step(deltaSeconds: number): void {
    this.neighborChecks = 0;
    this.applyForcesAndPredict(deltaSeconds);
    for (let iteration = 0; iteration < this.options.constraintIterations; iteration += 1) {
      this.solveDensityConstraints();
    }
    this.updateVelocities(deltaSeconds);
    this.positions.set(this.predicted);
    this.updateCenter();
    this.recenterPlanarSimulationWindow(deltaSeconds);
    this.applyViscosity(deltaSeconds);
    this.segmentConnectedComponents(deltaSeconds);
  }

  /**
   * 参考实现的 ParticleController.Center 是固定的控制器中心；粒子均值不会成为一个
   * 可以随机游走的自由刚体。低粒子版本的离散密度修正不完全守恒，因此这里把整个
   * 客户端局部模拟窗平滑拉回 Actor 原点。只平移 X/Z 且不改速度：转向惯性仍可短暂
   * 拉歪外壳，重力决定的 Y 高度也不会被抵消。
   */
  private recenterPlanarSimulationWindow(deltaSeconds: number): void {
    const amount = 1 - Math.exp(-PLANAR_CENTER_RECENTER_RATE * deltaSeconds);
    const shiftX = -this.center[0] * amount;
    const shiftZ = -this.center[2] * amount;
    if (Math.abs(shiftX) + Math.abs(shiftZ) <= 1e-9) return;
    for (let offset = 0; offset < this.positions.length; offset += 3) {
      this.positions[offset] += shiftX;
      this.positions[offset + 2] += shiftZ;
    }
    this.center[0] += shiftX;
    this.center[2] += shiftZ;
  }

  private applyForcesAndPredict(deltaSeconds: number): void {
    const radius = this.options.radius;
    const maximumCenterDistance = radius * 0.82;
    const maximumSpeed = radius * MAX_PARTICLE_SPEED_RADIUS_RATIO;
    const centerX = this.center[0];
    const centerY = this.center[1];
    const centerZ = this.center[2];
    // 低粒子客户端版本需要接近临界阻尼；参考项目用 2048 粒子和密度格，本实现只有 72 粒子。
    const controllerDampingRate = 2 * Math.sqrt(Math.max(0, this.options.centerForce));
    const controllerVelocityMix = Math.exp(-controllerDampingRate * deltaSeconds);
    for (let index = 0; index < this.particleCount; index += 1) {
      const offset = index * 3;
      const x = this.positions[offset];
      const y = this.positions[offset + 1];
      const z = this.positions[offset + 2];
      let velocityX = this.velocities[offset];
      let velocityY = this.velocities[offset + 1];
      let velocityZ = this.velocities[offset + 2];
      // 参考 ApplyForceJob 会把局部粒子速度持续混合回 controller.Velocity。
      // 本模拟位于 Actor 局部空间，控制器速度即 0；这层阻尼让空闲流体真正静止。
      velocityX *= controllerVelocityMix;
      velocityY *= controllerVelocityMix;
      velocityZ *= controllerVelocityMix;
      // 参考 ParticleController.Center：水平粒子始终回到 Actor 局部原点，防止质心随机游走。
      // Y 轴仍围绕实时质心聚合，由重力决定整团高度，避免重新锁在悬空点。
      velocityX += -x * this.options.centerForce * deltaSeconds;
      velocityY += (centerY - y) * this.options.centerForce * deltaSeconds;
      velocityZ += -z * this.options.centerForce * deltaSeconds;
      velocityY -= this.options.gravity * deltaSeconds;
      [velocityX, velocityY, velocityZ] = clampMagnitude(
        velocityX,
        velocityY,
        velocityZ,
        maximumSpeed,
      );
      this.velocities[offset] = velocityX;
      this.velocities[offset + 1] = velocityY;
      this.velocities[offset + 2] = velocityZ;

      let predictedX = x + velocityX * deltaSeconds;
      let predictedY = y + velocityY * deltaSeconds;
      let predictedZ = z + velocityZ * deltaSeconds;
      if (predictedY < this.floorY) predictedY = this.floorY;

      const centerDeltaX = predictedX - centerX;
      const centerDeltaY = predictedY - centerY;
      const centerDeltaZ = predictedZ - centerZ;
      const centerDistance = Math.hypot(centerDeltaX, centerDeltaY, centerDeltaZ);
      if (centerDistance > maximumCenterDistance) {
        const scale = maximumCenterDistance / centerDistance;
        predictedX = centerX + centerDeltaX * scale;
        predictedY = Math.max(this.floorY, centerY + centerDeltaY * scale);
        predictedZ = centerZ + centerDeltaZ * scale;
      }
      this.predicted[offset] = predictedX;
      this.predicted[offset + 1] = predictedY;
      this.predicted[offset + 2] = predictedZ;
    }
  }

  private solveDensityConstraints(): void {
    this.buildGrid(this.predicted);
    const h = this.supportRadius;
    const inverseRestDensity = 1 / this.restDensity;
    for (let index = 0; index < this.particleCount; index += 1) {
      const offset = index * 3;
      const x = this.predicted[offset];
      const y = this.predicted[offset + 1];
      const z = this.predicted[offset + 2];
      let density = 0;
      let gradientX = 0;
      let gradientY = 0;
      let gradientZ = 0;
      let gradientSquaredSum = 0;
      const cellX = Math.floor(x / h);
      const cellY = Math.floor(y / h);
      const cellZ = Math.floor(z / h);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const bucket = this.grid.get(hashCell(cellX + dx, cellY + dy, cellZ + dz));
            if (!bucket) continue;
            for (const neighbor of bucket) {
              this.neighborChecks += 1;
              const neighborOffset = neighbor * 3;
              const deltaX = x - this.predicted[neighborOffset];
              const deltaY = y - this.predicted[neighborOffset + 1];
              const deltaZ = z - this.predicted[neighborOffset + 2];
              const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
              if (distanceSquared >= this.supportRadiusSquared) continue;
              density += this.poly6(distanceSquared);
              if (neighbor === index || distanceSquared <= 1e-10) continue;
              const distance = Math.sqrt(distanceSquared);
              const gradientScale = this.spikyGradientScale(distance) * inverseRestDensity / distance;
              const gx = deltaX * gradientScale;
              const gy = deltaY * gradientScale;
              const gz = deltaZ * gradientScale;
              gradientX += gx;
              gradientY += gy;
              gradientZ += gz;
              gradientSquaredSum += gx * gx + gy * gy + gz * gz;
            }
          }
        }
      }
      gradientSquaredSum += gradientX * gradientX + gradientY * gradientY + gradientZ * gradientZ;
      const densityConstraint = Math.max(-0.12, density * inverseRestDensity - 1);
      this.lambdas[index] = -densityConstraint / (gradientSquaredSum + 0.001);
    }

    this.corrections.fill(0);
    const referenceKernel = Math.max(1e-5, this.poly6(this.supportRadiusSquared * 0.09));
    for (let index = 0; index < this.particleCount; index += 1) {
      const offset = index * 3;
      const x = this.predicted[offset];
      const y = this.predicted[offset + 1];
      const z = this.predicted[offset + 2];
      let correctionX = 0;
      let correctionY = 0;
      let correctionZ = 0;
      const cellX = Math.floor(x / h);
      const cellY = Math.floor(y / h);
      const cellZ = Math.floor(z / h);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const bucket = this.grid.get(hashCell(cellX + dx, cellY + dy, cellZ + dz));
            if (!bucket) continue;
            for (const neighbor of bucket) {
              if (neighbor === index) continue;
              const neighborOffset = neighbor * 3;
              const deltaX = x - this.predicted[neighborOffset];
              const deltaY = y - this.predicted[neighborOffset + 1];
              const deltaZ = z - this.predicted[neighborOffset + 2];
              const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
              if (distanceSquared >= this.supportRadiusSquared || distanceSquared <= 1e-10) continue;
              const distance = Math.sqrt(distanceSquared);
              const kernelRatio = this.poly6(distanceSquared) / referenceKernel;
              const tensileCorrection = -0.0018 * kernelRatio ** 4;
              const scale = (
                this.lambdas[index] + this.lambdas[neighbor] + tensileCorrection
              ) * this.spikyGradientScale(distance) * inverseRestDensity / distance;
              correctionX += deltaX * scale;
              correctionY += deltaY * scale;
              correctionZ += deltaZ * scale;
            }
          }
        }
      }
      [correctionX, correctionY, correctionZ] = clampMagnitude(
        correctionX,
        correctionY,
        correctionZ,
        this.options.radius * 0.09,
      );
      this.corrections[offset] = correctionX;
      this.corrections[offset + 1] = correctionY;
      this.corrections[offset + 2] = correctionZ;
    }

    for (let offset = 0; offset < this.predicted.length; offset += 3) {
      this.predicted[offset] += this.corrections[offset];
      this.predicted[offset + 1] = Math.max(
        this.floorY,
        this.predicted[offset + 1] + this.corrections[offset + 1],
      );
      this.predicted[offset + 2] += this.corrections[offset + 2];
    }
  }

  private updateVelocities(deltaSeconds: number): void {
    const damping = Math.exp(-0.75 * deltaSeconds);
    const groundDamping = Math.exp(-5 * deltaSeconds);
    const groundVerticalDamping = Math.exp(-9 * deltaSeconds);
    const contactEpsilon = this.options.radius * 0.002;
    const maximumSpeed = this.options.radius * MAX_PARTICLE_SPEED_RADIUS_RATIO;
    let hasGroundContact = false;
    for (let offset = 1; offset < this.predicted.length; offset += 3) {
      if (this.predicted[offset] <= this.floorY + contactEpsilon) {
        hasGroundContact = true;
        break;
      }
    }
    for (let offset = 0; offset < this.positions.length; offset += 3) {
      let velocityX = (this.predicted[offset] - this.positions[offset]) / deltaSeconds;
      let velocityY = (this.predicted[offset + 1] - this.positions[offset + 1]) / deltaSeconds;
      let velocityZ = (this.predicted[offset + 2] - this.positions[offset + 2]) / deltaSeconds;
      if (this.predicted[offset + 1] <= this.floorY + contactEpsilon) {
        if (velocityY < 0) velocityY = 0;
        velocityX *= groundDamping;
        velocityZ *= groundDamping;
      }
      if (hasGroundContact) velocityY *= groundVerticalDamping;
      [velocityX, velocityY, velocityZ] = clampMagnitude(
        velocityX * damping,
        velocityY * damping,
        velocityZ * damping,
        maximumSpeed,
      );
      this.velocities[offset] = velocityX;
      this.velocities[offset + 1] = velocityY;
      this.velocities[offset + 2] = velocityZ;
    }
  }

  private applyViscosity(deltaSeconds: number): void {
    this.buildGrid(this.positions);
    const h = this.supportRadius;
    // 参考实现按 viscosity * dt / targetDensity 混合邻居速度；这里使用归一化邻域均值。
    const mix = Math.min(0.42, Math.max(0, this.options.viscosity) * deltaSeconds * 0.3);
    for (let index = 0; index < this.particleCount; index += 1) {
      const offset = index * 3;
      const x = this.positions[offset];
      const y = this.positions[offset + 1];
      const z = this.positions[offset + 2];
      let averageX = 0;
      let averageY = 0;
      let averageZ = 0;
      let weightSum = 0;
      const cellX = Math.floor(x / h);
      const cellY = Math.floor(y / h);
      const cellZ = Math.floor(z / h);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const bucket = this.grid.get(hashCell(cellX + dx, cellY + dy, cellZ + dz));
            if (!bucket) continue;
            for (const neighbor of bucket) {
              if (neighbor === index) continue;
              const neighborOffset = neighbor * 3;
              const deltaX = x - this.positions[neighborOffset];
              const deltaY = y - this.positions[neighborOffset + 1];
              const deltaZ = z - this.positions[neighborOffset + 2];
              const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
              if (distanceSquared >= this.supportRadiusSquared) continue;
              const weight = this.poly6(distanceSquared);
              averageX += this.velocities[neighborOffset] * weight;
              averageY += this.velocities[neighborOffset + 1] * weight;
              averageZ += this.velocities[neighborOffset + 2] * weight;
              weightSum += weight;
            }
          }
        }
      }
      const inverseWeight = weightSum > 1e-6 ? 1 / weightSum : 0;
      this.velocityScratch[offset] = this.velocities[offset]
        + (averageX * inverseWeight - this.velocities[offset]) * mix;
      this.velocityScratch[offset + 1] = this.velocities[offset + 1]
        + (averageY * inverseWeight - this.velocities[offset + 1]) * mix;
      this.velocityScratch[offset + 2] = this.velocities[offset + 2]
        + (averageZ * inverseWeight - this.velocities[offset + 2]) * mix;
    }
    this.velocities.set(this.velocityScratch);
  }

  private segmentConnectedComponents(deltaSeconds: number): void {
    this.buildGrid(this.positions);
    this.componentIds.fill(-1);
    this.componentCounts.fill(0);
    this.componentCenterX.fill(0);
    this.componentCenterY.fill(0);
    this.componentCenterZ.fill(0);
    const connectionRadiusSquared = this.supportRadiusSquared * 1.32;
    let componentCount = 0;
    let largestComponentId = 0;
    let largestComponentSize = 0;
    for (let start = 0; start < this.particleCount; start += 1) {
      if (this.componentIds[start] >= 0) continue;
      let read = 0;
      let write = 0;
      this.queue[write++] = start;
      this.componentIds[start] = componentCount;
      while (read < write) {
        const index = this.queue[read++];
        const offset = index * 3;
        const x = this.positions[offset];
        const y = this.positions[offset + 1];
        const z = this.positions[offset + 2];
        this.componentCounts[componentCount] += 1;
        this.componentCenterX[componentCount] += x;
        this.componentCenterY[componentCount] += y;
        this.componentCenterZ[componentCount] += z;
        const cellX = Math.floor(x / this.supportRadius);
        const cellY = Math.floor(y / this.supportRadius);
        const cellZ = Math.floor(z / this.supportRadius);
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const bucket = this.grid.get(hashCell(cellX + dx, cellY + dy, cellZ + dz));
              if (!bucket) continue;
              for (const neighbor of bucket) {
                if (this.componentIds[neighbor] >= 0) continue;
                const neighborOffset = neighbor * 3;
                const deltaX = x - this.positions[neighborOffset];
                const deltaY = y - this.positions[neighborOffset + 1];
                const deltaZ = z - this.positions[neighborOffset + 2];
                if (deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ > connectionRadiusSquared) {
                  continue;
                }
                this.componentIds[neighbor] = componentCount;
                this.queue[write++] = neighbor;
              }
            }
          }
        }
      }
      if (write > largestComponentSize) {
        largestComponentId = componentCount;
        largestComponentSize = write;
      }
      componentCount += 1;
    }
    this.connectedComponentCount = componentCount;
    this.largestComponentSize = largestComponentSize;
    if (componentCount <= 1 || largestComponentSize <= 0) return;

    // 不创建分裂后的 Actor：次连通块只得到一股回到主块的速度，外壳仍始终是一张网格。
    const inverseCount = 1 / largestComponentSize;
    const targetX = this.componentCenterX[largestComponentId] * inverseCount;
    const targetY = this.componentCenterY[largestComponentId] * inverseCount;
    const targetZ = this.componentCenterZ[largestComponentId] * inverseCount;
    const reconnectAcceleration = this.options.centerForce * 2.4;
    for (let index = 0; index < this.particleCount; index += 1) {
      if (this.componentIds[index] === largestComponentId) continue;
      const offset = index * 3;
      const deltaX = targetX - this.positions[offset];
      const deltaY = targetY - this.positions[offset + 1];
      const deltaZ = targetZ - this.positions[offset + 2];
      const distance = Math.hypot(deltaX, deltaY, deltaZ);
      if (distance <= 1e-5) continue;
      const scale = reconnectAcceleration * deltaSeconds / distance;
      this.velocities[offset] += deltaX * scale;
      this.velocities[offset + 1] += deltaY * scale;
      this.velocities[offset + 2] += deltaZ * scale;
    }
  }

  private updateCenter(): void {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let offset = 0; offset < this.positions.length; offset += 3) {
      x += this.positions[offset];
      y += this.positions[offset + 1];
      z += this.positions[offset + 2];
    }
    const inverseCount = 1 / this.particleCount;
    this.center[0] = x * inverseCount;
    this.center[1] = y * inverseCount;
    this.center[2] = z * inverseCount;
  }

  private buildGrid(source: Float32Array): void {
    for (const bucket of this.grid.values()) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.grid.clear();
    const inverseCellSize = 1 / this.supportRadius;
    for (let index = 0; index < this.particleCount; index += 1) {
      const offset = index * 3;
      const key = hashCell(
        Math.floor(source[offset] * inverseCellSize),
        Math.floor(source[offset + 1] * inverseCellSize),
        Math.floor(source[offset + 2] * inverseCellSize),
      );
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = this.bucketPool.pop() ?? [];
        this.grid.set(key, bucket);
      }
      bucket.push(index);
    }
  }

  private measureAverageDensity(source: Float32Array): number {
    let totalDensity = 0;
    const inverseCellSize = 1 / this.supportRadius;
    for (let index = 0; index < this.particleCount; index += 1) {
      const offset = index * 3;
      const x = source[offset];
      const y = source[offset + 1];
      const z = source[offset + 2];
      const cellX = Math.floor(x * inverseCellSize);
      const cellY = Math.floor(y * inverseCellSize);
      const cellZ = Math.floor(z * inverseCellSize);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const bucket = this.grid.get(hashCell(cellX + dx, cellY + dy, cellZ + dz));
            if (!bucket) continue;
            for (const neighbor of bucket) {
              const neighborOffset = neighbor * 3;
              const deltaX = x - source[neighborOffset];
              const deltaY = y - source[neighborOffset + 1];
              const deltaZ = z - source[neighborOffset + 2];
              const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
              if (distanceSquared < this.supportRadiusSquared) totalDensity += this.poly6(distanceSquared);
            }
          }
        }
      }
    }
    return totalDensity / this.particleCount;
  }

  private poly6(distanceSquared: number): number {
    const normalized = 1 - distanceSquared / this.supportRadiusSquared;
    return normalized > 0 ? normalized * normalized * normalized : 0;
  }

  private spikyGradientScale(distance: number): number {
    const normalized = Math.max(0, 1 - distance / this.supportRadius);
    return -3 * normalized * normalized / this.supportRadius;
  }
}
