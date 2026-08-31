import 'three';

declare module 'three' {
  /** Compatibility alias used by newer Three.js type definitions. */
  export type ColorRepresentation = Color | string | number;
}
