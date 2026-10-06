// 2013 — physically based rendering. Materials are described by measurable properties
// (base colour, roughness, metalness), lit by the environment itself, and the HDR result
// is tone-mapped down to the screen like film.
import {
  Color,
  DirectionalLight,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  type WebGLRenderTarget,
} from 'three';
import { fullscreen, type Chapter, type Engine, type Region } from '../engine';
import { Bloom, GLSL_TONEMAP } from '../post';
import { shipGeometry } from '../ship';
import { skyDome } from '../sky';
import { TerrainGrid } from '../terrain';
import { GLSL_WORLD, SUN, WATER } from '../world';

const SKY = (disc: boolean) => /* glsl */ `
${GLSL_WORLD}
varying vec3 vDir;
void main() { gl_FragColor = vec4(skyColor(normalize(vDir), ${disc}), 1.0); }
`;

const TONEMAPS = { aces: 0, agx: 1, none: 2 } as const;

const POST = fullscreen(
  /* glsl */ `
  ${GLSL_TONEMAP}
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uExposure;
  uniform int uTonemap;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * 0.12;
    c *= uExposure;
    if (uTonemap == 0) c = acesFilmic(c);
    else if (uTonemap == 1) c = agx(c);
    gl_FragColor = vec4(srgb(c), 1.0);
  }`,
  { tScene: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uTonemap: { value: 0 } },
);

export function createPbr(): Chapter {
  const params = { roughness: 0.3, metalness: 0.85, tonemap: 'aces' };
  let e: Engine;
  let hdr: WebGLRenderTarget;
  let out: WebGLRenderTarget;
  let bloom: Bloom;
  let grid: TerrainGrid;
  let ship: Mesh;
  let water: Mesh;
  let sun: DirectionalLight;
  const scene = new Scene();
  const hull = new MeshPhysicalMaterial({ color: new Color(0.75, 0.74, 0.72), clearcoat: 0.5, clearcoatRoughness: 0.15 });

  return {
    id: 'pbr',
    params,
    controls: [
      { type: 'range', key: 'roughness', label: 'Roughness', min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
      { type: 'range', key: 'metalness', label: 'Metalness', min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
      {
        type: 'choice',
        key: 'tonemap',
        label: 'Tone mapping',
        options: [
          { value: 'aces', label: 'ACES' },
          { value: 'agx', label: 'AgX' },
          { value: 'none', label: 'Clip' },
        ],
      },
    ],
    init(engine) {
      e = engine;
      const r = e.renderer;
      r.shadowMap.enabled = true;
      r.shadowMap.type = PCFShadowMap;
      hdr = e.target(1, { depthBuffer: true, samples: 4 });
      out = e.target(1);
      bloom = new Bloom(e);

      // Image-based lighting: the sky, pre-filtered for every roughness.
      const envScene = new Scene();
      envScene.add(skyDome(SKY(false)));
      const pmrem = new PMREMGenerator(r);
      scene.environment = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
      pmrem.dispose();

      grid = new TerrainGrid({ cell: 1.6, halfWidth: 90, ahead: 220, behind: 12, colors: true });
      const terrain = new Mesh(grid.geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
      terrain.frustumCulled = false;
      terrain.receiveShadow = terrain.castShadow = true;
      ship = new Mesh(shipGeometry(), [
        hull,
        new MeshPhysicalMaterial({ color: new Color(0.01, 0.015, 0.02), roughness: 0.05, clearcoat: 1 }),
        new MeshStandardMaterial({ color: 0x000000, emissive: new Color(1, 0.45, 0.15), emissiveIntensity: 14 }),
      ]);
      ship.matrixAutoUpdate = false;
      ship.castShadow = ship.receiveShadow = true;
      water = new Mesh(
        new PlaneGeometry(500, 500).rotateX(-Math.PI / 2),
        new MeshStandardMaterial({ color: new Color(0.01, 0.025, 0.03), roughness: 0.04 }),
      );
      water.receiveShadow = true;

      sun = new DirectionalLight(new Color(1, 0.72, 0.48), 3.4);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.04;
      Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 260 });
      sun.shadow.camera.updateProjectionMatrix();
      scene.add(skyDome(SKY(true)), terrain, water, ship, sun, sun.target);
    },
    render(_e, region: Region) {
      const f = e.flight;
      grid.update(f.camera.position.x, f.camera.position.z);
      ship.matrix.copy(f.matrix);
      ship.matrixWorldNeedsUpdate = true;
      water.position.set(f.camera.position.x, WATER, f.camera.position.z - 200);
      // The shadow frustum rides along, centred a little ahead of the ship.
      sun.target.position.set(f.ship.x, 0, f.ship.z - 25);
      sun.position.copy(sun.target.position).addScaledVector(SUN, 120);
      hull.roughness = params.roughness;
      hull.metalness = params.metalness;
      e.renderer.setClearColor(0x000000, 1);
      e.draw(scene, f.camera, hdr, region);
      const glow = bloom.render(hdr.texture, region, 2.0);
      const u = POST.uniforms;
      u.tScene.value = hdr.texture;
      u.tBloom.value = glow;
      u.uTonemap.value = TONEMAPS[params.tonemap as keyof typeof TONEMAPS];
      u.uExposure.value = params.tonemap === 'none' ? 0.9 : 1.15;
      e.quad(POST, out, region);
      return out.texture;
    },
  };
}
