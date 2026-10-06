// The control dock: the live knobs of whichever era fills the screen.
import type { Chapter, Control } from '../engine';

export function createDock(root: HTMLElement) {
  const era = root.querySelector<HTMLElement>('.dock-era')!;
  const controls = root.querySelector<HTMLElement>('.dock-controls')!;
  const status = root.querySelector<HTMLElement>('.dock-status')!;
  let current: Chapter | null = null;

  function build(c: Chapter) {
    controls.replaceChildren(...c.controls.map((ctl) => control(c, ctl)));
  }

  function control(c: Chapter, ctl: Control): HTMLElement {
    const p = c.params;
    if (ctl.type === 'range') {
      const label = document.createElement('label');
      label.className = 'ctl ctl-range';
      const name = document.createElement('span');
      name.textContent = ctl.label;
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: String(ctl.min), max: String(ctl.max), step: String(ctl.step), value: String(p[ctl.key]) });
      const out = document.createElement('output');
      const show = () => (out.textContent = ctl.format ? ctl.format(Number(input.value)) : input.value);
      input.addEventListener('input', () => {
        p[ctl.key] = Number(input.value);
        show();
      });
      show();
      label.append(name, input, out);
      return label;
    }
    if (ctl.type === 'choice') {
      const group = document.createElement('div');
      group.className = 'ctl seg';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', ctl.label);
      for (const o of ctl.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = o.label;
        b.setAttribute('aria-pressed', String(p[ctl.key] === o.value));
        b.addEventListener('click', () => {
          p[ctl.key] = o.value;
          for (const x of group.children) x.setAttribute('aria-pressed', String(x === b));
        });
        group.append(b);
      }
      return group;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctl tog';
    b.textContent = ctl.label;
    b.setAttribute('aria-pressed', String(!!p[ctl.key]));
    b.addEventListener('click', () => {
      p[ctl.key] = !p[ctl.key];
      b.setAttribute('aria-pressed', String(p[ctl.key]));
    });
    return b;
  }

  return {
    show(next: { chapter: Chapter; section: HTMLElement } | null) {
      root.classList.toggle('visible', !!next);
      if (next && next.chapter !== current) {
        current = next.chapter;
        root.dataset.chapter = current.id;
        era.textContent = `${next.section.dataset.year} · ${next.section.dataset.name}`;
        build(current);
      }
      const s = current?.status?.() ?? '';
      if (status.textContent !== s) status.textContent = s;
    },
  };
}
