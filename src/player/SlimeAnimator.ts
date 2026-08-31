import * as THREE from 'three';
import { PLAYER_MOVE_SPEED } from '../../shared/playerMovement.mjs';
import type { PlayerSlimeModel } from '../models/playerSlime';

const BASE_SQUASH = 0.78;

export class SlimeAnimator {
  private readonly model: PlayerSlimeModel;
  private squash = BASE_SQUASH;
  private squashVelocity = 0;
  private wobble = 0;
  private wobbleVelocity = 0;
  private tilt = 0;
  private tiltVelocity = 0;
  private pulse = 2;

  public constructor(
    model: PlayerSlimeModel,
    private readonly referenceSpeed = PLAYER_MOVE_SPEED,
  ) {
    this.model = model;
  }

  public update(deltaSeconds: number, elapsedSeconds: number, movementSpeed: number): void {
    const moving = movementSpeed > 0.08;
    if (moving) this.pulse += deltaSeconds * (2.6 + movementSpeed * 1.3);

    const breathe = 1 + Math.sin(elapsedSeconds * 1.7) * 0.03;
    const pulseSquash = moving ? 1 - 0.1 * Math.max(0, Math.sin(this.pulse - 0.9)) : 1;
    const targetSquash = BASE_SQUASH * breathe * pulseSquash;
    this.squashVelocity += (targetSquash - this.squash) * 165 * deltaSeconds;
    this.squashVelocity *= Math.exp(-6.2 * deltaSeconds);
    this.squash += this.squashVelocity * deltaSeconds;

    this.wobbleVelocity += -this.wobble * 55 * deltaSeconds;
    this.wobbleVelocity *= Math.exp(-3.4 * deltaSeconds);
    this.wobble += this.wobbleVelocity * deltaSeconds;

    const scaleY = THREE.MathUtils.clamp(this.squash, 0.45, 1.5);
    const scaleXZ = (1 / Math.sqrt(scaleY)) * (1 + this.wobble * 0.1);
    this.model.body.scale.set(scaleXZ, scaleY, scaleXZ);
    this.model.body.position.y = this.model.radius * scaleY;

    const targetTilt = Math.min(movementSpeed / Math.max(0.01, this.referenceSpeed), 1) * 0.15;
    this.tiltVelocity += (targetTilt - this.tilt) * 130 * deltaSeconds;
    this.tiltVelocity *= Math.exp(-5 * deltaSeconds);
    this.tilt += this.tiltVelocity * deltaSeconds;
    this.model.body.rotation.x = this.tilt + this.wobble * 0.35;
    this.model.body.rotation.z =
      Math.sin(elapsedSeconds * 2.1) * 0.02 +
      Math.sin(this.pulse * 0.5) * 0.035
        * Math.min(movementSpeed / Math.max(0.01, this.referenceSpeed), 1) +
      this.wobble * 0.55;

    this.deformBody(elapsedSeconds, moving ? 0.02 : 0.007, moving ? 7.5 : 1.5);
    this.animateContents(elapsedSeconds, scaleY);
  }

  private deformBody(time: number, amplitude: number, speed: number): void {
    const positions = this.model.geometry.getAttribute('position') as THREE.BufferAttribute;
    const target = positions.array as Float32Array;
    const source = this.model.originalPositions;

    for (let index = 0; index < positions.count; index += 1) {
      const offset = index * 3;
      const x = source[offset];
      const y = source[offset + 1];
      const z = source[offset + 2];
      const height = y / this.model.radius;
      const spread = 1 + 0.2 * Math.max(0, -height);
      const phase = height * 3.4 - time * speed;
      const wave = Math.sin(phase) * amplitude;
      const crossWave = Math.sin(phase + 1.7) * amplitude * 0.4;
      target[offset] = x * spread - crossWave;
      target[offset + 1] = y + Math.sin(phase * 0.8 + 0.6) * amplitude * 0.25;
      target[offset + 2] = z * spread + wave;
    }
    positions.needsUpdate = true;
  }

  private animateContents(time: number, scaleY: number): void {
    this.model.core.scale.setScalar(1 + 0.06 * Math.sin(time * 2.4 + this.pulse));
    this.model.core.position.set(
      Math.sin(time * 1.3) * 0.016,
      Math.sin(time * 1.9) * 0.02,
      Math.sin(time * 1.1) * 0.014,
    );

    for (const bubble of this.model.bubbles) {
      const progress = (time * 0.22 + bubble.phase) % 1;
      const orbitRadius = bubble.radius * (1 - progress * 0.45);
      bubble.mesh.position.set(
        Math.cos(bubble.angle) * orbitRadius,
        -this.model.radius * 0.4 + progress * this.model.radius * 0.8,
        Math.sin(bubble.angle) * orbitRadius,
      );
      bubble.mesh.scale.setScalar(0.5 + 0.5 * Math.sin(progress * Math.PI));
    }

    const shadowScale = 1 / Math.sqrt(scaleY);
    this.model.shadow.scale.set(shadowScale, shadowScale, 1);
    this.model.shadow.material.opacity = 0.1 + 0.1 / scaleY;
  }
}
