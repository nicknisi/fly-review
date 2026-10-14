/**
 * A homemade Doom for the deck's fly to play: a textured raycaster at Doom's own 320×200, imps that wander into view and
 * get shot, a bobbing pistol with a muzzle flash, and the status bar with the fly's face where the marine's would be. All
 * procedural pixel art, nothing from id Software. The player is a bot; `player` hears what it does, so the fly can do it
 * too. Returns a function that stops it.
 */
type Player = { move: (turned: number, walking: boolean, dt: number) => void; fire: () => void };
type Imp = { x: number; y: number; born: number; dead: number | null };

const W = 320,
  H = 200,
  HUD = 32,
  VIEW = H - HUD,
  TEX = 64;
/** 1 tech panels, 2 brick, 3 stone; dots are floor. */
const MAP = [
  '1111111111111111',
  '1......2.......1',
  '1..33..2..222..1',
  '1..3...........1',
  '1..3..2222..3..1',
  '1.....2.....3..1',
  '1111..2..3333..1',
  '1..............1',
  '1..222..33..2..1',
  '1....2...3..2..1',
  '1..3.2...3.....1',
  '1..3.....2222..1',
  '1..3..2........1',
  '1..3333..222...1',
  '1..............1',
  '1111111111111111',
];
const cell = (x: number, y: number) => MAP[Math.floor(y)]?.[Math.floor(x)] ?? '1';
const open = (x: number, y: number) => cell(x, y) === '.';

function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
/** A 64×64 wall texture, painted pixel by pixel with a little noise. */
function texture(paint: (x: number, y: number, n: number) => [number, number, number]) {
  const c = canvasOf(TEX, TEX),
    g = c.getContext('2d')!,
    img = g.createImageData(TEX, TEX);
  for (let y = 0; y < TEX; y++)
    for (let x = 0; x < TEX; x++) {
      const [r, gr, b] = paint(x, y, Math.random() - 0.5);
      img.data.set([r, gr, b, 255], (y * TEX + x) * 4);
    }
  g.putImageData(img, 0, 0);
  return c;
}
/** Pixel art from rows of characters; a dot is transparent. */
function sprite(rows: string[], palette: Record<string, string>) {
  const c = canvasOf(rows[0].length, rows.length),
    g = c.getContext('2d')!;
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (!palette[ch]) return;
      g.fillStyle = palette[ch];
      g.fillRect(x, y, 1, 1);
    }),
  );
  return c;
}

const IMP = [
  '....w......w....',
  '...wd......dw...',
  '...dbbbbbbbbd...',
  '..dbbrbbbbrbbd..',
  '..dbbbbbbbbbbd..',
  '..dbbbdwwdbbbd..',
  'w.ddbbbbbbbbdd.w',
  'wdbbbbbbbbbbbbdw',
  'dbbdbbbbbbbbdbbd',
  'dbbddbbbbbbddbbd',
  'wbd.dbbbbbbd.dbw',
  'ww..dbbobbbd..ww',
  '....dbboobbd....',
  '....dbbbbbbd....',
  '....dbbddbbd....',
  '....dbd..dbd....',
  '....dbd..dbd....',
  '...ddbd..dbdd...',
  '...wwdd..ddww...',
];
const CORPSE = ['................', '....xxx...xx....', '..xxdbbxxxbdxx..', '.xdbbbdxxdbbbdx.', 'xxxxxxxxxxxxxxxx'];
const PISTOL = [
  '.........kk.........',
  '........kGGk........',
  '........kGGk........',
  '........kGGk........',
  '........kGGk........',
  '.......kGGGGk.......',
  '.......kGllGk.......',
  '.......kGGGGk.......',
  '......skGGGGks......',
  '.....sskkkkkkss.....',
  '....sssssssssssS....',
  '....sssSsssssSsS....',
  '...ssssSsssssSssS...',
  '...sssssssssssssS...',
  '..sssssssssssssssS..',
  '..sssssssssssssssS..',
];
const FLASH = [
  '.....yy.....',
  '..y..YY..y..',
  '...yYWWYy...',
  '.yYYWWWWYYy.',
  '...yYWWYy...',
  '..y..YY..y..',
  '.....yy.....',
];
/** The status bar face: the fly, looking out at you. */
const FACE = [
  '....a......a....',
  '.....a....a.....',
  '....tttttttt....',
  '..rrrttttttrrr..',
  '.rrRrrttttrrRrr.',
  '.rrrrrttttrrrrr.',
  '.rrrrrttttrrrrr.',
  '..rrrttttttrrr..',
  '....tttttttt....',
  '.....tttttt.....',
  '......tmmt......',
  '.......mm.......',
];

export function doom(canvas: HTMLCanvasElement, player: Player): () => void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const walls: Record<string, HTMLCanvasElement> = {
    '1': texture((x, y, n) => {
      // Brown-gray tech panels with a green light strip, rivets, and seams.
      const seam = x % 32 === 0 || y === 0,
        band = y >= 40 && y < 46,
        light = band && x % 16 > 3 && x % 16 < 12,
        rivet = (x % 32 === 4 || x % 32 === 27) && (y === 6 || y === 57);
      if (light) return [70, 210 + n * 40, 80];
      if (seam || rivet) return [42 + n * 10, 38 + n * 10, 32 + n * 10];
      const k = band ? 0.62 : y < 20 ? 1.08 : 1;
      return [(122 + n * 24) * k, (110 + n * 24) * k, (90 + n * 24) * k];
    }),
    '2': texture((x, y, n) => {
      // Red-brown brick, offset every other course.
      const row = Math.floor(y / 16),
        bx = (x + (row % 2) * 16) % 32,
        mortar = y % 16 < 2 || bx < 2;
      return mortar ? [62 + n * 14, 54 + n * 14, 48 + n * 14] : [132 + n * 34, 64 + n * 20, 40 + n * 14];
    }),
    '3': texture((x, y, n) => {
      // Gray stone blocks.
      const row = Math.floor(y / 21),
        edge = (x + row * 13) % 32 === 0 || y % 21 === 0,
        v = edge ? 48 : 104 + n * 42;
      return [v, v * 0.96, v * 0.88];
    }),
  };
  const imp = sprite(IMP, { b: '#8a5a30', d: '#4e2c12', r: '#ff3010', w: '#e8dcc0', o: '#c87830' });
  const hurt = sprite(IMP, { b: '#c0301c', d: '#701008', r: '#ffe080', w: '#ffd0c0', o: '#ff6020' });
  const corpse = sprite(CORPSE, { x: '#9a1008', b: '#8a5a30', d: '#4e2c12' });
  const pistol = sprite(PISTOL, { k: '#1c1c1c', G: '#8c8c8c', l: '#cfcfcf', s: '#d09a6a', S: '#9a6a42' });
  const flash = sprite(FLASH, { y: '#ff8c00', Y: '#ffd000', W: '#fffbe0' });
  const face = sprite(FACE, { a: '#3a2a1a', t: '#c9a26a', r: '#b81e14', R: '#ff8a70', m: '#7a5530' });
  // The status bar's stone, drawn once.
  const bar = canvasOf(W, HUD);
  {
    const g = bar.getContext('2d')!,
      img = g.createImageData(W, HUD);
    for (let i = 0; i < W * HUD; i++) {
      const v = 82 + (Math.random() - 0.5) * 34;
      img.data.set([v, v, v * 0.98, 255], i * 4);
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = '#2a2a2a';
    for (const x of [52, 120, 144, 176, 244]) g.fillRect(x, 0, 1, HUD);
    g.fillRect(0, 0, W, 1);
    g.font = 'bold 6px monospace';
    g.fillStyle = '#d8d8d8';
    g.textAlign = 'center';
    [
      ['AMMO', 26],
      ['HEALTH', 86],
      ['ARMS', 132],
      ['ARMOR', 210],
    ].forEach(([label, x]) => g.fillText(label as string, x as number, HUD - 3));
    g.textAlign = 'left';
    g.fillStyle = '#e8c040';
    ['BULL  50/200', 'SHEL   0/50', 'RCKT   0/50', 'CELL   0/300'].forEach((t, i) => g.fillText(t, 250, 8 + i * 7));
    g.font = 'bold 7px monospace';
    [2, 3, 4, 5, 6, 7].forEach((n, i) => {
      g.fillStyle = n === 2 ? '#e8c040' : '#6a6a6a';
      g.fillText(String(n), 125 + (i % 3) * 7, 10 + Math.floor(i / 3) * 9);
    });
  }

  const zbuf = new Float32Array(W);
  let px = 1.5,
    py = 7.5,
    pa = 0,
    last = 0,
    frame = 0,
    bob = 0,
    shot = -10,
    ammo = 50,
    spawned = 0;
  let imps: Imp[] = [];
  /** Distance to the first wall along an angle, marched in small steps (for steering and line of sight). */
  const clear = (a: number, max: number) => {
    let d = 0;
    while (d < max && open(px + Math.cos(a) * d, py + Math.sin(a) * d)) d += 0.05;
    return d;
  };
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

  const tick = (ms: number) => {
    frame = requestAnimationFrame(tick);
    const now = ms / 1000;
    const dt = last ? Math.min(0.05, now - last) : 0;
    if (dt && dt < 0.03) return;
    last = now;
    const previous = pa;
    let walking = false;

    // An imp wanders into view now and then: placed a few steps ahead, where the bot can see it.
    imps = imps.filter(i => i.dead === null || now - i.dead < 4);
    let target = imps.find(i => i.dead === null);
    if (!target && now - spawned > 1.6) {
      for (let d = 6; d >= 3; d -= 0.5) {
        const x = px + Math.cos(pa) * d,
          y = py + Math.sin(pa) * d;
        if (open(x, y) && clear(pa, d) >= d) {
          target = { x, y, born: now, dead: null };
          imps.push(target);
          spawned = now;
          break;
        }
      }
    }
    if (target) {
      // Turn to it, let the room see it for a moment, then shoot.
      const dx = target.x - px,
        dy = target.y - py,
        diff = wrap(Math.atan2(dy, dx) - pa);
      pa += Math.sign(diff) * Math.min(Math.abs(diff), 3 * dt);
      if (Math.hypot(dx, dy) > 1.6) {
        target.x -= (dx / Math.hypot(dx, dy)) * 0.7 * dt;
        target.y -= (dy / Math.hypot(dx, dy)) * 0.7 * dt;
      }
      if (Math.abs(diff) < 0.05 && now - target.born > 0.9 && now - shot > 0.5) {
        shot = now;
        target.dead = now;
        ammo = ammo > 10 ? ammo - 1 : 50;
        player.fire();
      }
    } else if (clear(pa, 1.3) < 1.3) pa += 2.4 * dt;
    else {
      // Walk, weaving a little; never into a wall.
      const nx = px + Math.cos(pa) * 1.7 * dt,
        ny = py + Math.sin(pa) * 1.7 * dt;
      if (open(nx, ny)) {
        px = nx;
        py = ny;
        walking = true;
      }
      pa += Math.sin(now / 1.3) * 0.5 * dt;
    }
    if (walking) bob += dt * 9;
    if (dt) player.move(pa - previous, walking, dt);

    // Ceiling and floor.
    const sky = ctx.createLinearGradient(0, 0, 0, VIEW / 2);
    sky.addColorStop(0, '#3a3430');
    sky.addColorStop(1, '#0e0c0b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, VIEW / 2);
    const ground = ctx.createLinearGradient(0, VIEW / 2, 0, VIEW);
    ground.addColorStop(0, '#120e0a');
    ground.addColorStop(1, '#5e4a34');
    ctx.fillStyle = ground;
    ctx.fillRect(0, VIEW / 2, W, VIEW / 2);

    // Walls: one ray per column, stepped cell by cell, textured, darker with distance and on one face.
    const dirX = Math.cos(pa),
      dirY = Math.sin(pa),
      planeX = -dirY * 0.66,
      planeY = dirX * 0.66;
    for (let x = 0; x < W; x++) {
      const cam = (2 * x) / W - 1,
        rx = dirX + planeX * cam,
        ry = dirY + planeY * cam;
      let mx = Math.floor(px),
        my = Math.floor(py);
      const ddx = Math.abs(1 / rx),
        ddy = Math.abs(1 / ry),
        sx = rx < 0 ? -1 : 1,
        sy = ry < 0 ? -1 : 1;
      let sdx = (rx < 0 ? px - mx : mx + 1 - px) * ddx,
        sdy = (ry < 0 ? py - my : my + 1 - py) * ddy,
        side = 0,
        hit = '1';
      for (let i = 0; i < 64; i++) {
        if (sdx < sdy) {
          sdx += ddx;
          mx += sx;
          side = 0;
        } else {
          sdy += ddy;
          my += sy;
          side = 1;
        }
        hit = cell(mx, my);
        if (hit !== '.') break;
      }
      const dist = Math.max(0.05, side === 0 ? sdx - ddx : sdy - ddy);
      let u = side === 0 ? py + dist * ry : px + dist * rx;
      u -= Math.floor(u);
      let tx = Math.floor(u * TEX);
      if ((side === 0 && rx > 0) || (side === 1 && ry < 0)) tx = TEX - tx - 1;
      const h = VIEW / dist,
        top = VIEW / 2 - h / 2;
      ctx.drawImage(walls[hit], tx, 0, 1, TEX, x, top, 1, h);
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(0.9, dist / 11 + (side ? 0.16 : 0))})`;
      ctx.fillRect(x, top, 1, h);
      zbuf[x] = dist;
    }

    // Imps, far to near, hidden behind nearer walls column by column.
    const det = planeX * dirY - dirX * planeY;
    for (const i of [...imps].sort((a, b) => Math.hypot(b.x - px, b.y - py) - Math.hypot(a.x - px, a.y - py))) {
      const sx = i.x - px,
        sy = i.y - py,
        tX = (dirY * sx - dirX * sy) / det,
        tY = (-planeY * sx + planeX * sy) / det;
      if (tY < 0.2) continue;
      const dying = i.dead === null ? -1 : now - i.dead;
      const art = dying < 0 ? imp : dying < 0.18 ? hurt : corpse;
      const scale = VIEW / tY,
        sh = dying < 0 || dying < 0.18 ? scale * 0.8 : scale * 0.22,
        sw = (sh * art.width) / art.height,
        bottom = VIEW / 2 + scale / 2,
        cx = (W / 2) * (1 + tX / tY),
        left = cx - sw / 2;
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(W, left + sw); x++) {
        if (tY >= zbuf[x]) continue;
        const u = Math.min(art.width - 1, Math.floor(((x - left) / sw) * art.width));
        ctx.drawImage(art, u, 0, 1, art.height, x, bottom - sh, 1, sh);
      }
    }

    // The pistol: bobbing while it walks, kicking up and flashing when it fires.
    const firing = now - shot < 0.12;
    if (firing) {
      ctx.fillStyle = 'rgba(255, 236, 190, 0.14)';
      ctx.fillRect(0, 0, W, VIEW);
    }
    const gx = W / 2 - 30 + Math.sin(bob) * 6,
      gy = VIEW - 48 + Math.abs(Math.cos(bob)) * 4 - (firing ? 6 : 0);
    if (firing) ctx.drawImage(flash, gx + 12, gy - 20, 36, 21);
    ctx.drawImage(pistol, gx, gy, 60, 48);

    // The status bar, with the fly's face glancing left and right.
    ctx.drawImage(bar, 0, VIEW);
    ctx.font = 'bold 15px Impact, monospace';
    ctx.textAlign = 'center';
    for (const [text, x] of [
      [String(ammo), 26],
      ['100%', 86],
      ['0%', 210],
    ] as const) {
      ctx.fillStyle = '#2a0000';
      ctx.fillText(text, x + 1, VIEW + 19);
      ctx.fillStyle = '#d81818';
      ctx.fillText(text, x, VIEW + 18);
    }
    ctx.save();
    ctx.translate(160, VIEW + 4);
    if (Math.floor(now / 1.4) % 2) ctx.scale(-1, 1);
    ctx.drawImage(face, -14, 0, 28, 21);
    ctx.restore();
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
