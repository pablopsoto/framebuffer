import { Color, LinearSRGBColorSpace } from 'three';

/** A colour taken at face value: for shaders that work in display space. */
export const raw = (hex: string) => new Color().setStyle(hex, LinearSRGBColorSpace);
