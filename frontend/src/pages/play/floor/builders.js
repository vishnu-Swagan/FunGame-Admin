// Procedural builders for the casino hall and its game stations.
// Everything is generated (canvas textures + primitives) so the floor ships
// with zero downloaded assets and first paint stays fast.

import * as THREE from "three";

/* ---------------------------------- textures --------------------------------- */

function canvasTexture(size, draw, { repeat } = {}) {
  const c = document.createElement("canvas");
  c.width = size[0];
  c.height = size[1];
  draw(c.getContext("2d"), c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

export function neonSignTexture(text, color) {
  return canvasTexture([1024, 256], (ctx, w, h) => {
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, w, h);
    ctx.font = `900 ${text.length > 12 ? 84 : 110}px "Arial Black", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = color;
    for (const blur of [60, 30, 12]) {
      ctx.shadowBlur = blur;
      ctx.fillStyle = color;
      ctx.fillText(text.toUpperCase(), w / 2, h / 2);
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text.toUpperCase(), w / 2, h / 2);
  });
}

function feltTexture(base = "#0a5c36", label = "") {
  return canvasTexture([512, 512], (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    // felt grain
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = `rgba(${Math.random() > 0.5 ? "255,255,255" : "0,0,0"},${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    ctx.strokeStyle = "rgba(255,215,120,0.55)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    if (label) {
      ctx.fillStyle = "rgba(255,225,160,0.5)";
      ctx.font = '700 44px Georgia, serif';
      ctx.textAlign = "center";
      ctx.fillText(label.toUpperCase(), w / 2, h / 2 + 14);
    }
  });
}

function marbleTexture() {
  return canvasTexture(
    [1024, 1024],
    (ctx, w, h) => {
      ctx.fillStyle = "#101216";
      ctx.fillRect(0, 0, w, h);
      // veins
      for (let i = 0; i < 42; i++) {
        ctx.strokeStyle = `rgba(${190 + Math.random() * 40},${185 + Math.random() * 40},${200},${0.03 + Math.random() * 0.07})`;
        ctx.lineWidth = 1 + Math.random() * 2.5;
        ctx.beginPath();
        let x = Math.random() * w;
        let y = Math.random() * h;
        ctx.moveTo(x, y);
        for (let s = 0; s < 26; s++) {
          x += (Math.random() - 0.5) * 130;
          y += (Math.random() - 0.5) * 130;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // gold inlay grid
      ctx.strokeStyle = "rgba(212,175,55,0.30)";
      ctx.lineWidth = 5;
      for (let g = 0; g <= w; g += 256) {
        ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(w, g); ctx.stroke();
      }
    },
    { repeat: [10, 10] }
  );
}

function carpetTexture() {
  return canvasTexture(
    [512, 512],
    (ctx, w, h) => {
      ctx.fillStyle = "#3a0d18";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(212,175,55,0.5)";
      ctx.lineWidth = 4;
      const s = 128;
      for (let y = 0; y <= h; y += s)
        for (let x = 0; x <= w; x += s) {
          ctx.beginPath();
          ctx.moveTo(x + s / 2, y);
          ctx.lineTo(x + s, y + s / 2);
          ctx.lineTo(x + s / 2, y + s);
          ctx.lineTo(x, y + s / 2);
          ctx.closePath();
          ctx.stroke();
          ctx.fillStyle = "rgba(120,20,40,0.6)";
          ctx.beginPath();
          ctx.arc(x + s / 2, y + s / 2, 12, 0, Math.PI * 2);
          ctx.fill();
        }
      for (let i = 0; i < 5000; i++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    },
    { repeat: [16, 16] }
  );
}

function rouletteWheelTexture() {
  const order = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const reds = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  return canvasTexture([1024, 1024], (ctx, w, h) => {
    const cx = w / 2, cy = h / 2, R = w / 2;
    const n = order.length, arc = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const v = order[i];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, i * arc, (i + 1) * arc);
      ctx.closePath();
      ctx.fillStyle = v === 0 ? "#0a7a3c" : reds.has(v) ? "#b3122e" : "#101014";
      ctx.fill();
      ctx.strokeStyle = "#d4af37";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(i * arc + arc / 2);
      ctx.fillStyle = "#fff";
      ctx.font = "700 40px Arial";
      ctx.textAlign = "center";
      ctx.fillText(String(v), R * 0.88, 14);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = "#2a1608";
    ctx.fill();
    ctx.strokeStyle = "#d4af37";
    ctx.lineWidth = 8;
    ctx.stroke();
  });
}

function wedgeWheelTexture(accent) {
  return canvasTexture([1024, 1024], (ctx, w, h) => {
    const cx = w / 2, cy = h / 2, R = w / 2, n = 16, arc = (Math.PI * 2) / n;
    const alt = ["#131318", accent, "#f5e6c8", accent];
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, i * arc, (i + 1) * arc);
      ctx.closePath();
      ctx.fillStyle = alt[i % alt.length];
      ctx.fill();
      ctx.strokeStyle = "#d4af37";
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(i * arc + arc / 2);
      ctx.fillStyle = i % alt.length === 2 ? "#111" : "#fff";
      ctx.font = "900 64px Arial";
      ctx.textAlign = "center";
      ctx.fillText(String(((i % 8) + 1) * 5), R * 0.72, 22);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = "#d4af37";
    ctx.fill();
  });
}

function diceFaceTexture(pips) {
  const P = {
    1: [[0.5, 0.5]],
    2: [[0.25, 0.25], [0.75, 0.75]],
    3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
    4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
    5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
    6: [[0.25, 0.22], [0.75, 0.22], [0.25, 0.5], [0.75, 0.5], [0.25, 0.78], [0.75, 0.78]],
  };
  return canvasTexture([256, 256], (ctx, w, h) => {
    ctx.fillStyle = "#f7f3e8";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#16161c";
    for (const [x, y] of P[pips]) {
      ctx.beginPath();
      ctx.arc(x * w, y * h, w * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function reelStripTexture(accent) {
  const symbols = ["7", "★", "BAR", "♦", "🍒", "Ⓙ"];
  return canvasTexture(
    [256, 1536],
    (ctx, w, h) => {
      const cell = h / symbols.length;
      symbols.forEach((s, i) => {
        ctx.fillStyle = i % 2 ? "#15151c" : "#1d1d26";
        ctx.fillRect(0, i * cell, w, cell);
        ctx.fillStyle = i === 0 ? accent : "#f5e6c8";
        ctx.font = `900 ${s.length > 1 ? 90 : 150}px Arial`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(s, w / 2, i * cell + cell / 2);
        ctx.strokeStyle = "rgba(212,175,55,0.6)";
        ctx.lineWidth = 4;
        ctx.strokeRect(4, i * cell + 4, w - 8, cell - 8);
      });
    },
    { repeat: [1, 1] }
  );
}

function cardFaceTexture(rank, suit, red) {
  return canvasTexture([256, 358], (ctx, w, h) => {
    ctx.fillStyle = "#f8f6ee";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#c9c2ae";
    ctx.lineWidth = 8;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = red ? "#c01830" : "#16161c";
    ctx.font = "900 72px Georgia";
    ctx.fillText(rank, 22, 84);
    ctx.font = "72px Georgia";
    ctx.fillText(suit, 22, 158);
    ctx.font = "170px Georgia";
    ctx.textAlign = "center";
    ctx.fillText(suit, w / 2, h / 2 + 110);
  });
}

/* --------------------------------- materials --------------------------------- */

const GOLD = () =>
  new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.95, roughness: 0.28 });
const DARKWOOD = () =>
  new THREE.MeshStandardMaterial({ color: 0x2a1608, metalness: 0.1, roughness: 0.55 });
const BLACK_GLOSS = () =>
  new THREE.MeshStandardMaterial({ color: 0x0c0c11, metalness: 0.6, roughness: 0.2 });

function emissivePlane(texture, w, h, intensity = 2.2) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: texture, transparent: false, toneMapped: false })
  );
  m.material.color.setScalar(intensity * 0.5);
  return m;
}

function makeSign(name, accent, width = 4.6) {
  const g = new THREE.Group();
  const tex = neonSignTexture(name, accent);
  const sign = emissivePlane(tex, width, width / 4, 2.6);
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.3, width / 4 + 0.3, 0.12),
    BLACK_GLOSS()
  );
  frame.position.z = -0.08;
  g.add(frame, sign);
  return g;
}

/* ----------------------------- station archetypes ----------------------------- */
// Every builder returns { group, animate(t, dt) } and keeps real lights at zero —
// glow comes from emissive surfaces + bloom, which is what mobile can afford.

function buildRoulette(st) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.0, 0.9, 32), DARKWOOD());
  base.position.y = 0.45;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.16, 16, 48), GOLD());
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.95;
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(2.3, 1.4, 0.5, 48),
    new THREE.MeshStandardMaterial({ color: 0x1c0f06, roughness: 0.4 })
  );
  bowl.position.y = 0.85;
  const wheel = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 1.9, 0.14, 64),
    [
      new THREE.MeshStandardMaterial({ color: 0x2a1608 }),
      new THREE.MeshStandardMaterial({ map: rouletteWheelTexture(), roughness: 0.35 }),
      new THREE.MeshStandardMaterial({ color: 0x2a1608 }),
    ]
  );
  wheel.position.y = 1.12;
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0xf5f5f5, metalness: 0.4, roughness: 0.15 })
  );
  ball.position.y = 1.24;
  const sign = makeSign(st.name, st.accent);
  sign.position.set(0, 3.4, 0);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8), GOLD());
  post.position.y = 2.1;
  g.add(base, rim, bowl, wheel, ball, post, sign);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return {
    group: g,
    animate(t) {
      wheel.rotation.y = t * 0.9;
      const br = 1.55 - 0.25 * (0.5 + 0.5 * Math.sin(t * 0.23));
      ball.position.set(Math.cos(-t * 2.1) * br, 1.2 + 0.03 * Math.sin(t * 9), Math.sin(-t * 2.1) * br);
      sign.rotation.y = Math.sin(t * 0.25) * 0.12;
    },
  };
}

function buildDice(st) {
  const g = new THREE.Group();
  const table = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.9, 2.6), DARKWOOD());
  table.position.y = 0.45;
  const felt = new THREE.Mesh(
    new THREE.BoxGeometry(4.1, 0.08, 2.3),
    new THREE.MeshStandardMaterial({ map: feltTexture("#0a4c63", st.name), roughness: 0.9 })
  );
  felt.position.y = 0.94;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.5, 0.12), DARKWOOD());
  wall.position.set(0, 1.15, -1.24);
  const faces = [3, 4, 1, 6, 2, 5].map(
    (n) => new THREE.MeshStandardMaterial({ map: diceFaceTexture(n), roughness: 0.35 })
  );
  const dice = [0, 1].map((i) => {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), faces);
    d.position.set(i === 0 ? -0.5 : 0.55, 1.2, i === 0 ? 0.2 : -0.25);
    g.add(d);
    return d;
  });
  const sign = makeSign(st.name, st.accent);
  sign.position.set(0, 3.1, -1.1);
  g.add(table, felt, wall, sign);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return {
    group: g,
    animate(t) {
      // roll for ~1.2s out of every 5s, then rest
      const phase = t % 5;
      dice.forEach((d, i) => {
        if (phase < 1.2) {
          const k = 1 - phase / 1.2;
          d.position.y = 1.2 + Math.abs(Math.sin(phase * 12 + i)) * 0.5 * k;
          d.rotation.x += 0.25 * k;
          d.rotation.z += 0.31 * k;
        } else {
          d.position.y += (1.16 - d.position.y) * 0.2;
          d.rotation.x -= (d.rotation.x % (Math.PI / 2)) * 0.25;
          d.rotation.z -= (d.rotation.z % (Math.PI / 2)) * 0.25;
        }
      });
    },
  };
}

function buildSlot(st) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 3.4, 1.2), BLACK_GLOSS());
  body.position.y = 1.7;
  const belly = new THREE.Mesh(
    new THREE.BoxGeometry(1.94, 0.9, 1.24),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(st.accent), metalness: 0.4, roughness: 0.3, emissive: new THREE.Color(st.accent), emissiveIntensity: 0.35 })
  );
  belly.position.y = 0.7;
  const marquee = makeSign(st.name, st.accent, 2.1);
  marquee.position.set(0, 3.75, 0.35);
  marquee.rotation.x = -0.15;
  const strip = reelStripTexture(st.accent);
  const reels = [-0.55, 0, 0.55].map((x) => {
    const r = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.46, 24),
      new THREE.MeshStandardMaterial({ map: strip, roughness: 0.4 })
    );
    r.rotation.z = Math.PI / 2;
    r.position.set(x, 2.45, 0.45);
    r.userData.speed = 0;
    g.add(r);
    return r;
  });
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 1.0),
    new THREE.MeshStandardMaterial({ color: 0x88aaff, transparent: true, opacity: 0.08, metalness: 0.9, roughness: 0.05 })
  );
  glass.position.set(0, 2.45, 0.92);
  // chase lights
  const bulbGeo = new THREE.SphereGeometry(0.045, 8, 8);
  const bulbs = [];
  for (let i = 0; i < 14; i++) {
    const b = new THREE.Mesh(
      bulbGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(st.accent), toneMapped: false })
    );
    const a = (i / 14) * Math.PI * 2;
    b.position.set(Math.cos(a) * 1.05, 3.75 + Math.sin(a) * 0.42, 0.42);
    bulbs.push(b);
    g.add(b);
  }
  g.add(body, belly, marquee, glass);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  let spinUntil = 2 + Math.random() * 4;
  return {
    group: g,
    animate(t, dt) {
      const spinning = t % 7 < 2.4;
      reels.forEach((r, i) => {
        const target = spinning ? 9 + i * 2 : 0;
        r.userData.speed += (target - r.userData.speed) * Math.min(1, dt * 3);
        r.rotation.x += r.userData.speed * dt;
      });
      bulbs.forEach((b, i) => {
        const on = Math.floor(t * 8) % 14 === i || spinning;
        b.material.color.setScalar(on ? 1 : 0.12).lerp(new THREE.Color(st.accent), 0.8);
        b.material.color.multiplyScalar(on ? 1.6 : 0.25);
      });
      void spinUntil;
    },
  };
}

function buildCards(st) {
  const g = new THREE.Group();
  // half-moon table
  const shape = new THREE.Shape();
  shape.absarc(0, 0, 2.2, 0, Math.PI, false);
  shape.lineTo(-2.2, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
  const felt = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: feltTexture("#0a5c36", st.name), roughness: 0.9 })
  );
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = 0.92;
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.35, 0.92, 32, 1, false, 0, Math.PI), DARKWOOD());
  skirt.position.y = 0.46;
  const cards = [];
  const suits = [["A", "♠", false], ["K", "♥", true], ["Q", "♦", true], ["J", "♣", false]];
  suits.forEach(([r, s, red], i) => {
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.7),
      new THREE.MeshStandardMaterial({ map: cardFaceTexture(r, s, red), roughness: 0.5, side: THREE.DoubleSide })
    );
    card.rotation.x = -Math.PI / 2;
    card.position.set(-1.1 + i * 0.75, 1.0, 0.8);
    card.userData.i = i;
    cards.push(card);
    g.add(card);
  });
  // chip stacks
  const chipColors = [0xff3355, 0x42a5ff, 0x22e0a0, 0xffcc33];
  chipColors.forEach((c, i) => {
    for (let n = 0; n < 5; n++) {
      const chip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.13, 0.035, 20),
        new THREE.MeshStandardMaterial({ color: c, roughness: 0.35 })
      );
      chip.position.set(-0.9 + i * 0.6, 0.99 + n * 0.04, 1.55);
      g.add(chip);
    }
  });
  const sign = makeSign(st.name, st.accent);
  sign.position.set(0, 3.2, -0.4);
  g.add(felt, skirt, sign);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return {
    group: g,
    animate(t) {
      cards.forEach((c) => {
        const phase = (t * 0.5 + c.userData.i * 0.6) % 4;
        const flip = phase < 0.5 ? Math.sin((phase / 0.5) * Math.PI) : 0;
        c.rotation.z = flip * Math.PI;
        c.position.y = 1.0 + flip * 0.25;
      });
    },
  };
}

function buildWheel(st) {
  const g = new THREE.Group();
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.5, 2.4, 12), GOLD());
  stand.position.y = 1.2;
  const podium = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.5, 24), DARKWOOD());
  podium.position.y = 0.25;
  const wheel = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 1.8, 0.16, 48),
    [
      GOLD(),
      new THREE.MeshStandardMaterial({ map: wedgeWheelTexture(st.accent), roughness: 0.35 }),
      new THREE.MeshStandardMaterial({ map: wedgeWheelTexture(st.accent), roughness: 0.35 }),
    ]
  );
  wheel.rotation.x = Math.PI / 2;
  wheel.rotation.z = Math.PI / 2;
  wheel.position.y = 3.0;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.09, 12, 48), GOLD());
  ring.position.y = 3.0;
  const pointer = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.4, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(st.accent), toneMapped: false })
  );
  pointer.position.set(0, 4.15, 0.1);
  pointer.rotation.x = Math.PI;
  const sign = makeSign(st.name, st.accent);
  sign.position.set(0, 5.1, 0);
  g.add(stand, podium, wheel, ring, pointer, sign);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return {
    group: g,
    animate(t) {
      // spin-up / coast / stop cycle
      const phase = t % 9;
      const speed = phase < 3 ? phase : phase < 6 ? 3 : Math.max(0, 3 - (phase - 6) * 1.5);
      wheel.rotation.y += speed * 0.02;
    },
  };
}

function buildCrash(st) {
  const g = new THREE.Group();
  // curved LED wall
  const screenTex = canvasTexture([1024, 512], (ctx, w, h) => {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#050b2e");
    grad.addColorStop(1, "#2c0b3e");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.8})`;
      ctx.fillRect(Math.random() * w, Math.random() * h * 0.7, 2, 2);
    }
    ctx.strokeStyle = "rgba(255,68,51,0.9)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(40, h - 40);
    ctx.quadraticCurveTo(w * 0.6, h - 60, w - 60, 60);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 120px Arial";
    ctx.fillText("2.47×", w * 0.62, 200);
  });
  const screen = new THREE.Mesh(
    new THREE.CylinderGeometry(7, 7, 4.2, 32, 1, true, -Math.PI / 5, (Math.PI * 2) / 5),
    new THREE.MeshBasicMaterial({ map: screenTex, side: THREE.BackSide, toneMapped: false })
  );
  screen.position.set(0, 2.6, 6.2);
  screen.material.color.setScalar(1.15);
  // little plane flying a curve
  const plane = new THREE.Group();
  const fuselage = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.8, 8),
    new THREE.MeshStandardMaterial({ color: 0xff4433, emissive: 0xff4433, emissiveIntensity: 0.8 })
  );
  fuselage.rotation.x = Math.PI / 2;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.03, 0.24), new THREE.MeshStandardMaterial({ color: 0xffe0d0 }));
  plane.add(fuselage, wing);
  // glowing trail
  const trailN = 40;
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(trailN * 3), 3));
  const trail = new THREE.Line(
    trailGeo,
    new THREE.LineBasicMaterial({ color: new THREE.Color(st.accent), transparent: true, opacity: 0.85, toneMapped: false })
  );
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.3, 2.2), BLACK_GLOSS());
  deck.position.y = 0.15;
  const sign = makeSign(st.name, st.accent, 5.4);
  sign.position.set(0, 5.4, 5.6);
  g.add(screen, plane, trail, deck, sign);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  const pts = [];
  return {
    group: g,
    animate(t) {
      const phase = (t % 6) / 6;
      const x = -2.6 + phase * 5.2;
      const y = 1.2 + Math.pow(phase, 1.9) * 3.2;
      plane.position.set(x, y, 4.4);
      plane.rotation.z = -0.25 - phase * 0.5;
      pts.push([x, y, 4.35]);
      if (pts.length > trailN) pts.shift();
      if (phase < 0.03) pts.length = 0;
      const attr = trail.geometry.getAttribute("position");
      for (let i = 0; i < trailN; i++) {
        const p = pts[Math.min(i, pts.length - 1)] || [x, y, 4.35];
        attr.setXYZ(i, p[0], p[1], p[2]);
      }
      attr.needsUpdate = true;
    },
  };
}

function buildNumbers(st) {
  const g = new THREE.Group();
  const table = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.9, 24), DARKWOOD());
  table.position.y = 0.45;
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.55, 1.55, 0.06, 24),
    new THREE.MeshStandardMaterial({ map: feltTexture("#123a5c", st.name), roughness: 0.85 })
  );
  top.position.y = 0.93;
  // glass ball blower
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.16, metalness: 0.9, roughness: 0.05 })
  );
  globe.position.y = 2.1;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.2, 12), GOLD());
  stem.position.y = 1.35;
  const ballGeo = new THREE.SphereGeometry(0.09, 10, 10);
  const palette = [0xff5533, 0x42a5ff, 0xffcc33, 0x22e0a0, 0xff6fae];
  const balls = new THREE.InstancedMesh(
    ballGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.3 }),
    22
  );
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 22; i++) balls.setColorAt(i, new THREE.Color(palette[i % palette.length]));
  balls.instanceColor.needsUpdate = true;
  const sign = makeSign(st.name, st.accent);
  sign.position.set(0, 3.7, 0);
  g.add(table, top, globe, stem, balls, sign);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return {
    group: g,
    animate(t) {
      for (let i = 0; i < 22; i++) {
        const a = t * (0.8 + (i % 5) * 0.23) + i;
        dummy.position.set(
          Math.cos(a) * 0.5 * Math.sin(i + t * 0.7),
          2.1 + Math.sin(a * 1.3 + i) * 0.5,
          Math.sin(a) * 0.5 * Math.cos(i * 2)
        );
        dummy.updateMatrix();
        balls.setMatrixAt(i, dummy.matrix);
      }
      balls.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildBoard(st) {
  const g = new THREE.Group();
  const table = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 2.6), DARKWOOD());
  table.position.y = 0.45;
  const boardTex = canvasTexture([512, 512], (ctx, w, h) => {
    const s = w / 8;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? "#3a2410" : "#e8d9b0";
        ctx.fillRect(x * s, y * s, s, s);
      }
  });
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(2.3, 0.06, 2.3),
    new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.5 })
  );
  board.position.y = 0.93;
  const pieces = [];
  for (let i = 0; i < 12; i++) {
    const dark = i % 2 === 0;
    const p = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.06, 16),
      new THREE.MeshStandardMaterial({ color: dark ? 0xb3122e : 0xf5e6c8, roughness: 0.4 })
    );
    p.position.set(-1 + (i % 4) * 0.575 + (dark ? 0 : 0.287), 0.99, -1 + Math.floor(i / 4) * 0.575);
    pieces.push(p);
    g.add(p);
  }
  const sign = makeSign(st.name, st.accent);
  sign.position.set(0, 3.0, 0);
  g.add(table, board, sign);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return {
    group: g,
    animate(t) {
      // one piece hops every few seconds
      const k = Math.floor(t / 3) % pieces.length;
      const phase = (t % 3) / 3;
      const hop = phase < 0.3 ? Math.sin((phase / 0.3) * Math.PI) : 0;
      pieces[k].position.y = 0.99 + hop * 0.3;
    },
  };
}

const BUILDERS = {
  roulette: buildRoulette,
  dice: buildDice,
  slot: buildSlot,
  cards: buildCards,
  wheel: buildWheel,
  crash: buildCrash,
  numbers: buildNumbers,
  board: buildBoard,
};

export function buildStation(st) {
  const b = (BUILDERS[st.kind] || buildSlot)(st);
  b.group.position.set(st.position[0], 0, st.position[2]);
  b.group.rotation.y = st.rotationY || 0;
  b.group.userData.station = st;
  return b;
}

/* --------------------------------- the hall ---------------------------------- */

export function buildHall() {
  const g = new THREE.Group();
  const W = 52, D = 62, H = 11;

  const marble = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: marbleTexture(), metalness: 0.35, roughness: 0.18, envMapIntensity: 1.2 })
  );
  marble.rotation.x = -Math.PI / 2;
  marble.receiveShadow = true;

  const carpet = new THREE.Mesh(
    new THREE.RingGeometry(8, 22, 48),
    new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 0.95 })
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.y = 0.01;
  carpet.receiveShadow = true;

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a0f14, roughness: 0.85 });
  const walls = [
    [0, H / 2, -D / 2, W, H, 0.4],
    [0, H / 2, D / 2, W, H, 0.4],
    [-W / 2, H / 2, 0, 0.4, H, D],
    [W / 2, H / 2, 0, 0.4, H, D],
  ].map(([x, y, z, w, h, d]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    return m;
  });

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: 0x0a0810, roughness: 0.95 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = H;

  // starfield ceiling lights (fibre-optic look)
  const starGeo = new THREE.SphereGeometry(0.05, 6, 6);
  const stars = new THREE.InstancedMesh(
    starGeo,
    new THREE.MeshBasicMaterial({ color: 0xfff2cc, toneMapped: false }),
    140
  );
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 140; i++) {
    dummy.position.set((Math.random() - 0.5) * (W - 6), H - 0.15, (Math.random() - 0.5) * (D - 6));
    dummy.updateMatrix();
    stars.setMatrixAt(i, dummy.matrix);
  }

  // gold columns
  const colGeo = new THREE.CylinderGeometry(0.5, 0.6, H, 16);
  const colMat = GOLD();
  [[-18, -22], [18, -22], [-18, 22], [18, 22], [-18, 0], [18, 0]].forEach(([x, z]) => {
    const c = new THREE.Mesh(colGeo, colMat);
    c.position.set(x, H / 2, z);
    c.castShadow = true;
    g.add(c);
  });

  // central chandelier
  const chandelier = new THREE.Group();
  for (let ring = 0; ring < 3; ring++) {
    const r = 2.4 - ring * 0.7;
    const torus = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07, 10, 40), GOLD());
    torus.rotation.x = Math.PI / 2;
    torus.position.y = -ring * 0.65;
    chandelier.add(torus);
    const n = 14 - ring * 4;
    for (let i = 0; i < n; i++) {
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.12),
        new THREE.MeshBasicMaterial({ color: 0xffe9b0, toneMapped: false })
      );
      const a = (i / n) * Math.PI * 2;
      crystal.position.set(Math.cos(a) * r, -ring * 0.65 - 0.3, Math.sin(a) * r);
      crystal.material.color.multiplyScalar(1.8);
      chandelier.add(crystal);
    }
  }
  chandelier.position.set(0, H - 1.2, 0);

  // entrance marquee
  const entry = makeSign("CHAKRI CASINO", "#ffd24a", 14);
  entry.position.set(0, H - 2.2, D / 2 - 0.6);
  entry.rotation.y = Math.PI;

  g.add(marble, carpet, ceiling, stars, chandelier, entry, ...walls);
  return {
    group: g,
    bounds: { minX: -W / 2 + 2, maxX: W / 2 - 2, minZ: -D / 2 + 2, maxZ: D / 2 - 2 },
    animate(t) {
      chandelier.rotation.y = t * 0.05;
    },
  };
}
