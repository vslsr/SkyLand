import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createLineArtLeafGeometry } from '../models/particles/lineArtLeaf';
import {
  INTERACTIVE_LEAF_FILL_FRAGMENT_SHADER,
  INTERACTIVE_LEAF_OUTLINE_FRAGMENT_SHADER,
  INTERACTIVE_LEAF_VERTEX_SHADER,
} from '../shaders/interactiveLeafParticles';
import type {
  InteractiveParticleEffect,
  InteractiveParticleImpulse,
} from './InteractiveParticleEffect';

const MAX_PARTICLE_COUNT = 512;
const MAX_FRAME_DELTA_SECONDS = 0.1;
const MAX_SIMULATION_STEP_SECONDS = 1 / 60;
const MAX_SWEEP_DISTANCE_RADIUS_RATIO = 5;
const GROUND_HEIGHT = 0.035;
const GRAVITY = -2.35;
const AIR_DRAG = 1.05;
const GROUND_FRICTION = 7.5;
const GROUND_ROTATION_RATE = 10;
const EDGE_RETURN_STRENGTH = 1.8;
const BASE_FLAT_QUATERNION = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 1, 0),
);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export interface LineArtLeafParticleEffectOptions {
  particleCount: number;
  radius: number;
  seed: number;
  fillColor: THREE.ColorRepresentation;
  accentColor: THREE.ColorRepresentation;
  lineColor: THREE.ColorRepresentation;
  environment: FillMaterialEnvironment;
}

export interface LineArtLeafParticleState {
  positionX: number;
  positionY: number;
  positionZ: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  active: boolean;
}

interface ParticleAttributes {
  position: THREE.InstancedBufferAttribute;
  quaternion: THREE.InstancedBufferAttribute;
  scale: THREE.InstancedBufferAttribute;
  phase: THREE.InstancedBufferAttribute;
  tone: THREE.InstancedBufferAttribute;
  airborne: THREE.InstancedBufferAttribute;
}

/**
 * 固定容量的客户端线稿落叶场。CPU 只模拟被踢起或仍在下落的叶片，GPU 用两个
 * 实例化 pass 绘制填充和轮廓，因此成本不会随世界面积或行走距离增长。
 */
export class LineArtLeafParticleEffect implements InteractiveParticleEffect {
  public readonly root = new THREE.Group();
  public readonly particleCount: number;
  public readonly radius: number;

  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly quaternions: Float32Array;
  private readonly flatQuaternions: Float32Array;
  private readonly angularVelocities: Float32Array;
  private readonly scales: Float32Array;
  private readonly phases: Float32Array;
  private readonly tones: Float32Array;
  private readonly airborne: Float32Array;
  private readonly active: Uint8Array;
  private readonly attributes: ParticleAttributes;
  private readonly fillGeometry: THREE.InstancedBufferGeometry;
  private readonly outlineGeometry: THREE.InstancedBufferGeometry;
  private readonly fillMaterial: THREE.ShaderMaterial;
  private readonly outlineMaterial: THREE.ShaderMaterial;
  private readonly timeUniform = { value: 0 };
  private readonly localStart = new THREE.Vector3();
  private readonly localEnd = new THREE.Vector3();
  private readonly currentQuaternion = new THREE.Quaternion();
  private readonly flatQuaternion = new THREE.Quaternion();
  private readonly deltaQuaternion = new THREE.Quaternion();
  private readonly angularAxis = new THREE.Vector3();
  private disposed = false;

  public constructor(options: LineArtLeafParticleEffectOptions) {
    if (!Number.isInteger(options.particleCount)
      || options.particleCount < 1
      || options.particleCount > MAX_PARTICLE_COUNT) {
      throw new RangeError(`落叶数量必须是 1-${MAX_PARTICLE_COUNT} 的整数`);
    }
    if (!Number.isFinite(options.radius) || options.radius <= 0) {
      throw new RangeError('落叶场半径必须是正数');
    }
    this.particleCount = options.particleCount;
    this.radius = options.radius;
    this.root.name = 'line-art-leaf-particle-effect';

    this.positions = new Float32Array(this.particleCount * 3);
    this.velocities = new Float32Array(this.particleCount * 3);
    this.quaternions = new Float32Array(this.particleCount * 4);
    this.flatQuaternions = new Float32Array(this.particleCount * 4);
    this.angularVelocities = new Float32Array(this.particleCount * 3);
    this.scales = new Float32Array(this.particleCount);
    this.phases = new Float32Array(this.particleCount);
    this.tones = new Float32Array(this.particleCount);
    this.airborne = new Float32Array(this.particleCount);
    this.active = new Uint8Array(this.particleCount);
    this.initializeParticles(options.seed >>> 0);

    this.attributes = this.createParticleAttributes();
    const source = createLineArtLeafGeometry();
    const boundingRadius = this.radius * 1.35 + 2.5;
    this.fillGeometry = createInstancedGeometry(
      source.fill,
      this.attributes,
      this.particleCount,
      boundingRadius,
    );
    this.outlineGeometry = createInstancedGeometry(
      source.outline,
      this.attributes,
      this.particleCount,
      boundingRadius,
    );
    source.fill.dispose();
    source.outline.dispose();

    // 拿到场景共享 uniform 时直接复用：天气改一次雾和光照，叶片同一帧跟上。
    const runtime = options.environment.runtime;
    const sharedUniforms = {
      uTime: this.timeUniform,
      uAmbientColor: runtime?.ambientColor ?? { value: new THREE.Color(0xffffff) },
      uFogColor: runtime?.fogColor ?? { value: new THREE.Color(options.environment.fogColor) },
      uFogNear: runtime?.fogNear ?? { value: options.environment.fogNear },
      uFogFar: runtime?.fogFar ?? { value: options.environment.fogFar },
    };
    this.fillMaterial = new THREE.ShaderMaterial({
      vertexShader: INTERACTIVE_LEAF_VERTEX_SHADER,
      fragmentShader: INTERACTIVE_LEAF_FILL_FRAGMENT_SHADER,
      uniforms: {
        ...sharedUniforms,
        uFillColor: { value: new THREE.Color(options.fillColor) },
        uAccentColor: { value: new THREE.Color(options.accentColor) },
      },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.outlineMaterial = new THREE.ShaderMaterial({
      vertexShader: INTERACTIVE_LEAF_VERTEX_SHADER,
      fragmentShader: INTERACTIVE_LEAF_OUTLINE_FRAGMENT_SHADER,
      uniforms: {
        ...sharedUniforms,
        uLineColor: { value: new THREE.Color(options.lineColor) },
      },
      depthWrite: false,
    });

    const fill = new THREE.Mesh(this.fillGeometry, this.fillMaterial);
    const outline = new THREE.LineSegments(this.outlineGeometry, this.outlineMaterial);
    fill.name = 'interactive-leaf-fill';
    outline.name = 'interactive-leaf-outline';
    fill.renderOrder = 0;
    outline.renderOrder = 1;
    this.root.add(fill, outline);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.disposed) return;
    this.timeUniform.value = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;

    const frameDelta = Math.min(deltaSeconds, MAX_FRAME_DELTA_SECONDS);
    const stepCount = Math.max(1, Math.ceil(frameDelta / MAX_SIMULATION_STEP_SECONDS));
    const stepDelta = frameDelta / stepCount;
    let changed = false;
    for (let step = 0; step < stepCount; step += 1) {
      changed = this.simulate(stepDelta, this.timeUniform.value) || changed;
    }
    if (changed) this.markDynamicAttributesForUpload();
  }

  public applyWorldImpulse(impulse: InteractiveParticleImpulse): number {
    if (this.disposed
      || !Number.isFinite(impulse.radius)
      || impulse.radius <= 0
      || !Number.isFinite(impulse.strength)
      || impulse.strength <= 0) {
      return 0;
    }

    this.root.updateWorldMatrix(true, false);
    this.localStart.set(
      impulse.startPosition.x,
      impulse.startPosition.y,
      impulse.startPosition.z,
    );
    this.localEnd.set(impulse.position.x, impulse.position.y, impulse.position.z);
    this.root.worldToLocal(this.localStart);
    this.root.worldToLocal(this.localEnd);

    let segmentX = this.localEnd.x - this.localStart.x;
    let segmentZ = this.localEnd.z - this.localStart.z;
    const segmentLength = Math.hypot(segmentX, segmentZ);
    if (segmentLength > impulse.radius * MAX_SWEEP_DISTANCE_RADIUS_RATIO) {
      this.localStart.copy(this.localEnd);
      segmentX = 0;
      segmentZ = 0;
    }
    const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
    const movementLength = Math.sqrt(segmentLengthSq);
    const movementDirectionX = movementLength > 0.000_01 ? segmentX / movementLength : 0;
    const movementDirectionZ = movementLength > 0.000_01 ? segmentZ / movementLength : 0;
    const radiusSq = impulse.radius * impulse.radius;
    const strength = Math.min(20, impulse.strength);
    let affected = 0;

    for (let index = 0; index < this.particleCount; index += 1) {
      const positionOffset = index * 3;
      const particleX = this.positions[positionOffset];
      const particleZ = this.positions[positionOffset + 2];
      const projection = segmentLengthSq > 0
        ? THREE.MathUtils.clamp(
          ((particleX - this.localStart.x) * segmentX
            + (particleZ - this.localStart.z) * segmentZ) / segmentLengthSq,
          0,
          1,
        )
        : 1;
      const closestX = this.localStart.x + segmentX * projection;
      const closestZ = this.localStart.z + segmentZ * projection;
      const radialX = particleX - closestX;
      const radialZ = particleZ - closestZ;
      const distanceSq = radialX * radialX + radialZ * radialZ;
      if (distanceSq > radiusSq) continue;

      const distance = Math.sqrt(distanceSq);
      const phase = this.phases[index];
      const fallbackX = movementLength > 0.000_01 ? movementDirectionX : Math.cos(phase);
      const fallbackZ = movementLength > 0.000_01 ? movementDirectionZ : Math.sin(phase);
      const normalX = distance > 0.000_01 ? radialX / distance : fallbackX;
      const normalZ = distance > 0.000_01 ? radialZ / distance : fallbackZ;
      const falloff = Math.pow(1 - distance / impulse.radius, 2);
      const scaledStrength = strength * falloff;

      this.velocities[positionOffset] += (
        normalX * 0.8 + movementDirectionX * 0.35
      ) * scaledStrength;
      this.velocities[positionOffset + 1] += (
        0.68 + (Math.sin(phase) * 0.5 + 0.5) * 0.22
      ) * scaledStrength;
      this.velocities[positionOffset + 2] += (
        normalZ * 0.8 + movementDirectionZ * 0.35
      ) * scaledStrength;
      this.positions[positionOffset + 1] = Math.max(
        this.positions[positionOffset + 1],
        GROUND_HEIGHT + 0.006,
      );
      this.angularVelocities[positionOffset] += Math.cos(phase * 1.3) * scaledStrength * 1.4;
      this.angularVelocities[positionOffset + 1] += Math.sin(phase * 0.7) * scaledStrength;
      this.angularVelocities[positionOffset + 2] += Math.sin(phase * 1.9) * scaledStrength * 1.4;
      this.airborne[index] = Math.max(this.airborne[index], 0.8);
      this.active[index] = 1;
      affected += 1;
    }

    if (affected > 0) this.markDynamicAttributesForUpload();
    return affected;
  }

  public getParticleState(index: number): LineArtLeafParticleState {
    if (!Number.isInteger(index) || index < 0 || index >= this.particleCount) {
      throw new RangeError('落叶索引越界');
    }
    const offset = index * 3;
    return {
      positionX: this.positions[offset],
      positionY: this.positions[offset + 1],
      positionZ: this.positions[offset + 2],
      velocityX: this.velocities[offset],
      velocityY: this.velocities[offset + 1],
      velocityZ: this.velocities[offset + 2],
      active: this.active[index] === 1,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.clear();
    this.fillGeometry.dispose();
    this.outlineGeometry.dispose();
    this.fillMaterial.dispose();
    this.outlineMaterial.dispose();
  }

  private initializeParticles(seed: number): void {
    const random = createSeededRandom(seed);
    const yawQuaternion = new THREE.Quaternion();
    const flatQuaternion = new THREE.Quaternion();
    const currentQuaternion = new THREE.Quaternion();
    for (let index = 0; index < this.particleCount; index += 1) {
      const positionOffset = index * 3;
      const quaternionOffset = index * 4;
      const angle = random() * Math.PI * 2;
      const distance = this.radius * Math.sqrt(random()) * 0.96;
      const initiallyAirborne = random() < 0.22;
      this.positions[positionOffset] = Math.cos(angle) * distance;
      this.positions[positionOffset + 1] = initiallyAirborne
        ? GROUND_HEIGHT + 0.18 + random() * 1.75
        : GROUND_HEIGHT;
      this.positions[positionOffset + 2] = Math.sin(angle) * distance;
      if (initiallyAirborne) {
        this.velocities[positionOffset] = (random() - 0.42) * 0.5;
        this.velocities[positionOffset + 1] = (random() - 0.58) * 0.28;
        this.velocities[positionOffset + 2] = (random() - 0.5) * 0.42;
      }

      const yaw = random() * Math.PI * 2;
      yawQuaternion.setFromAxisAngle(Y_AXIS, yaw);
      flatQuaternion.copy(yawQuaternion).multiply(BASE_FLAT_QUATERNION).normalize();
      flatQuaternion.toArray(this.flatQuaternions, quaternionOffset);
      if (initiallyAirborne) setRandomQuaternion(currentQuaternion, random);
      else currentQuaternion.copy(flatQuaternion);
      currentQuaternion.toArray(this.quaternions, quaternionOffset);

      this.scales[index] = 0.32 + random() * 0.22;
      this.phases[index] = random() * Math.PI * 2;
      this.tones[index] = random() * 2 - 1;
      this.airborne[index] = initiallyAirborne ? 1 : 0;
      this.active[index] = initiallyAirborne ? 1 : 0;
      if (initiallyAirborne) {
        this.angularVelocities[positionOffset] = (random() - 0.5) * 4;
        this.angularVelocities[positionOffset + 1] = (random() - 0.5) * 3;
        this.angularVelocities[positionOffset + 2] = (random() - 0.5) * 4;
      }
    }
  }

  private createParticleAttributes(): ParticleAttributes {
    const position = new THREE.InstancedBufferAttribute(this.positions, 3);
    const quaternion = new THREE.InstancedBufferAttribute(this.quaternions, 4);
    const airborne = new THREE.InstancedBufferAttribute(this.airborne, 1);
    position.setUsage(THREE.DynamicDrawUsage);
    quaternion.setUsage(THREE.DynamicDrawUsage);
    airborne.setUsage(THREE.DynamicDrawUsage);
    return {
      position,
      quaternion,
      airborne,
      scale: new THREE.InstancedBufferAttribute(this.scales, 1),
      phase: new THREE.InstancedBufferAttribute(this.phases, 1),
      tone: new THREE.InstancedBufferAttribute(this.tones, 1),
    };
  }

  private simulate(deltaSeconds: number, elapsedSeconds: number): boolean {
    let changed = false;
    const maximumRadius = this.radius * 1.35;
    const airDamping = Math.exp(-AIR_DRAG * deltaSeconds);
    const groundDamping = Math.exp(-GROUND_FRICTION * deltaSeconds);
    const groundRotationAlpha = 1 - Math.exp(-GROUND_ROTATION_RATE * deltaSeconds);

    for (let index = 0; index < this.particleCount; index += 1) {
      if (this.active[index] === 0) continue;
      changed = true;
      const positionOffset = index * 3;
      const quaternionOffset = index * 4;
      const phase = this.phases[index];
      let velocityX = this.velocities[positionOffset];
      let velocityY = this.velocities[positionOffset + 1];
      let velocityZ = this.velocities[positionOffset + 2];
      const height = this.positions[positionOffset + 1] - GROUND_HEIGHT;
      if (height > 0.002 || velocityY > 0) {
        velocityX += (0.11 + Math.sin(elapsedSeconds * 0.63 + phase) * 0.18) * deltaSeconds;
        velocityZ += Math.cos(elapsedSeconds * 0.51 + phase * 1.7) * 0.16 * deltaSeconds;
        velocityY += GRAVITY * deltaSeconds;
        velocityX *= airDamping;
        velocityY *= airDamping;
        velocityZ *= airDamping;
      }

      this.positions[positionOffset] += velocityX * deltaSeconds;
      this.positions[positionOffset + 1] += velocityY * deltaSeconds;
      this.positions[positionOffset + 2] += velocityZ * deltaSeconds;

      const radialDistance = Math.hypot(
        this.positions[positionOffset],
        this.positions[positionOffset + 2],
      );
      if (radialDistance > this.radius && radialDistance > 0.000_01) {
        const normalX = this.positions[positionOffset] / radialDistance;
        const normalZ = this.positions[positionOffset + 2] / radialDistance;
        const outsideDistance = radialDistance - this.radius;
        velocityX -= normalX * outsideDistance * EDGE_RETURN_STRENGTH * deltaSeconds;
        velocityZ -= normalZ * outsideDistance * EDGE_RETURN_STRENGTH * deltaSeconds;
        if (radialDistance > maximumRadius) {
          this.positions[positionOffset] = normalX * maximumRadius;
          this.positions[positionOffset + 2] = normalZ * maximumRadius;
          const outwardVelocity = velocityX * normalX + velocityZ * normalZ;
          if (outwardVelocity > 0) {
            velocityX -= normalX * outwardVelocity * 1.4;
            velocityZ -= normalZ * outwardVelocity * 1.4;
          }
        }
      }

      let onGround = false;
      if (this.positions[positionOffset + 1] <= GROUND_HEIGHT) {
        onGround = true;
        this.positions[positionOffset + 1] = GROUND_HEIGHT;
        if (velocityY < -0.2) velocityY *= -0.14;
        else velocityY = 0;
        velocityX *= groundDamping;
        velocityZ *= groundDamping;
      }

      this.currentQuaternion.fromArray(this.quaternions, quaternionOffset);
      const angularSpeed = this.angularAxis.set(
        this.angularVelocities[positionOffset],
        this.angularVelocities[positionOffset + 1],
        this.angularVelocities[positionOffset + 2],
      ).length();
      if (angularSpeed > 0.000_01) {
        this.angularAxis.multiplyScalar(1 / angularSpeed);
        this.deltaQuaternion.setFromAxisAngle(this.angularAxis, angularSpeed * deltaSeconds);
        this.currentQuaternion.premultiply(this.deltaQuaternion).normalize();
      }
      if (onGround) {
        this.flatQuaternion.fromArray(this.flatQuaternions, quaternionOffset);
        this.currentQuaternion.slerp(this.flatQuaternion, groundRotationAlpha).normalize();
        this.angularVelocities[positionOffset] *= groundDamping;
        this.angularVelocities[positionOffset + 1] *= groundDamping;
        this.angularVelocities[positionOffset + 2] *= groundDamping;
      }
      this.currentQuaternion.toArray(this.quaternions, quaternionOffset);

      this.velocities[positionOffset] = velocityX;
      this.velocities[positionOffset + 1] = velocityY;
      this.velocities[positionOffset + 2] = velocityZ;
      this.airborne[index] = THREE.MathUtils.clamp(
        (this.positions[positionOffset + 1] - GROUND_HEIGHT) * 1.7 + Math.abs(velocityY) * 0.18,
        0,
        1,
      );

      const linearSpeedSq = velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ;
      const angularSpeedSq = (
        this.angularVelocities[positionOffset] ** 2
        + this.angularVelocities[positionOffset + 1] ** 2
        + this.angularVelocities[positionOffset + 2] ** 2
      );
      if (onGround && linearSpeedSq < 0.000_9 && angularSpeedSq < 0.0025) {
        this.velocities[positionOffset] = 0;
        this.velocities[positionOffset + 1] = 0;
        this.velocities[positionOffset + 2] = 0;
        this.angularVelocities[positionOffset] = 0;
        this.angularVelocities[positionOffset + 1] = 0;
        this.angularVelocities[positionOffset + 2] = 0;
        this.airborne[index] = 0;
        this.active[index] = 0;
      }
    }
    return changed;
  }

  private markDynamicAttributesForUpload(): void {
    this.attributes.position.needsUpdate = true;
    this.attributes.quaternion.needsUpdate = true;
    this.attributes.airborne.needsUpdate = true;
  }
}

function createInstancedGeometry(
  source: THREE.BufferGeometry,
  attributes: ParticleAttributes,
  particleCount: number,
  boundingRadius: number,
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  if (source.index) geometry.setIndex(source.index.clone());
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, attribute.clone());
  }
  geometry.setAttribute('aParticlePosition', attributes.position);
  geometry.setAttribute('aParticleQuaternion', attributes.quaternion);
  geometry.setAttribute('aParticleScale', attributes.scale);
  geometry.setAttribute('aParticlePhase', attributes.phase);
  geometry.setAttribute('aParticleTone', attributes.tone);
  geometry.setAttribute('aParticleAirborne', attributes.airborne);
  geometry.instanceCount = particleCount;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boundingRadius);
  return geometry;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function setRandomQuaternion(quaternion: THREE.Quaternion, random: () => number): void {
  const first = random();
  const second = random();
  const third = random();
  const firstRoot = Math.sqrt(1 - first);
  const secondRoot = Math.sqrt(first);
  quaternion.set(
    firstRoot * Math.sin(Math.PI * 2 * second),
    firstRoot * Math.cos(Math.PI * 2 * second),
    secondRoot * Math.sin(Math.PI * 2 * third),
    secondRoot * Math.cos(Math.PI * 2 * third),
  ).normalize();
}

export const LINE_ART_LEAF_PARTICLE_LIMITS = {
  maximumParticleCount: MAX_PARTICLE_COUNT,
  maximumSweepDistanceRadiusRatio: MAX_SWEEP_DISTANCE_RADIUS_RATIO,
} as const;
