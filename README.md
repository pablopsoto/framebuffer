# Framebuffer

Fifty years of real-time graphics, redrawn live in your browser. One small valley scene is rendered again and again with each era's technique: vector beams, 8-bit tiles, Mode 7, PlayStation wobble, shaders, PBR, ray tracing and Gaussian splats. No game screenshots or assets: every technique is recreated from scratch.

**Live:** https://framebuffer.pablopsoto.dev

## How it's made

three.js on WebGL2, with one renderer per era sharing the same procedural world (`src/chapters/`). Served from a Cloudflare Worker with static assets.

## Run it

```sh
npm install
npm run dev
npm run deploy
```

---

Designed and built by Pablo Pérez — [@pablopsoto](https://www.instagram.com/pablopsoto/)
