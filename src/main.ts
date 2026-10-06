import './style.css';
import { createBit16 } from './chapters/bit16';
import { createBit8 } from './chapters/bit8';
import { createPbr } from './chapters/pbr';
import { createPsx } from './chapters/psx';
import { createRaytrace } from './chapters/raytrace';
import { createSixth } from './chapters/sixth';
import { createSplats } from './chapters/splats';
import { createVector } from './chapters/vector';
import { Engine, isWebGL2, type Chapter, type Layer, type Region } from './engine';
import { createDock } from './ui/dock';

const CHAPTERS: Chapter[] = [createVector(), createBit8(), createBit16(), createPsx(), createSixth(), createPbr(), createRaytrace(), createSplats()];
const byId = new Map(CHAPTERS.map((c) => [c.id, c]));

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hero = document.getElementById('hero')!;
const sections = [...document.querySelectorAll<HTMLElement>('section.chapter')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

if (!isWebGL2()) {
  document.documentElement.classList.add('no-gl');
} else {
  start();
}

function start() {
  const engine = new Engine(canvas);
  const dock = createDock(document.getElementById('dock')!);
  const ready = new Set<Chapter>();
  const update = () => (engine.frozen = reduced.matches);
  reduced.addEventListener('change', update);
  update();
  // A still from a little way into the flight, for reduced motion.
  engine.time = 4;

  /** Chapters set up one per frame, so the first frame isn't held up by all eight. */
  function available(c: Chapter) {
    if (ready.has(c)) return true;
    if (pending) return false;
    pending = true;
    engine.use(c);
    ready.add(c);
    return true;
  }
  let pending = false;

  function frame(now: number) {
    requestAnimationFrame(frame);
    pending = false;
    engine.tick(now);
    const vh = innerHeight;
    const layers: Layer[] = [];
    const span = (el: HTMLElement): Region | null => {
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh) return null;
      return { x0: 0, x1: 1, y0: 1 - Math.min(r.bottom, vh) / vh, y1: 1 - Math.max(r.top, 0) / vh };
    };

    // The hero shows every era side by side, in strips.
    const h = span(hero);
    if (h) {
      CHAPTERS.forEach((c, i) => {
        const region = { ...h, x0: i / CHAPTERS.length, x1: (i + 1) / CHAPTERS.length };
        if (available(c)) layers.push({ texture: c.render(engine, region), region, gaps: true });
      });
    }
    let active: { chapter: Chapter; section: HTMLElement; share: number } | null = null;
    for (const s of sections) {
      const region = span(s);
      if (!region) continue;
      const c = byId.get(s.dataset.chapter!)!;
      const share = region.y1 - region.y0;
      if (!active || share > active.share) active = { chapter: c, section: s, share };
      if (!available(c)) continue;
      const top = s.getBoundingClientRect().top;
      layers.push({ texture: c.render(engine, region), region, beam: top > 0 && top < vh });
    }
    engine.present(layers);
    if (import.meta.env.DEV) (window as unknown as { __layers: unknown }).__layers = layers.map((l) => ({ ...l.region, beam: l.beam }));
    const shown = active && active.share > 0.5 ? active : null;
    dock.show(shown && { chapter: shown.chapter, section: shown.section });
    if (shown) document.body.dataset.active = shown.chapter.id;
    else delete document.body.dataset.active;
  }
  requestAnimationFrame(frame);
}
