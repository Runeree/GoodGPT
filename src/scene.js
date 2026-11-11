const TAU = Math.PI * 2;
const STEP = 1 / 120;
const MAX_TREATS = 54;
const REWARD_THRESHOLD = 8;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const shortestAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const uid = () => globalThis.crypto?.randomUUID?.() || `pour-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** A small, self-contained physical scene. The host page never becomes a drag surface. */
export class GoodGPTScene {
  constructor({ root, assets, onReward = () => {}, onStatus = () => {}, reducedMotion = false, onFirstInteraction = () => {}, getSinkRect = () => null }) {
    this.root = root;
    this.doc = root.ownerDocument || document;
    this.win = this.doc.defaultView || window;
    this.onReward = onReward;
    this.onStatus = onStatus;
    this.onFirstInteraction = onFirstInteraction;
    this.getSinkRect = getSinkRect;
    this.sinkRect = null;
    this.nextSinkCheck = 0;
    this.reducedMotion = reducedMotion;
    this.enabled = true;
    this.destroyed = false;
    this.mode = 'hung';
    this.angle = this.targetAngle = this.av = 0;
    this.vx = this.vy = 0;
    this.poured = 0;
    this.rewarded = false;
    this.pourAccumulator = 0;
    this.treats = [];
    this.fibers = [];
    this.listeners = [];
    this.elapsed = 0;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.lastPaint = 0;
    this.frame = 0;
    this.pointer = null;
    this.interactionId = null;
    this.snap = null;

    this.style = this.doc.createElement('style');
    this.style.textContent = `
      .goodgpt-scene { position:fixed; inset:0; overflow:hidden; pointer-events:none; user-select:none; contain:layout style; }
      .goodgpt-physics { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
      .goodgpt-bag { all:initial; box-sizing:border-box; position:absolute; top:0; left:0; width:168px; height:188px;
        display:block; cursor:grab; pointer-events:auto; touch-action:none; user-select:none; -webkit-user-select:none;
        transform-origin:50% 50%; will-change:transform; -webkit-tap-highlight-color:transparent; border-radius:42%; }
      .goodgpt-bag[data-grabbed="true"] { cursor:grabbing; }
      .goodgpt-bag, .goodgpt-bag:focus, .goodgpt-bag:focus-visible { outline:none; border:0; box-shadow:none; background:transparent; }
      .goodgpt-bag img { display:block; width:100%; height:100%; object-fit:contain; pointer-events:none; user-select:none;
        -webkit-user-drag:none; filter:drop-shadow(0 8px 8px #20100533); }
      .goodgpt-scene[hidden] { display:none; }
      @media (prefers-reduced-motion:reduce) { .goodgpt-bag img { filter:drop-shadow(0 4px 5px #20100522); } }
    `;
    this.layer = this.doc.createElement('div');
    this.layer.className = 'goodgpt-scene';
    this.canvas = this.doc.createElement('canvas');
    this.canvas.className = 'goodgpt-physics';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.bag = this.doc.createElement('button');
    this.bag.className = 'goodgpt-bag';
    this.bag.type = 'button';
    this.bag.setAttribute('aria-label', 'GoodGPT. Потяните мешок вниз. Вращайте колёсиком или с Shift. Клавиатура: пробел, стрелки, Escape.');
    this.bag.title = 'Потяните вниз · колёсико или Shift + движение — перевернуть · Esc — вернуть';
    this.bagImage = this.doc.createElement('img');
    this.bagImage.src = assets.bag;
    this.bagImage.alt = '';
    this.bagImage.draggable = false;
    this.bag.append(this.bagImage);
    this.layer.append(this.canvas, this.bag);
    root.append(this.style, this.layer);
    this.atlas = new this.win.Image();
    this.atlas.onload = () => this.kick();
    this.atlas.onerror = () => {
      this.onStatus({ type: 'asset-error', text: 'Не удалось загрузить сладости. Перезагрузите страницу или переустановите GoodGPT.' });
    };
    this.atlas.src = assets.treats;

    this.listen(this.bag, 'pointerdown', (e) => this.pointerDown(e));
    this.listen(this.bag, 'pointermove', (e) => this.pointerMove(e));
    this.listen(this.bag, 'pointerup', (e) => this.pointerUp(e));
    this.listen(this.bag, 'pointercancel', () => this.reset());
    this.listen(this.bag, 'lostpointercapture', () => { if (this.pointer) this.reset(); });
    this.listen(this.bag, 'wheel', (e) => this.wheel(e), { passive: false });
    this.listen(this.bag, 'keydown', (e) => this.keyDown(e));
    this.listen(this.win, 'keydown', (e) => {
      if (e.key === 'Escape' && this.mode !== 'hung') {
        this.reset();
      }
    });
    this.listen(this.win, 'resize', () => { this.resize(); this.reset({ immediate: true }); });
    this.listen(this.win, 'blur', () => { if (this.mode !== 'hung') this.reset(); });
    this.listen(this.doc, 'visibilitychange', () => {
      if (this.doc.hidden) {
        this.reset({ immediate: true });
        this.stop();
      } else this.kick();
    });
    this.resize();
    this.x = this.targetX = this.homeX;
    this.y = this.targetY = this.homeY;
    this.render();
    this.kick();
  }

  listen(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    this.listeners.push(() => target.removeEventListener(name, handler, options));
  }

  resize() {
    this.width = this.win.innerWidth;
    this.height = this.win.innerHeight;
    this.scale = this.width < 600 ? 0.82 : 1;
    this.homeX = this.width < 600 ? this.width - 94 : this.width - 147;
    this.homeY = 121 * this.scale;
    this.dpr = Math.min(this.win.devicePixelRatio || 1, 2);
    this.canvas.width = Math.ceil(this.width * this.dpr);
    this.canvas.height = Math.ceil(this.height * this.dpr);
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  pointerDown(e) {
    if (!this.enabled || e.button !== 0 || this.pointer) return;
    e.preventDefault();
    this.bag.focus({ preventScroll: true });
    this.pointer = {
      id: e.pointerId, startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY, lastTime: this.win.performance.now(),
      offsetX: this.x - e.clientX, offsetY: this.y - e.clientY,
      speed: 0,
    };
    this.bag.setPointerCapture(e.pointerId);
    this.bag.dataset.grabbed = 'true';
    if (this.mode === 'hung' || this.mode === 'tension' || this.mode === 'returning') {
      this.mode = 'tension';
      this.targetAngle = 0;
    } else {
      this.mode = 'dragging';
    }
    this.kick();
  }

  pointerMove(e) {
    const pointer = this.pointer;
    if (!pointer || e.pointerId !== pointer.id) return;
    const now = this.win.performance.now();
    const dt = Math.max((now - pointer.lastTime) / 1000, 0.008);
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    pointer.speed = clamp(Math.hypot(dx, dy) / dt, 0, 1800);
    if (this.mode === 'tension') {
      const pull = Math.max(0, e.clientY - pointer.startY);
      this.targetX = this.homeX + clamp((e.clientX - pointer.startX) * 0.32, -45, 45);
      this.targetY = this.homeY + Math.min(pull, 82);
      this.targetAngle = clamp((e.clientX - pointer.startX) * 0.002, -0.18, 0.18);
      if (pull > 70) {
        this.detach();
      }
    }
    if (this.mode === 'dragging') {
      if (e.shiftKey) {
        this.targetAngle += dx * 0.026;
        // Preserve the grab position when Shift is released.
        pointer.offsetX = this.x - e.clientX;
        pointer.offsetY = this.y - e.clientY;
      } else {
        this.targetX = clamp(e.clientX + pointer.offsetX, 58 * this.scale, this.width - 58 * this.scale);
        this.targetY = clamp(e.clientY + pointer.offsetY, 75 * this.scale, this.height - 62 * this.scale);
        this.av += clamp(dx / dt, -900, 900) * 0.00045;
      }
    }
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.lastTime = now;
    this.kick();
  }

  pointerUp(e) {
    if (!this.pointer || e.pointerId !== this.pointer.id) return;
    const id = this.pointer.id;
    this.pointer = null;
    this.bag.dataset.grabbed = 'false';
    if (this.bag.hasPointerCapture(id)) this.bag.releasePointerCapture(id);
    if (this.mode === 'tension') this.reset();
    else if (this.mode === 'dragging') {
      this.mode = 'free';
      this.releaseAt = this.elapsed;
      this.vx = clamp(this.vx, -650, 650);
      this.vy = clamp(this.vy, -450, 450);
      this.onStatus({ type: 'hint', text: 'Мешок сам вернётся на место. Escape — вернуть сейчас.' });
    }
    this.kick();
  }

  detach() {
    this.mode = 'dragging';
    this.interactionId = uid();
    this.poured = 0;
    this.rewarded = false;
    this.pourAccumulator = 0;
    this.snap = { age: 0, x: this.x, y: this.y, angle: this.angle };
    for (const side of [-1, 1]) {
      const point = this.localPoint(side * 62, -37);
      for (let i = 0; i < 5; i++) {
        this.fibers.push({ x: point.x, y: point.y, vx: side * (28 + Math.random() * 40), vy: -80 + Math.random() * 85, age: 0, angle: Math.random() * TAU });
      }
    }
    this.onFirstInteraction();
    this.onStatus({ type: 'grab', text: 'Переверните: колёсико или Shift + движение мыши. Горловина должна смотреть вниз.' });
  }

  wheel(e) {
    if (!this.enabled || !['dragging', 'keyboard'].includes(this.mode)) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 160 : 1);
    this.targetAngle += clamp(delta, -180, 180) * 0.014;
    this.kick();
  }

  keyDown(e) {
    if (!this.enabled) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (this.mode === 'hung' || this.mode === 'returning' || this.mode === 'tension') {
        this.detach();
        this.mode = 'keyboard';
        this.targetX = this.homeX;
        this.targetY = Math.min(this.homeY + 130, this.height - 90);
        this.onStatus({ type: 'hint', text: 'Стрелки влево / вправо — перевернуть. Enter — отпустить. Escape — вернуть.' });
      } else if (this.mode === 'keyboard') {
        this.mode = 'free';
        this.releaseAt = this.elapsed;
      }
    } else if (this.mode === 'keyboard' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') this.targetAngle -= Math.PI / 8;
      if (e.key === 'ArrowRight') this.targetAngle += Math.PI / 8;
      if (e.key === 'ArrowUp') this.targetY = Math.max(78, this.targetY - 24);
      if (e.key === 'ArrowDown') this.targetY = Math.min(this.height - 80, this.targetY + 24);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.reset();
    }
    this.kick();
  }

  localPoint(x, y) {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return { x: this.x + (x * c - y * s) * this.scale, y: this.y + (x * s + y * c) * this.scale };
  }

  spawnTreat() {
    const index = Math.floor(Math.random() * 6);
    const radius = (index === 0 ? 15 : index === 4 ? 11 : 12 + Math.random() * 3) * this.scale;
    const mouth = this.localPoint((Math.random() - 0.5) * 30, -59);
    const dx = Math.sin(this.angle);
    const dy = -Math.cos(this.angle);
    const impulse = 65 + Math.random() * 65;
    this.treats.push({
      x: mouth.x, y: mouth.y,
      vx: dx * impulse + this.vx * 0.23 + (Math.random() - 0.5) * 65,
      vy: dy * impulse + this.vy * 0.18,
      radius, index, angle: this.angle + Math.random() * TAU,
      spin: (Math.random() - 0.5) * 11,
      age: 0, life: this.reducedMotion ? 3.5 : 5.4 + Math.random() * 1.1,
    });
    this.poured++;
    if (this.treats.length > MAX_TREATS) this.treats.shift();
    if (!this.rewarded && this.poured >= REWARD_THRESHOLD) {
      this.rewarded = true;
      this.onStatus({ type: 'pour', text: 'Угощение готово. Отправляем добрые слова…', count: this.poured });
      // Keep this latch set even if the adapter cannot send. A retry must be an explicit user action.
      Promise.resolve().then(() => this.onReward({ interactionId: this.interactionId })).catch(() => {
        this.onStatus({ type: 'hint', text: 'Не удалось передать поощрение. Верните мешок и попробуйте ещё раз.' });
      });
    }
  }

  step(dt) {
    this.elapsed += dt;
    if (this.snap) {
      this.snap.age += dt;
      if (this.snap.age > 0.45) this.snap = null;
    }
    if (this.mode === 'hung') {
      const sway = this.reducedMotion ? 0 : Math.sin(this.elapsed * 1.45);
      this.x = this.homeX + sway * 2.6;
      this.y = this.homeY + (this.reducedMotion ? 0 : Math.cos(this.elapsed * 2.9) * 0.7);
      this.angle = sway * 0.026;
      this.vx = this.vy = this.av = 0;
    } else if (this.mode === 'free') {
      this.vy += (this.reducedMotion ? 70 : 220) * dt;
      this.vx *= Math.exp(-1.3 * dt);
      this.av *= Math.exp(-2 * dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.angle += this.av * dt;
      if (this.x < 65 || this.x > this.width - 65) { this.x = clamp(this.x, 65, this.width - 65); this.vx *= -0.35; }
      if (this.y > this.height - 82) { this.y = this.height - 82; this.vy *= -0.25; }
      if (this.elapsed - this.releaseAt > (this.reducedMotion ? 0.75 : 1.2)) this.reset();
    } else {
      // Physical spring: mass 1, stiffness 100, damping 10. Velocity survives retargeting.
      this.vx += ((this.targetX - this.x) * 100 - this.vx * 10) * dt;
      this.vy += ((this.targetY - this.y) * 100 - this.vy * 10) * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.av += ((this.targetAngle - this.angle) * 100 - this.av * 10) * dt;
      this.angle += this.av * dt;
      if (this.mode === 'returning') {
        const age = this.elapsed - this.returnAt;
        if ((age > 0.6 && Math.hypot(this.x - this.homeX, this.y - this.homeY) < 1.4 && Math.abs(this.angle) < 0.02) || age > 1.8) {
          this.mode = 'hung';
          this.x = this.targetX = this.homeX;
          this.y = this.targetY = this.homeY;
          this.angle = this.targetAngle = 0;
          this.onStatus({ type: 'reset', text: 'Мешок снова полон.' });
        }
      }
    }

    const assetsReady = this.bagImage.complete && this.bagImage.naturalWidth > 0
      && this.atlas.complete && this.atlas.naturalWidth > 0;
    const pouring = assetsReady && ['dragging', 'keyboard', 'free'].includes(this.mode);
    const downward = -Math.cos(this.angle);
    const limit = this.reducedMotion ? 20 : 40;
    if (pouring && downward > 0.2 && this.poured < limit) {
      const shake = (this.pointer?.speed || 0) / 120;
      const rate = (this.reducedMotion ? 11 : 13) + downward * 14 + Math.min(shake, 12);
      this.pourAccumulator += dt * rate;
      while (this.pourAccumulator >= 1 && this.poured < limit) {
        this.pourAccumulator--;
        this.spawnTreat();
      }
      if (this.pointer) this.pointer.speed *= Math.exp(-4 * dt);
    } else this.pourAccumulator = 0;

    const gravity = this.reducedMotion ? 620 : 920;
    const floor = this.height - 17;
    for (const treat of this.treats) {
      treat.age += dt;
      treat.vy += gravity * dt;
      treat.vx *= Math.exp(-0.1 * dt);
      treat.x += treat.vx * dt;
      treat.y += treat.vy * dt;
      treat.angle += treat.spin * dt;
      if (treat.y + treat.radius > floor) {
        treat.y = floor - treat.radius;
        treat.vy = Math.abs(treat.vy) < 26 ? 0 : -Math.abs(treat.vy) * 0.43;
        treat.vx *= Math.exp(-3.2 * dt);
        treat.spin *= Math.exp(-3.5 * dt);
      }
      if (treat.x - treat.radius < 0 || treat.x + treat.radius > this.width) {
        treat.x = clamp(treat.x, treat.radius, this.width - treat.radius);
        treat.vx *= -0.5;
        treat.spin *= -0.7;
      }
    }
    if (this.treats.length && this.elapsed >= this.nextSinkCheck) {
      this.nextSinkCheck = this.elapsed + 0.15;
      this.sinkRect = this.getSinkRect();
    }
    const sink = this.sinkRect;
    if (sink) this.treats = this.treats.filter(t => t.x + t.radius < sink.left || t.x - t.radius > sink.right || t.y + t.radius < sink.top || t.y - t.radius > sink.bottom);
    // Circle contact solver: varying sizes, mass proportional to area, modest restitution.
    for (let a = 0; a < this.treats.length; a++) {
      for (let b = a + 1; b < this.treats.length; b++) {
        const p = this.treats[a];
        const q = this.treats[b];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const distanceSq = dx * dx + dy * dy;
        const contact = p.radius + q.radius;
        if (distanceSq >= contact * contact || distanceSq < 0.0001) continue;
        const distance = Math.sqrt(distanceSq);
        const nx = dx / distance;
        const ny = dy / distance;
        const invP = 1 / (p.radius * p.radius);
        const invQ = 1 / (q.radius * q.radius);
        const inverseMass = invP + invQ;
        const correction = (contact - distance) * 0.75 / inverseMass;
        p.x -= nx * correction * invP;
        p.y -= ny * correction * invP;
        q.x += nx * correction * invQ;
        q.y += ny * correction * invQ;
        const relative = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
        if (relative < 0) {
          const impulse = -(1 + 0.32) * relative / inverseMass;
          p.vx -= nx * impulse * invP;
          p.vy -= ny * impulse * invP;
          q.vx += nx * impulse * invQ;
          q.vy += ny * impulse * invQ;
          p.spin += (q.vx - p.vx) * 0.006;
          q.spin -= (q.vx - p.vx) * 0.006;
        }
      }
    }
    // Pair separation can push a resting sweet through the floor; project it back.
    for (const treat of this.treats) {
      treat.y = Math.min(treat.y, floor - treat.radius);
      treat.x = clamp(treat.x, treat.radius, this.width - treat.radius);
    }
    this.treats = this.treats.filter((treat) => treat.age < treat.life);
    for (const fiber of this.fibers) {
      fiber.age += dt;
      fiber.vy += 290 * dt;
      fiber.x += fiber.vx * dt;
      fiber.y += fiber.vy * dt;
      fiber.angle += dt * 3;
    }
    this.fibers = this.fibers.filter((fiber) => fiber.age < 0.5);
  }

  rope(startX, startY, endX, endY, slack = 4, opacity = 1) {
    const ctx = this.ctx;
    if (opacity <= 0) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo((startX + endX) / 2 + slack, (startY + endY) / 2, endX, endY);
    ctx.strokeStyle = '#3f2b1b';
    ctx.lineWidth = 5.2 * this.scale;
    ctx.stroke();
    ctx.strokeStyle = '#997044';
    ctx.lineWidth = 3.4 * this.scale;
    ctx.stroke();
    ctx.setLineDash([2.1 * this.scale, 3.7 * this.scale]);
    ctx.strokeStyle = '#d8b983';
    ctx.lineWidth = 1.4 * this.scale;
    ctx.stroke();
    ctx.restore();
  }

  render() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (const side of [-1, 1]) {
      const startX = this.homeX + side * 63 * this.scale;
      const end = this.localPoint(side * 62, -37);
      if (this.mode === 'hung' || this.mode === 'tension') {
        const pull = Math.max(0, this.y - this.homeY);
        this.rope(startX, -5, end.x, end.y, Math.max(0, 4 - pull / 10) * side);
      } else if (this.mode === 'returning') {
        const distance = Math.hypot(this.x - this.homeX, this.y - this.homeY);
        const opacity = clamp(1 - distance / 150, 0, 1);
        this.rope(startX, -5, end.x, end.y, side * 5 * (1 - opacity), opacity);
      } else if (this.snap) {
        const progress = clamp(this.snap.age / 0.4, 0, 1);
        const endY = (this.snap.y - 37 * this.scale) * (1 - progress);
        this.rope(startX, -5, startX + Math.sin(progress * 10) * side * 15, endY, side * 15, 1 - progress);
      }
      if (!['hung', 'tension'].includes(this.mode)) {
        this.rope(end.x, end.y, end.x + side * 3, end.y + 10 * this.scale, side * 4, 0.9);
      }
    }
    const atlasReady = this.atlas.complete && this.atlas.naturalWidth > 0;
    for (const treat of this.treats) {
      if (!atlasReady) continue;
      const alpha = clamp((treat.life - treat.age) / 1.2, 0, 1);
      const cellW = this.atlas.naturalWidth / 3;
      const cellH = this.atlas.naturalHeight / 2;
      const size = treat.radius * 2.7;
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.translate(treat.x, treat.y);
      this.ctx.rotate(treat.angle);
      this.ctx.drawImage(this.atlas, (treat.index % 3) * cellW, Math.floor(treat.index / 3) * cellH, cellW, cellH, -size / 2, -size / 2, size, size);
      this.ctx.restore();
    }
    for (const fiber of this.fibers) {
      this.ctx.save();
      this.ctx.globalAlpha = clamp(1 - fiber.age * 2, 0, 1);
      this.ctx.translate(fiber.x, fiber.y);
      this.ctx.rotate(fiber.angle);
      this.ctx.strokeStyle = '#b68d58';
      this.ctx.lineWidth = 1.2;
      this.ctx.beginPath();
      this.ctx.moveTo(-3, 0);
      this.ctx.lineTo(4, 1);
      this.ctx.stroke();
      this.ctx.restore();
    }
    this.bag.style.transform = `translate3d(${this.x - 84}px,${this.y - 94}px,0) rotate(${this.angle}rad) scale(${this.scale})`;
    this.bag.dataset.mode = this.mode;
    this.bag.dataset.poured = String(this.poured);
    this.bag.dataset.rewarded = String(this.rewarded);
  }

  kick() {
    if (this.frame || this.destroyed || !this.enabled || this.doc.hidden) return;
    this.lastFrame = this.win.performance.now();
    this.frame = this.win.requestAnimationFrame((time) => this.tick(time));
  }

  tick(time) {
    this.frame = 0;
    if (this.destroyed || !this.enabled || this.doc.hidden) return;
    const dt = Math.min((time - this.lastFrame) / 1000, 0.05);
    this.lastFrame = time;
    this.accumulator += dt;
    while (this.accumulator >= STEP) {
      this.step(STEP);
      this.accumulator -= STEP;
    }
    const idle = this.mode === 'hung' && !this.treats.length && !this.fibers.length;
    if (!idle || time - this.lastPaint > 1000 / 30) {
      this.render();
      this.lastPaint = time;
    }
    if (!(idle && this.reducedMotion)) this.frame = this.win.requestAnimationFrame((next) => this.tick(next));
  }

  stop() {
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.accumulator = 0;
  }

  reset({ immediate = false } = {}) {
    if (this.destroyed) return;
    const id = this.pointer?.id;
    this.pointer = null;
    this.bag.dataset.grabbed = 'false';
    if (id !== undefined && this.bag.hasPointerCapture(id)) this.bag.releasePointerCapture(id);
    this.targetX = this.homeX;
    this.targetY = this.homeY;
    this.angle = shortestAngle(this.angle);
    this.targetAngle = 0;
    this.returnAt = this.elapsed;
    this.pourAccumulator = 0;
    this.mode = immediate ? 'hung' : 'returning';
    this.snap = null;
    if (immediate) {
      this.x = this.homeX;
      this.y = this.homeY;
      this.angle = this.av = this.vx = this.vy = 0;
      this.treats = [];
      this.fibers = [];
      this.render();
    } else {
      for (const treat of this.treats) treat.life = Math.min(treat.life, treat.age + 1.5);
    }
    this.kick();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.layer.hidden = !this.enabled;
    if (this.enabled) { this.reset({ immediate: true }); this.kick(); }
    else { this.reset({ immediate: true }); this.stop(); }
  }

  setReducedMotion(reducedMotion) {
    this.reducedMotion = Boolean(reducedMotion);
    this.kick();
  }

  getState() {
    return {
      mode: this.mode, x: this.x, y: this.y, angle: this.angle,
      poured: this.poured, rewarded: this.rewarded, particles: this.treats.length,
      interactionId: this.interactionId, enabled: this.enabled,
    };
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.listeners.forEach((remove) => remove());
    this.listeners = [];
    this.atlas.onload = null;
    this.atlas.onerror = null;
    this.layer.remove();
    this.style.remove();
    this.treats = [];
    this.fibers = [];
  }
}
