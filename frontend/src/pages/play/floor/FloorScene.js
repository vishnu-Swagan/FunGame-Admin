// Imperative three.js engine for the 3D casino floor.
// Owns the renderer, lighting, post-processing, walk controls and station
// focus logic. The React page talks to it only through the constructor
// options and the small public API at the bottom.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { buildHall, buildStation } from "./builders";
import { layoutStations } from "./catalog3d";

const EYE = 1.65;
const WALK_SPEED = 5.2;
const FOCUS_RADIUS = 4.2;

export class FloorScene {
  constructor(canvas, { quality = "auto", reducedMotion = false, onFocusStation, onActivateStation, onTick } = {}) {
    this.canvas = canvas;
    this.onFocusStation = onFocusStation || (() => {});
    this.onActivateStation = onActivateStation || (() => {});
    this.onTick = onTick || (() => {});
    this.reducedMotion = reducedMotion;
    this.disposed = false;

    const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    this.tier = quality === "auto" ? (isMobile ? "performance" : "cinema") : quality;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.tier === "cinema" ? 2 : 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = this.tier === "cinema";
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.012);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 160);
    this.camera.position.set(0, EYE, 26);
    this.yaw = 0; // camera faces -Z by default: into the hall from the entrance
    this.pitch = 0;

    this.buildLights();
    this.hall = buildHall();
    this.scene.add(this.hall.group);

    this.stations = [];
    this.stationRoot = new THREE.Group();
    this.scene.add(this.stationRoot);

    // post-processing (cinema tier only)
    if (this.tier === "cinema") {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.7, 0.9);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    // input state (written by the page / controllers)
    this.move = new THREE.Vector2(0, 0); // x = strafe, y = forward
    this.keys = new Set();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.focused = null;

    this.clock = new THREE.Clock();
    this.introT = reducedMotion ? 1 : 0;

    this.bindEvents();
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  buildLights() {
    // Night-club recipe: pools of warm light, very low ambient.
    this.scene.add(new THREE.AmbientLight(0x404860, 0.5));
    const hemi = new THREE.HemisphereLight(0x36405c, 0x1a0f14, 0.55);
    this.scene.add(hemi);

    const key = new THREE.SpotLight(0xffe0b0, 320, 40, Math.PI / 3.2, 0.7, 1.4);
    key.position.set(0, 10.5, 0);
    key.target.position.set(0, 0, 0);
    if (this.tier === "cinema") {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.0004;
    }
    this.scene.add(key, key.target);

    // pools over the districts
    const poolSpots = [
      [-19, -8, 0x9fc7ff], [19, -8, 0xffc79f], [0, -24, 0xff9fb0], [0, 14, 0x9fffd0],
    ];
    for (const [x, z, color] of poolSpots) {
      const s = new THREE.SpotLight(color, 260, 30, Math.PI / 4, 0.7, 1.5);
      s.position.set(x, 10, z);
      s.target.position.set(x, 0, z);
      this.scene.add(s, s.target);
    }
  }

  setGames(games) {
    // rebuild stations from the live catalog
    for (const s of this.stations) this.stationRoot.remove(s.group);
    this.stations = layoutStations(games).map((st) => buildStation(st));
    for (const s of this.stations) this.stationRoot.add(s.group);
  }

  bindEvents() {
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);

    this._onKey = (e) => {
      const down = e.type === "keydown";
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        if (down) this.keys.add(k); else this.keys.delete(k);
        e.preventDefault();
      }
      if (down && (k === "enter" || k === "e") && this.focused) {
        this.onActivateStation(this.focused.group.userData.station);
      }
    };
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("keyup", this._onKey);

    // drag to look, tap to focus/walk
    let dragging = false, lastX = 0, lastY = 0, downAt = 0, downPos = [0, 0];
    const el = this.canvas;
    this._onPointerDown = (e) => {
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      downAt = performance.now(); downPos = [e.clientX, e.clientY];
      el.setPointerCapture?.(e.pointerId);
    };
    this._onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.yaw -= dx * 0.0042;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0032, -0.7, 0.55);
    };
    this._onPointerUp = (e) => {
      dragging = false;
      const dt = performance.now() - downAt;
      const dist = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
      if (dt < 350 && dist < 10) this.tap(e.clientX, e.clientY);
    };
    el.addEventListener("pointerdown", this._onPointerDown);
    el.addEventListener("pointermove", this._onPointerMove);
    el.addEventListener("pointerup", this._onPointerUp);
  }

  tap(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.stationRoot.children, true);
    if (!hits.length) return;
    let obj = hits[0].object;
    while (obj && !obj.userData.station) obj = obj.parent;
    if (!obj) return;
    const station = obj.userData.station;
    if (this.focused && this.focused.group.userData.station.slug === station.slug) {
      this.onActivateStation(station); // second tap = play
    } else {
      this.walkTarget = new THREE.Vector3(obj.position.x, 0, obj.position.z);
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
  }

  frame() {
    if (this.disposed) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // cinematic entrance: crane down from above the chandelier
    if (this.introT < 1) {
      this.introT = Math.min(1, this.introT + dt / 4.5);
      const e = 1 - Math.pow(1 - this.introT, 3);
      this.camera.position.set(0, THREE.MathUtils.lerp(9.5, EYE, e), THREE.MathUtils.lerp(4, 26, e));
      this.pitch = THREE.MathUtils.lerp(-0.9, 0, e);
    } else {
      this.updateMovement(dt);
    }

    // look
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);

    // animate hall + stations
    this.hall.animate(t);
    if (!this.reducedMotion) for (const s of this.stations) s.animate(t, dt);

    // proximity focus
    let nearest = null, nd = FOCUS_RADIUS;
    for (const s of this.stations) {
      const d = Math.hypot(s.group.position.x - this.camera.position.x, s.group.position.z - this.camera.position.z);
      if (d < nd) { nd = d; nearest = s; }
    }
    if (nearest !== this.focused) {
      this.focused = nearest;
      this.onFocusStation(nearest ? nearest.group.userData.station : null);
    }

    this.onTick(t, this.camera);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  updateMovement(dt) {
    const mv = new THREE.Vector2(this.move.x, this.move.y);
    if (this.keys.has("w") || this.keys.has("arrowup")) mv.y += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) mv.y -= 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) mv.x -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) mv.x += 1;
    if (mv.lengthSq() > 1) mv.normalize();

    if (mv.lengthSq() > 0.001) {
      this.walkTarget = null;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const dx = (mv.x * cos - mv.y * sin) * WALK_SPEED * dt;
      const dz = (-mv.x * sin - mv.y * cos) * WALK_SPEED * dt;
      this.tryMove(dx, dz);
      this.bobT = (this.bobT || 0) + dt * 9;
      this.camera.position.y = EYE + Math.sin(this.bobT) * 0.035;
    } else if (this.walkTarget) {
      const to = this.walkTarget.clone().sub(this.camera.position);
      to.y = 0;
      const d = to.length();
      if (d < 2.4) this.walkTarget = null;
      else {
        to.normalize().multiplyScalar(WALK_SPEED * dt);
        this.tryMove(to.x, to.z);
        // ease the view toward the target
        const desired = Math.atan2(-to.x, -to.z);
        let diff = desired - this.yaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.yaw += diff * Math.min(1, dt * 3);
        this.bobT = (this.bobT || 0) + dt * 9;
        this.camera.position.y = EYE + Math.sin(this.bobT) * 0.035;
      }
    } else {
      this.camera.position.y += (EYE - this.camera.position.y) * 0.1;
    }
  }

  tryMove(dx, dz) {
    const b = this.hall.bounds;
    const nx = THREE.MathUtils.clamp(this.camera.position.x + dx, b.minX, b.maxX);
    const nz = THREE.MathUtils.clamp(this.camera.position.z + dz, b.minZ, b.maxZ);
    // keep out of station bodies
    for (const s of this.stations) {
      const d = Math.hypot(s.group.position.x - nx, s.group.position.z - nz);
      if (d < 2.2) return;
    }
    this.camera.position.x = nx;
    this.camera.position.z = nz;
  }

  setJoystick(x, y) {
    this.move.set(x, y);
  }

  skipIntro() {
    this.introT = 1;
    this.camera.position.set(0, EYE, 26);
    this.pitch = 0;
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("keyup", this._onKey);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.canvas.removeEventListener("pointermove", this._onPointerMove);
    this.canvas.removeEventListener("pointerup", this._onPointerUp);
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        for (const key of Object.keys(m)) m[key]?.isTexture && m[key].dispose();
        m.dispose();
      }
    });
    this.composer?.dispose?.();
    this.renderer.dispose();
  }
}
