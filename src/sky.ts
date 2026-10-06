// A sky sphere that follows the camera; the fragment shader decides what the sky looks like.
import { BackSide, Mesh, ShaderMaterial, SphereGeometry, type Camera } from 'three';
import { SUN } from './world';

export function skyDome(fragmentShader: string, uniforms: Record<string, { value: unknown }> = {}) {
  const mesh = new Mesh(
    new SphereGeometry(450, 32, 16),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: { uSun: { value: SUN }, ...uniforms },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader,
    }),
  );
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (_r, _s, camera: Camera) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
  };
  return mesh;
}
