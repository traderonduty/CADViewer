// dwg-model.js — turns the parsed DWG database (libredwg-web DwgDatabase)
// into flat, render-ready geometry: polylines, fills, texts, entity records.
// Pure JS, no DOM. Used by the worker (browser) and by node tests.

// ---------- AutoCAD Color Index ----------
const ACI = (() => {
  const t = new Array(256).fill(0);
  const fixed = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
  for (let i = 0; i < 10; i++) t[i] = fixed[i];
  const vals = [255, 189, 129, 104, 79];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const k = (i - 10) % 10;
    const v = vals[k >> 1];
    const m = (k & 1) ? Math.round(v * 2 / 3) : 0;
    const f = (h) => { // full-sat channel for hue
      const x = ((h % 360) + 360) % 360;
      if (x < 60) return x / 60; if (x < 180) return 1; if (x < 240) return (240 - x) / 60; return 0;
    };
    const r = m + (v - m) * f(hue + 120), g = m + (v - m) * f(hue), b = m + (v - m) * f(hue - 120);
    t[i] = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }
  [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff].forEach((c, j) => t[250 + j] = c);
  return t;
})();
export const FG = -1; // "foreground" colour (ACI 7: white on dark, black on paper)
export function aciToRgb(i) { return i === 7 ? FG : ACI[Math.abs(i) & 255]; }

// ---------- MTEXT parsing ----------
// Returns [{text, hf}] lines, hf = height factor relative to entity height.
export function parseMText(raw) {
  if (!raw) return [];
  const lines = []; let cur = ''; let curHf = null;
  let h = 1; const stack = [];
  const push = () => { lines.push({ text: cur.replace(/\s+$/, ''), hf: curHf ?? h }); cur = ''; curHf = null; };
  const add = (s) => { if (curHf === null && s.trim()) curHf = h; cur += s; };
  let i = 0; const s = raw;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') { stack.push(h); i++; continue; }
    if (c === '}') { if (stack.length) h = stack.pop(); i++; continue; }
    if (c === '\\' && i + 1 < s.length) {
      const k = s[i + 1];
      if (k === 'P') { push(); i += 2; continue; }
      if (k === 'X') { push(); i += 2; continue; }
      if (k === '~') { add(' '); i += 2; continue; }
      if (k === '\\' || k === '{' || k === '}') { add(k); i += 2; continue; }
      if ('LlOoKkNn'.includes(k)) { i += 2; continue; }
      if (k === 'U' && s[i + 2] === '+') {
        const hex = s.substr(i + 3, 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { add(String.fromCharCode(parseInt(hex, 16))); i += 7; continue; }
      }
      if (k === 'S') { // stacked fraction \Sa^b;
        const end = s.indexOf(';', i);
        if (end > 0) { add(s.slice(i + 2, end).replace(/[\^#]/, '/')); i = end + 1; continue; }
      }
      if ('HhCcFfQqTtWwApacf'.includes(k)) {
        const end = s.indexOf(';', i);
        if (end > 0) {
          if (k === 'H' || k === 'h') {
            const v = s.slice(i + 2, end);
            const n = parseFloat(v);
            if (isFinite(n) && n > 0) h = /x$/i.test(v) ? h * n : n; // absolute heights treated as factor (best effort)
          }
          i = end + 1; continue;
        }
      }
      i += 2; continue;
    }
    if (c === '\n') { push(); i++; continue; }
    add(c); i++;
  }
  push();
  // absolute \H values (e.g. \H250;) get mixed with factors; clamp silly results
  for (const l of lines) { if (!(l.hf > 0.05 && l.hf < 20)) l.hf = 1; }
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  return lines.map(l => ({ text: cleanSpecials(l.text), hf: l.hf }));
}
export function cleanSpecials(t) {
  return String(t ?? '')
    .replace(/%%[cC]/g, '⌀').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// DWG stores an LWPOLYLINE's "closed" bit as 512 (bit 1 means "has extrusion");
// old-style POLYLINE and DXF data use bit 1. The DXF adapter maps DXF to the DWG form.
export function isClosedPoly(e) { return e.type === 'LWPOLYLINE' ? !!(e.flag & 512) : !!(e.flag & 1); }

// ---------- affine matrices: [a,b,c,d,e,f]  x' = a x + c y + e ; y' = b x + d y + f
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const T = (x, y) => [1, 0, 0, 1, x, y];
const R = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
const S = (x, y) => [x, 0, 0, y, 0, 0];
const MIRX = [-1, 0, 0, 1, 0, 0];

// ---------- geometry store ----------
class Store {
  constructor() {
    this.xy = []; this.polyStart = []; this.polyStyle = []; this.polyEnt = [];
    this.fxy = []; this.ringStart = []; this.fillRing = []; this.fillStyle = []; this.fillEnt = []; this.fillKind = [];
    this.texts = []; this.snaps = []; this.snapKind = []; this.snapLayer = [];
  }
}

export function buildModel(db, opts = {}) {
  const t0 = Date.now();
  const header = db.header || {};
  const LTSCALE = (header.LTSCALE || 1) * (header.CELTSCALE || 1);
  const warnings = [];

  // layers
  const layerList = (db.tables?.LAYER?.entries || []);
  const layers = []; const layerIdx = new Map();
  const ensureLayer = (name) => {
    name = name || '0';
    if (layerIdx.has(name)) return layerIdx.get(name);
    const L = layerList.find(l => l.name === name);
    const ci = L ? L.colorIndex : 7;
    const rec = {
      name, color: aciToRgb(Math.abs(ci ?? 7) || 7),
      on: L ? !(L.off || ci < 0) : true, frozen: !!(L && L.frozen), locked: !!(L && L.locked),
      ltype: (L && L.lineType) || 'Continuous', count: 0,
    };
    layerIdx.set(name, layers.length); layers.push(rec); return layers.length - 1;
  };
  for (const l of layerList) ensureLayer(l.name);

  // linetypes
  const ltypes = new Map();
  for (const lt of db.tables?.LTYPE?.entries || []) {
    const pat = (lt.pattern || []).map(p => p.elementLength);
    ltypes.set(lt.name.toUpperCase(), pat);
  }
  const dashFor = (name, scale) => {
    if (!name) return null;
    const key = name.toUpperCase();
    if (key === 'CONTINUOUS' || key === 'BYLAYER' || key === 'BYBLOCK') return null;
    const pat = ltypes.get(key);
    if (!pat || pat.length < 2) return null;
    const total = pat.reduce((a, b) => a + Math.abs(b), 0);
    if (!(total > 0)) return null;
    let segs = [];
    for (const p of pat) {
      const sign = p < 0 ? -1 : 1;
      let len = Math.abs(p) || total * 0.02;
      if (segs.length && Math.sign(segs[segs.length - 1]) === sign) segs[segs.length - 1] += sign * len;
      else segs.push(sign * len);
    }
    if (segs[0] < 0) segs.push(segs.shift());
    if (segs.length > 1 && Math.sign(segs[0]) === Math.sign(segs[segs.length - 1])) { segs[0] += segs.pop(); }
    if (segs.length % 2) segs.push(-total * 0.02);
    return segs.map(v => +(Math.abs(v) * scale).toPrecision(5));
  };

  // styles = (layer, colour, dash) groups
  const styles = []; const styleIdx = new Map();
  const styleOf = (li, rgb, dash, width) => {
    width = width > 0 ? +width.toPrecision(4) : 0;
    const k = li + '|' + rgb + '|' + (dash ? dash.join(',') : '') + (width ? '|w' + width : '');
    let s = styleIdx.get(k);
    if (s === undefined) { s = styles.length; styleIdx.set(k, s); styles.push(width ? { layer: li, color: rgb, dash, width } : { layer: li, color: rgb, dash }); }
    return s;
  };

  // blocks
  const blocks = new Map();
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) blocks.set(b.name, b);
  const blockByHandle = new Map();
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) blockByHandle.set(b.handle, b);

  const blockCounts = new Map(); // name -> [{ent, bbox}]

  function resolveColor(e, ctx) {
    const ci = e.colorIndex;
    if (ci === 256 || ci === undefined || ci === null) return layers[ctx.li].color;
    if (ci === 0) return ctx.color;
    if (e.color !== undefined && e.color !== null && e.color >= 0 && ci !== 7) return e.color & 0xffffff;
    return aciToRgb(ci);
  }
  function resolveLtype(e, ctx) {
    let n = e.lineType;
    if (!n || /^bylayer$/i.test(n)) n = layers[ctx.li].ltype;
    else if (/^byblock$/i.test(n)) n = ctx.ltype;
    return n;
  }

  // ---- per-space flatten ----
  function flattenSpace(ents) {
    const st = new Store();
    const ents2 = []; // pickable top-level entity records
    let bb = null; // bbox accumulator stack
    const bbStack = [];
    const grow = (x, y) => { if (!bb) return; if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; };
    const pushBB = () => { bbStack.push(bb); bb = [Infinity, Infinity, -Infinity, -Infinity]; };
    const popBB = () => { const r = bb; bb = bbStack.pop(); if (bb && r[0] <= r[2]) { grow(r[0], r[1]); grow(r[2], r[3]); } return r; };

    let curEnt = 0;
    const emitPoly = (pts, closed, style) => { // pts flat world coords
      if (pts.length < 4) return;
      st.polyStart.push(st.xy.length / 2);
      for (let i = 0; i < pts.length; i += 2) { st.xy.push(pts[i], pts[i + 1]); grow(pts[i], pts[i + 1]); }
      if (closed) { st.xy.push(pts[0], pts[1]); }
      st.polyStyle.push(style); st.polyEnt.push(curEnt);
    };
    const emitFill = (rings, style, kind) => {
      if (!rings.length) return;
      st.fillRing.push(st.ringStart.length);
      for (const r of rings) {
        st.ringStart.push(st.fxy.length / 2);
        for (let i = 0; i < r.length; i += 2) { st.fxy.push(r[i], r[i + 1]); grow(r[i], r[i + 1]); }
      }
      st.fillStyle.push(style); st.fillEnt.push(curEnt); st.fillKind.push(kind);
    };
    const snap = (x, y, k, li) => { st.snaps.push(x, y); st.snapKind.push(k); st.snapLayer.push(li || 0); };
    const tp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const tpts = (m, arr) => { const o = new Array(arr.length); for (let i = 0; i < arr.length; i += 2) { o[i] = m[0] * arr[i] + m[2] * arr[i + 1] + m[4]; o[i + 1] = m[1] * arr[i] + m[3] * arr[i + 1] + m[5]; } return o; };
    const mscale = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

    const arcPts = (cx, cy, r, a0, a1, out = []) => {
      let sweep = a1 - a0; while (sweep <= 0) sweep += Math.PI * 2;
      const n = Math.max(4, Math.min(256, Math.ceil(sweep / (Math.PI * 2) * 96)));
      for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
      return out;
    };
    const bulgeSeg = (x0, y0, x1, y1, b, out) => { // appends points after start (excluding start, including end)
      if (!b) { out.push(x1, y1); return; }
      const th = 4 * Math.atan(b); const dx = x1 - x0, dy = y1 - y0; const c = Math.hypot(dx, dy);
      if (c < 1e-12) { out.push(x1, y1); return; }
      const r = c / (2 * Math.sin(th / 2));
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const h = r * Math.cos(th / 2);
      const nx = -dy / c, ny = dx / c;
      const cx = mx + nx * h, cy = my + ny * h; // works for signed r
      const a0 = Math.atan2(y0 - cy, x0 - cx);
      const n = Math.max(2, Math.min(128, Math.ceil(Math.abs(th) / (Math.PI * 2) * 96)));
      const rr = Math.hypot(x0 - cx, y0 - cy);
      for (let i = 1; i <= n; i++) { const a = a0 + th * i / n; out.push(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); }
    };
    const vertsBulge = (verts, closed) => {
      const out = []; if (!verts.length) return out;
      out.push(verts[0].x, verts[0].y);
      const n = verts.length;
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const a = verts[i], b = verts[(i + 1) % n];
        bulgeSeg(a.x, a.y, b.x, b.y, a.bulge || 0, out);
      }
      return out;
    };
    // Object Coordinate System → plan view (AutoCAD "arbitrary axis algorithm"), with elevation along the normal.
    const ocs = (e, m, elev = 0) => {
      const N0 = e.extrusionDirection; if (!N0) return m;
      const L = Math.hypot(N0.x || 0, N0.y || 0, N0.z || 0); if (L < 1e-9) return m;
      const N = [(N0.x || 0) / L, (N0.y || 0) / L, (N0.z || 0) / L];
      if (Math.abs(N[0]) < 1e-9 && Math.abs(N[1]) < 1e-9 && N[2] > 0) return m;
      let ax = (Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64) ? [N[2], 0, -N[0]] /* Wy × N */ : [-N[1], N[0], 0] /* Wz × N */;
      const al = Math.hypot(...ax); ax = ax.map(v => v / al);
      const ay = [N[1] * ax[2] - N[2] * ax[1], N[2] * ax[0] - N[0] * ax[2], N[0] * ax[1] - N[1] * ax[0]];
      return mul(m, [ax[0], ax[1], ay[0], ay[1], (elev || 0) * N[0], (elev || 0) * N[1]]);
    };
    const zOf = (p) => (p && typeof p.z === 'number') ? p.z : 0;

    function splinePts(e) {
      const cps = e.controlPoints || [];
      const deg = e.degree || 3; const knots = e.knots || [];
      if (cps.length >= 2 && knots.length >= cps.length + deg + 1) {
        const w = e.weights && e.weights.length === cps.length ? e.weights : null;
        const out = []; const n = Math.min(400, Math.max(16, cps.length * 10));
        const lo = knots[deg], hi = knots[knots.length - deg - 1];
        for (let s = 0; s <= n; s++) {
          let u = lo + (hi - lo) * s / n; if (s === n) u = hi - 1e-12 * Math.max(1, Math.abs(hi));
          let k = deg; while (k < knots.length - deg - 2 && u >= knots[k + 1]) k++;
          const d = []; for (let j = 0; j <= deg; j++) { const p = cps[k - deg + j]; const ww = w ? w[k - deg + j] : 1; d.push([p.x * ww, p.y * ww, ww]); }
          for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
            const i = k - deg + j; const den = knots[i + deg - r + 1] - knots[i];
            const a = den ? (u - knots[i]) / den : 0;
            d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
          }
          out.push(d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]);
        }
        return out;
      }
      const fp = e.fitPoints || [];
      if (fp.length >= 2) return fp.flatMap(p => [p.x, p.y]);
      return cps.flatMap(p => [p.x, p.y]);
    }

    function ellipsePts(cx, cy, mx, my, ratio, s0, s1, minor) {
      let sweep = s1 - s0; while (sweep <= 0) sweep += Math.PI * 2; if (sweep > Math.PI * 2 + 1e-9) sweep = Math.PI * 2;
      const n = Math.max(8, Math.min(256, Math.ceil(sweep / (Math.PI * 2) * 96)));
      const nx = minor ? minor[0] : -my * ratio, ny = minor ? minor[1] : mx * ratio; const out = [];
      for (let i = 0; i <= n; i++) { const t = s0 + sweep * i / n; const c = Math.cos(t), s = Math.sin(t); out.push(cx + mx * c + nx * s, cy + my * c + ny * s); }
      return out;
    }

    // hatch boundary → rings in OCS
    function hatchRings(e) {
      const rings = [];
      for (const p of e.boundaryPaths || []) {
        if (p.boundaryPathTypeFlag & 2) { const r = vertsBulge(p.vertices || [], true); if (r.length >= 6) rings.push(r); continue; }
        const r = [];
        for (const ed of p.edges || []) {
          let seg = [];
          if (ed.type === 1) seg = [ed.start.x, ed.start.y, ed.end.x, ed.end.y];
          else if (ed.type === 2) {
            if (ed.isCCW) seg = arcPts(ed.center.x, ed.center.y, ed.radius, ed.startAngle, ed.endAngle);
            else { seg = arcPts(ed.center.x, ed.center.y, ed.radius, -ed.endAngle, -ed.startAngle); const rev = []; for (let i = seg.length - 2; i >= 0; i -= 2) rev.push(seg[i], seg[i + 1]); seg = rev; }
          } else if (ed.type === 3) {
            const mx = ed.end?.x ?? ed.majorAxisEndPoint?.x, my = ed.end?.y ?? ed.majorAxisEndPoint?.y;
            const ratio = ed.lengthOfMinorAxis ?? ed.axisRatio ?? 1;
            if (ed.isCCW === 0) { seg = ellipsePts(ed.center.x, ed.center.y, mx, my, ratio, -ed.endAngle, -ed.startAngle); const rev = []; for (let i = seg.length - 2; i >= 0; i -= 2) rev.push(seg[i], seg[i + 1]); seg = rev; }
            else seg = ellipsePts(ed.center.x, ed.center.y, mx, my, ratio, ed.startAngle, ed.endAngle);
          } else if (ed.type === 4) seg = splinePts(ed);
          if (!seg.length) continue;
          if (r.length && Math.hypot(r[r.length - 2] - seg[0], r[r.length - 1] - seg[1]) < 1e-9) seg = seg.slice(2);
          for (const v of seg) r.push(v);
        }
        if (r.length >= 6) rings.push(r);
      }
      return rings;
    }

    // pattern hatch lines (in OCS), clipped even-odd to rings
    function hatchPatternSegs(e, rings, maxSegs) {
      const out = [];
      const lines = e.definitionLines || [];
      if (!lines.length) return null;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const r of rings) for (let i = 0; i < r.length; i += 2) { if (r[i] < minx) minx = r[i]; if (r[i] > maxx) maxx = r[i]; if (r[i + 1] < miny) miny = r[i + 1]; if (r[i + 1] > maxy) maxy = r[i + 1]; }
      const edges = [];
      for (const r of rings) { const n = r.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; edges.push(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]); } }
      for (const L of lines) {
        const ang = L.angle; const ux = Math.cos(ang), uy = Math.sin(ang);
        const ox = L.offset.x, oy = L.offset.y;
        const perp = -uy * ox + ux * oy; // spacing along normal
        const along = ux * ox + uy * oy;
        if (Math.abs(perp) < 1e-9) continue;
        const nx = -uy, ny = ux;
        const bx = L.base.x, by = L.base.y;
        const corners = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]];
        let dmin = Infinity, dmax = -Infinity, tmin = Infinity, tmax = -Infinity;
        for (const [x, y] of corners) { const d = (x - bx) * nx + (y - by) * ny; const t = (x - bx) * ux + (y - by) * uy; dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
        const k0 = Math.ceil(Math.min(dmin / perp, dmax / perp)), k1 = Math.floor(Math.max(dmin / perp, dmax / perp));
        if (k1 - k0 > 4000) return null;
        const dashes = (L.dashLengths || []).filter(v => isFinite(v));
        const dashTotal = dashes.reduce((a, b) => a + Math.abs(b), 0);
        for (let k = k0; k <= k1; k++) {
          const px = bx + ox * k, py = by + oy * k; // a point on this line
          const ts = [];
          for (let i = 0; i < edges.length; i += 4) {
            const x1 = edges[i], y1 = edges[i + 1], x2 = edges[i + 2], y2 = edges[i + 3];
            const d1 = (x1 - px) * nx + (y1 - py) * ny, d2 = (x2 - px) * nx + (y2 - py) * ny;
            if ((d1 > 0) === (d2 > 0)) continue;
            const s = d1 / (d1 - d2);
            const ix = x1 + (x2 - x1) * s, iy = y1 + (y2 - y1) * s;
            ts.push((ix - px) * ux + (iy - py) * uy);
          }
          if (ts.length < 2) continue;
          ts.sort((a, b) => a - b);
          for (let i = 0; i + 1 < ts.length; i += 2) {
            const a = ts[i], b = ts[i + 1];
            if (!dashes.length || dashTotal <= 0) { out.push(px + ux * a, py + uy * a, px + ux * b, py + uy * b); }
            else {
              // dash phase anchored at the line's base point (shifted by along*k)
              const phase0 = along * k;
              let t = a; let pos = ((a - phase0) % dashTotal + dashTotal) % dashTotal; let di = 0;
              while (pos >= Math.abs(dashes[di])) { pos -= Math.abs(dashes[di]); di = (di + 1) % dashes.length; }
              let guard = 0;
              while (t < b && guard++ < 2000) {
                const len = Math.abs(dashes[di]) - pos; const t2 = Math.min(b, t + len);
                if (dashes[di] > 0) out.push(px + ux * t, py + uy * t, px + ux * t2, py + uy * t2);
                else if (dashes[di] === 0) out.push(px + ux * t, py + uy * t, px + ux * t + ux * dashTotal * 0.01, py + uy * t + uy * dashTotal * 0.01);
                t = t2; pos = 0; di = (di + 1) % dashes.length;
              }
            }
            if (out.length / 4 > maxSegs) return null;
          }
        }
      }
      return out;
    }

    function addText(m, opt, ctx, e) {
      // opt: x,y (OCS/block coords), rot, h, wf, lines, ax, ay (anchor 0..1), mtextWidth
      const [x, y] = tp(m, opt.x, opt.y);
      const vx = m[0] * Math.cos(opt.rot) + m[2] * Math.sin(opt.rot), vy = m[1] * Math.cos(opt.rot) + m[3] * Math.sin(opt.rot);
      const ux = -Math.sin(opt.rot), uy = Math.cos(opt.rot);
      const wx = m[0] * ux + m[2] * uy, wy = m[1] * ux + m[3] * uy;
      const sx = Math.hypot(vx, vy), sy = Math.hypot(wx, wy);
      const det = m[0] * m[3] - m[1] * m[2];
      const h = opt.h * sy;
      if (!(h > 0) || !opt.lines.length) return;
      const color = resolveColor(e, ctx);
      st.texts.push({
        x, y, r: Math.atan2(vy, vx), h, wf: (opt.wf || 1) * (sy ? sx / sy : 1), mir: det < 0,
        lines: opt.lines, ax: opt.ax, ay: opt.ay, mw: opt.mw ? opt.mw * sx : 0, ls: opt.ls || 1,
        s: styleOf(ctx.li, color, null), e: curEnt, kind: e.type,
      });
      const est = Math.max(...opt.lines.map(l => l.text.length * (l.hf || 1))) * h * 0.6 * (opt.wf || 1);
      const totalH = opt.lines.reduce((a, l) => a + (l.hf || 1) * h * 1.6, 0);
      grow(x, y); grow(x + Math.cos(Math.atan2(vy, vx)) * est, y + Math.sin(Math.atan2(vy, vx)) * est); grow(x, y - totalH); grow(x, y + h);
    }

    const textAnchor = (hal, val) => {
      const ax = hal === 1 || hal === 4 ? 0.5 : hal === 2 ? 1 : 0;
      const ay = hal === 4 ? 0.5 : val === 3 ? 1 : val === 2 ? 0.5 : 0; // 0=baseline/bottom, 1=top
      return [ax, ay];
    };

    function emitTextEnt(e, m, ctx, d) {
      // d = TEXT-like data (TEXT, or ATTRIB.text)
      const hal = d.halign || 0, val = d.valign || 0;
      const useAlign = (hal || val) && d.endPoint && (d.endPoint.x || d.endPoint.y);
      const p = useAlign ? d.endPoint : (d.startPoint || d.insertionPoint || { x: 0, y: 0 });
      const [ax, ay] = useAlign ? textAnchor(hal, val) : [0, 0];
      let lines = [{ text: cleanSpecials(d.text), hf: 1 }];
      if (e.mtextFlag === 2 || (/\\P|\{\\/.test(d.text || ''))) lines = parseMText(d.text);
      if (!lines.length || !lines.some(l => l.text.trim())) return;
      addText(ocs(d, m, zOf(d.startPoint) || d.elevation || 0), { x: p.x, y: p.y, rot: d.rotation || 0, h: d.textHeight || 1, wf: d.xScale || 1, lines, ax, ay }, ctx, e);
    }

    function emit(e, m, ctx, depth) {
      if (!e || e.isVisible === false) return;
      const li = (e.layer === '0' && ctx.inBlock) ? ctx.li : ensureLayer(e.layer);
      const color = resolveColor(e, { ...ctx, li });
      const ltName = resolveLtype(e, { ...ctx, li });
      const ltScale = LTSCALE * (e.lineTypeScale || 1) * mscale(m);
      const dash = dashFor(ltName, ltScale);
      const style = () => styleOf(li, color, dash);
      const plain = () => styleOf(li, color, null);
      const sub = { li, color, ltype: ltName, inBlock: true, inDim: ctx.inDim };
      if (!ctx.inBlock) layers[li].count++;
      switch (e.type) {
        case 'LINE': {
          const a = tp(m, e.startPoint.x, e.startPoint.y), b = tp(m, e.endPoint.x, e.endPoint.y);
          emitPoly([a[0], a[1], b[0], b[1]], false, style());
          snap(a[0], a[1], 0, li); snap(b[0], b[1], 0, li); snap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1, li);
          break;
        }
        case 'LWPOLYLINE': case 'POLYLINE2D': {
          let verts = e.vertices || [];
          if (e.type === 'POLYLINE2D') { const fit = verts.filter(v => v.flag & 8); verts = fit.length >= 2 ? fit : verts.filter(v => !(v.flag & 16)); }
          if (verts.length < 2) break;
          const closed = isClosedPoly(e);
          const mm = ocs(e, m, e.elevation ?? zOf(verts[0]));
          const pts = tpts(mm, vertsBulge(verts, closed));
          let wd = e.constantWidth || 0;
          if (!wd && e.type === 'POLYLINE2D' && e.startWidth && e.startWidth === e.endWidth) wd = e.startWidth;
          if (!wd && verts.length && verts.every(v => (v.startWidth || 0) > 0 && v.startWidth === verts[0].startWidth && (v.endWidth ?? v.startWidth) === v.startWidth)) wd = verts[0].startWidth;
          emitPoly(pts, false, wd > 0 ? styleOf(li, color, dash, wd * mscale(m)) : style());
          const vv = verts.map(v => tp(mm, v.x, v.y));
          vv.forEach((p, i) => { snap(p[0], p[1], 0, li); const q = vv[i + 1] || (closed ? vv[0] : null); if (q && !verts[i].bulge) snap((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 1, li); });
          // wide polylines (constant width) → also fill
          break;
        }
        case 'ARC': {
          const mm = ocs(e, m, zOf(e.center));
          const pts = arcPts(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle);
          const w = tpts(mm, pts); emitPoly(w, false, style());
          snap(w[0], w[1], 0, li); snap(w[w.length - 2], w[w.length - 1], 0, li);
          const c = tp(mm, e.center.x, e.center.y); snap(c[0], c[1], 2, li);
          break;
        }
        case 'CIRCLE': {
          const mm = ocs(e, m, zOf(e.center));
          const pts = arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2);
          emitPoly(tpts(mm, pts), false, style());
          const c = tp(mm, e.center.x, e.center.y); snap(c[0], c[1], 2, li);
          break;
        }
        case 'ELLIPSE': {
          const M3 = e.majorAxisEndPoint, N0 = e.extrusionDirection || { x: 0, y: 0, z: 1 };
          const nl = Math.hypot(N0.x || 0, N0.y || 0, N0.z || 0) || 1, Nn = [(N0.x || 0) / nl, (N0.y || 0) / nl, (nl === 1 && !N0.z && !N0.x && !N0.y) ? 1 : (N0.z || 0) / nl];
          const mz = M3.z || 0, rr = e.axisRatio || 1;
          const minor = [(Nn[1] * mz - Nn[2] * M3.y) * rr, (Nn[2] * M3.x - Nn[0] * mz) * rr]; // (N × major) · ratio, projected to plan
          const pts = ellipsePts(e.center.x, e.center.y, M3.x, M3.y, rr, e.startAngle || 0, (e.endAngle ?? Math.PI * 2), minor);
          const w = tpts(m, pts); emitPoly(w, false, style());
          const c = tp(m, e.center.x, e.center.y); snap(c[0], c[1], 2, li);
          break;
        }
        case 'SPLINE': {
          const w = tpts(m, splinePts(e)); emitPoly(w, !!(e.flag & 1), style());
          if (w.length >= 4) { snap(w[0], w[1], 0, li); snap(w[w.length - 2], w[w.length - 1], 0, li); }
          break;
        }
        case 'SOLID': case 'TRACE': {
          const mm = ocs(e, m, e.elevation ?? zOf(e.corner1));
          const c = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].filter(Boolean);
          const r = tpts(mm, c.flatMap(p => [p.x, p.y]));
          emitFill([r], plain(), 0);
          break;
        }
        case 'HATCH': {
          const mm = ocs(e, m, zOf(e.elevationPoint) || e.elevation || 0);
          const rings = hatchRings(e);
          if (!rings.length) break;
          const solid = e.solidFill === 1 || /^SOLID$/i.test(e.patternName || '');
          if (solid) { emitFill(rings.map(r => tpts(mm, r)), plain(), 0); break; }
          const segs = hatchPatternSegs(e, rings, 20000);
          if (segs && segs.length) {
            const w = tpts(mm, segs);
            const s = plain();
            for (let i = 0; i < w.length; i += 4) emitPoly([w[i], w[i + 1], w[i + 2], w[i + 3]], false, s);
          } else emitFill(rings.map(r => tpts(mm, r)), plain(), 1); // tint
          break;
        }
        case 'TEXT': emitTextEnt(e, m, { ...ctx, li }, e); break;
        case 'ATTRIB': if (!(e.flags & 1)) emitTextEnt(e, m, { ...ctx, li }, e.text || {}); break;
        case 'MTEXT': {
          const lines = parseMText(e.text);
          if (!lines.length || !lines.some(l => l.text.trim())) break;
          let rot = e.rotation || 0;
          if (e.direction && (e.direction.x || e.direction.y)) rot = Math.atan2(e.direction.y, e.direction.x);
          const ap = e.attachmentPoint || 1;
          const ax = [0, 0, 0.5, 1][((ap - 1) % 3) + 1];
          const ay = ap <= 3 ? 1 : ap <= 6 ? 0.5 : 0;
          addText(m, { x: e.insertionPoint.x, y: e.insertionPoint.y, rot, h: e.textHeight || 1, wf: 1, lines, ax, ay, mw: e.rectWidth || 0, ls: e.lineSpacing || 1, mtext: true }, { ...ctx, li }, e);
          st.texts[st.texts.length - 1] && (st.texts[st.texts.length - 1].mt = 1);
          break;
        }
        case 'DIMENSION': {
          const b = blocks.get(e.name);
          if (b && depth < 16) {
            const mm = mul(m, T(e.insertionPoint?.x || 0, e.insertionPoint?.y || 0));
            for (const c of b.entities || []) emit(c, mm, { ...sub, inDim: true }, depth + 1);
          }
          break;
        }
        case 'LEADER': {
          const w = tpts(m, (e.vertices || []).flatMap(v => [v.x, v.y]));
          emitPoly(w, false, style());
          if (w.length >= 4 && e.isArrowheadEnabled) {
            const [x0, y0, x1, y1] = w; const L = Math.hypot(x1 - x0, y1 - y0); const sz = Math.min(L * 0.25, (header.DIMASZ || 2.5) * (header.DIMSCALE || 1) * 40);
            if (L > 0 && sz > 0) { const ux = (x1 - x0) / L, uy = (y1 - y0) / L; emitFill([[x0, y0, x0 + ux * sz - uy * sz * 0.17, y0 + uy * sz + ux * sz * 0.17, x0 + ux * sz + uy * sz * 0.17, y0 + uy * sz - ux * sz * 0.17]], plain(), 0); }
          }
          break;
        }
        case 'MULTILEADER': {
          for (const sec of e.leaderSections || []) {
            for (const ll of sec.leaderLines || []) {
              const pts = (ll.vertices || []).flatMap(v => [v.x, v.y]);
              if (sec.lastLeaderLinePoint) pts.push(sec.lastLeaderLinePoint.x, sec.lastLeaderLinePoint.y);
              emitPoly(tpts(m, pts), false, plain());
            }
            if (sec.lastLeaderLinePoint && sec.doglegVector && e.doglegEnabled) {
              const p = sec.lastLeaderLinePoint, dl = sec.doglegLength || e.doglegLength || 0;
              emitPoly(tpts(m, [p.x, p.y, p.x + sec.doglegVector.x * dl, p.y + sec.doglegVector.y * dl]), false, plain());
            }
          }
          if (e.textContent && e.textAnchor) {
            const lines = parseMText(e.textContent);
            let h = e.textHeight || 2.5; if (h < 20 && (e.contentScale || 1) > 1) h *= e.contentScale;
            addText(m, { x: e.textAnchor.x, y: e.textAnchor.y, rot: 0, h, wf: 1, lines, ax: 0, ay: 1 }, { ...ctx, li }, e);
          }
          break;
        }
        case 'MLINE': {
          const vs = e.vertices || []; if (vs.length < 2) break;
          const nl = e.numberOfLines || (vs[0].lines || []).length;
          for (let k = 0; k < nl; k++) {
            const pts = [];
            for (const v of vs) { const off = ((v.lines || [])[k]?.segmentParams || [0])[0]; /* already in drawing units */ pts.push(v.vertex.x + v.miterDirection.x * off, v.vertex.y + v.miterDirection.y * off); }
            emitPoly(tpts(m, pts), !!(e.flags & 2), style());
          }
          break;
        }
        case 'INSERT': {
          const b = blocks.get(e.name);
          if (!b || depth >= 16) break;
          const bp = b.basePoint || { x: 0, y: 0 };
          let base = ocs(e, m, zOf(e.insertionPoint));
          const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
          const named = !/^(\*|A\$C)/.test(e.name);
          pushBB();
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            let mm = mul(base, T(e.insertionPoint.x, e.insertionPoint.y));
            mm = mul(mm, R(e.rotation || 0));
            mm = mul(mm, T(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0)));
            mm = mul(mm, S(e.xScale ?? 1, e.yScale ?? 1));
            mm = mul(mm, T(-bp.x, -bp.y));
            for (const c2 of b.entities || []) { if (c2.type === 'ATTDEF') continue; emit(c2, mm, sub, depth + 1); }
          }
          const ip = tp(base, e.insertionPoint.x, e.insertionPoint.y); snap(ip[0], ip[1], 3, li);
          for (const a of e.attribs || []) emit(a, m, { ...ctx, li, color, inBlock: ctx.inBlock }, depth + 1);
          const r = popBB();
          if (named && !ctx.inDim && r[0] <= r[2]) {
            if (!blockCounts.has(e.name)) blockCounts.set(e.name, []);
            blockCounts.get(e.name).push({ ent: curEnt, bb: r, nested: !!ctx.inBlock });
          }
          break;
        }
        default: break; // POINT, VIEWPORT, 3DSOLID, WIPEOUT, ATTDEF…
      }
    }

    const viewports = [];
    for (const e of ents) {
      if (e.type === 'VIEWPORT') { viewports.push(e); continue; }
      if (e.type === 'ATTRIB' || e.type === 'ATTDEF') continue;
      const rec = { h: e.handle, t: e.type, l: e.layer || '0', p0: st.polyStart.length, f0: st.fillRing.length, x0: st.texts.length };
      curEnt = ents2.length; ents2.push(rec);
      bb = [Infinity, Infinity, -Infinity, -Infinity];
      try { emit(e, I, { li: ensureLayer(e.layer), color: FG, ltype: 'Continuous', inBlock: false }, 0); }
      catch (err) { warnings.push(e.type + ' ' + e.handle + ': ' + err.message); }
      rec.p1 = st.polyStart.length; rec.f1 = st.fillRing.length; rec.x1 = st.texts.length;
      rec.b = bb[0] <= bb[2] ? bb : null;
      rec.info = describe(e);
      bb = null;
    }
    // drop entities that produced nothing
    return { st, ents: ents2, viewports };
  }

  function describe(e) {
    const info = [];
    const P = (p) => p ? [p.x, p.y] : null;
    switch (e.type) {
      case 'LINE': { const dx = e.endPoint.x - e.startPoint.x, dy = e.endPoint.y - e.startPoint.y; info.push(['Length', Math.hypot(dx, dy), 'len'], ['Angle', Math.atan2(dy, dx), 'ang'], ['Start', P(e.startPoint), 'pt'], ['End', P(e.endPoint), 'pt']); break; }
      case 'LWPOLYLINE': case 'POLYLINE2D': {
        const v = e.vertices || []; const closed = isClosedPoly(e); let L = 0, A = 0;
        for (let i = 0; i < (closed ? v.length : v.length - 1); i++) { const a = v[i], b = v[(i + 1) % v.length]; L += Math.hypot(b.x - a.x, b.y - a.y); A += a.x * b.y - b.x * a.y; }
        info.push(['Vertices', v.length, 'n'], ['Closed', closed ? 'Yes' : 'No', 's'], ['Length', L, 'len']);
        if (closed) info.push(['Area', Math.abs(A / 2), 'area']);
        break;
      }
      case 'CIRCLE': info.push(['Center', P(e.center), 'pt'], ['Radius', e.radius, 'len'], ['Diameter', e.radius * 2, 'len'], ['Area', Math.PI * e.radius * e.radius, 'area']); break;
      case 'ARC': { let sw = e.endAngle - e.startAngle; while (sw <= 0) sw += Math.PI * 2; info.push(['Center', P(e.center), 'pt'], ['Radius', e.radius, 'len'], ['Start angle', e.startAngle, 'ang'], ['End angle', e.endAngle, 'ang'], ['Arc length', sw * e.radius, 'len']); break; }
      case 'TEXT': info.push(['Text', cleanSpecials(e.text), 's'], ['Height', e.textHeight, 'len'], ['Style', e.styleName || '', 's']); break;
      case 'MTEXT': info.push(['Text', parseMText(e.text).map(l => l.text).join('\n'), 's'], ['Height', e.textHeight, 'len'], ['Style', e.styleName || '', 's']); break;
      case 'INSERT': {
        info.push(['Block', e.name, 's'], ['Position', P(e.insertionPoint), 'pt'], ['Scale', `${+(e.xScale ?? 1).toFixed(4)} × ${+(e.yScale ?? 1).toFixed(4)}`, 's'], ['Rotation', e.rotation || 0, 'ang']);
        for (const a of e.attribs || []) info.push([a.tag || 'Attribute', cleanSpecials(a.text?.text ?? ''), 's', 'attr']);
        const b = blocks.get(e.name); if (b?.description) info.push(['Description', b.description, 's']);
        break;
      }
      case 'DIMENSION': info.push(['Measurement', e.measurement, (e.dimensionType & 7) === 2 || (e.dimensionType & 7) === 5 ? 'ang' : 'len'], ['Override text', e.text || '—', 's'], ['Style', e.styleName || '', 's']); break;
      case 'HATCH': info.push(['Pattern', e.patternName || '', 's'], ['Boundaries', (e.boundaryPaths || []).length, 'n']); break;
      case 'ELLIPSE': info.push(['Center', P(e.center), 'pt'], ['Major radius', Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y), 'len'], ['Ratio', e.axisRatio, 'n']); break;
      case 'LEADER': info.push(['Vertices', (e.vertices || []).length, 'n']); break;
      case 'MULTILEADER': info.push(['Text', parseMText(e.textContent || '').map(l => l.text).join('\n'), 's']); break;
      case 'SPLINE': info.push(['Degree', e.degree, 'n'], ['Control points', (e.controlPoints || []).length, 'n']); break;
    }
    return info;
  }

  // ---- model space ----
  const allBR = db.tables?.BLOCK_RECORD?.entries || [];
  const msBR = allBR.find(b => /^\*model_space$/i.test(b.name));
  const msHandle = msBR?.handle;
  const modelEnts = db.entities.filter(e => !msHandle || e.ownerBlockRecordSoftId === msHandle);
  const spaces = [];
  const model = flattenSpace(modelEnts);
  spaces.push({ name: 'Model', kind: 'model', ...model });

  // ---- layouts (paper space) ----
  const layoutObjs = (db.objects?.LAYOUT || []).filter(l => !/^model$/i.test(l.layoutName)).sort((a, b) => (a.tabOrder || 0) - (b.tabOrder || 0));
  for (const L of layoutObjs) {
    const br = blockByHandle.get(L.paperSpaceTableId);
    const ents = br?.entities || [];
    const sp = flattenSpace(ents);
    const vps = sp.viewports.filter(v => v.viewportId !== 1 && v.status !== 0).map(v => ({
      cx: v.viewportCenter.x, cy: v.viewportCenter.y, w: v.width, h: v.height,
      vcx: v.displayCenter.x, vcy: v.displayCenter.y, vh: v.viewHeight, twist: v.viewTwistAngle || 0,
      frozen: (v.frozenLayerIds || []).length,
    }));
    spaces.push({ name: L.layoutName, kind: 'paper', limits: [L.minLimit?.x ?? 0, L.minLimit?.y ?? 0, L.maxLimit?.x ?? 297, L.maxLimit?.y ?? 210], ...sp, vps });
  }

  // ---- bounds and origin shift ----
  const robust = (ents) => {
    const bs = ents.map(e => e.b).filter(Boolean);
    if (!bs.length) return null;
    const full = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of bs) { full[0] = Math.min(full[0], b[0]); full[1] = Math.min(full[1], b[1]); full[2] = Math.max(full[2], b[2]); full[3] = Math.max(full[3], b[3]); }
    const cx = bs.map(b => (b[0] + b[2]) / 2).sort((a, b) => a - b), cy = bs.map(b => (b[1] + b[3]) / 2).sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
    let fit = [q(cx, 0.005), q(cy, 0.005), q(cx, 0.995), q(cy, 0.995)];
    // include whole bboxes of entities whose centre is inside fit
    const f2 = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of bs) { const x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2; if (x >= fit[0] && x <= fit[2] && y >= fit[1] && y <= fit[3]) { f2[0] = Math.min(f2[0], b[0]); f2[1] = Math.min(f2[1], b[1]); f2[2] = Math.max(f2[2], b[2]); f2[3] = Math.max(f2[3], b[3]); } }
    if (f2[0] <= f2[2]) fit = f2;
    return { full, fit };
  };
  const mb = robust(spaces[0].ents) || { full: [0, 0, 1000, 1000], fit: [0, 0, 1000, 1000] };
  const origin = [Math.round(mb.fit[0]), Math.round(mb.fit[1])];

  const out = {
    meta: {
      version: db.header?.ACADVER || '', units: header.INSUNITS ?? 0, measurement: header.MEASUREMENT ?? 1,
      origin, ms: Date.now() - t0, warnings: warnings.slice(0, 50), warningCount: warnings.length,
    },
    layers, styles, spaces: [],
    blocks: [...blockCounts.entries()].map(([name, list]) => ({ name, list })).sort((a, b) => b.list.length - a.list.length),
  };
  for (const sp of spaces) {
    const shift = sp.kind === 'model';
    const ox = shift ? origin[0] : 0, oy = shift ? origin[1] : 0;
    const st = sp.st;
    const xy = new Float32Array(st.xy.length); for (let i = 0; i < st.xy.length; i += 2) { xy[i] = st.xy[i] - ox; xy[i + 1] = st.xy[i + 1] - oy; }
    const fxy = new Float32Array(st.fxy.length); for (let i = 0; i < st.fxy.length; i += 2) { fxy[i] = st.fxy[i] - ox; fxy[i + 1] = st.fxy[i + 1] - oy; }
    const snaps = new Float32Array(st.snaps.length); for (let i = 0; i < st.snaps.length; i += 2) { snaps[i] = st.snaps[i] - ox; snaps[i + 1] = st.snaps[i + 1] - oy; }
    for (const t of st.texts) { t.x -= ox; t.y -= oy; }
    for (const e of sp.ents) if (e.b) { e.b = [e.b[0] - ox, e.b[1] - oy, e.b[2] - ox, e.b[3] - oy]; }
    const bnd = robust(sp.ents);
    const polyStart = new Uint32Array(st.polyStart.length + 1); polyStart.set(st.polyStart); polyStart[st.polyStart.length] = st.xy.length / 2;
    const ringStart = new Uint32Array(st.ringStart.length + 1); ringStart.set(st.ringStart); ringStart[st.ringStart.length] = st.fxy.length / 2;
    const fillRing = new Uint32Array(st.fillRing.length + 1); fillRing.set(st.fillRing); fillRing[st.fillRing.length] = st.ringStart.length;
    out.spaces.push({
      name: sp.name, kind: sp.kind, limits: sp.limits, vps: sp.vps,
      xy, polyStart, polyStyle: Uint32Array.from(st.polyStyle), polyEnt: Uint32Array.from(st.polyEnt),
      fxy, ringStart, fillRing, fillStyle: Uint32Array.from(st.fillStyle), fillEnt: Uint32Array.from(st.fillEnt), fillKind: Uint8Array.from(st.fillKind),
      texts: st.texts, snaps, snapKind: Uint8Array.from(st.snapKind), snapLayer: Uint32Array.from(st.snapLayer),
      ents: sp.ents, bounds: bnd ? bnd.full : null, fit: bnd ? bnd.fit : null,
    });
  }
  // block instance bboxes → shift
  for (const b of out.blocks) for (const it of b.list) it.bb = [it.bb[0] - origin[0], it.bb[1] - origin[1], it.bb[2] - origin[0], it.bb[3] - origin[1]];
  out.meta.ms = Date.now() - t0;
  return out;
}

export function transferList(model) {
  const t = [];
  for (const s of model.spaces) for (const k of ['xy', 'polyStart', 'polyStyle', 'polyEnt', 'fxy', 'ringStart', 'fillRing', 'fillStyle', 'fillEnt', 'fillKind', 'snaps', 'snapKind', 'snapLayer']) t.push(s[k].buffer);
  return t;
}


// Find the drawing that a title labels: rasterise nearby entities (ignoring sheet
// borders and anything huge) into a local grid and flood-fill from just above the title.
function localIsland(ents, cx, cy, w, hh, preferBelow) {
  const R = hh * 90, cell = hh * 0.9, N = Math.ceil(2 * R / cell);
  const ox = cx - R, oy = cy - R;
  const g = new Uint8Array(N * N);
  const maxSpan = hh * 70;
  for (const e of ents) {
    const b = e.b; if (!b) continue;
    if (b[2] < ox || b[0] > ox + 2 * R || b[3] < oy || b[1] > oy + 2 * R) continue;
    if (b[2] - b[0] > maxSpan || b[3] - b[1] > maxSpan) continue;
    const x0 = Math.max(0, Math.floor((b[0] - ox) / cell)), x1 = Math.min(N - 1, Math.floor((b[2] - ox) / cell));
    const y0 = Math.max(0, Math.floor((b[1] - oy) / cell)), y1 = Math.min(N - 1, Math.floor((b[3] - oy) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y * N + x] = 1;
  }
  const tx0 = Math.max(0, Math.floor((cx - w / 2 - ox) / cell)), tx1 = Math.min(N - 1, Math.floor((cx + w / 2 - ox) / cell));
  const ty = Math.floor((cy - oy) / cell);
  // flood-fill the drawing found in a band just above (dir = 1) or below (dir = -1) the title
  const flood = (dir) => {
    const seen = new Uint8Array(N * N); const q = [];
    const tops = Math.ceil(hh * 1.3 / cell);
    for (let i = 2; i < 14 && !q.length; i++) {
      const y = dir > 0 ? ty + tops + i - 2 : ty - i; if (y < 0 || y >= N) break;
      for (let x = tx0; x <= tx1; x++) if (g[y * N + x]) { q.push(y * N + x); seen[y * N + x] = 1; }
    }
    if (!q.length) return null;
    let bx0 = N, by0 = N, bx1 = 0, by1 = 0, cnt = 0;
    while (q.length) {
      const c = q.pop(); const x = c % N, y = (c / N) | 0; cnt++;
      if (dir > 0 && y < ty) continue; // keep to the title's side
      if (dir < 0 && y > ty + tops) continue;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const n = yy * N + xx; if (g[n] && !seen[n]) { seen[n] = 1; q.push(n); }
      }
    }
    if (bx0 > bx1) return null;
    return { b: [ox + bx0 * cell, oy + by0 * cell, ox + (bx1 + 1) * cell, oy + (by1 + 1) * cell], area: (bx1 - bx0 + 1) * (by1 - by0 + 1) };
  };
  const up = preferBelow ? null : flood(1);
  const down = preferBelow || !up || up.area < 30 ? flood(-1) : null;
  let pick = preferBelow ? (down || flood(1)) : (up && (!down || up.area >= 30 || up.area >= down.area) ? up : down);
  if (!pick) return [cx - hh * 25, cy - hh * 4, cx + hh * 25, cy + hh * 30];
  const b = pick.b;
  return [Math.min(b[0], cx - w / 2), Math.min(b[1], cy - hh * 2), Math.max(b[2], cx + w / 2), Math.max(b[3], cy + hh * 1.5)];
}

// ---------- analysis: drawing titles (views) and room areas ----------
// measure(line, h) -> width in drawing units (optional; estimated otherwise)
export function analyze(model, measure) {
  const sp = model.spaces[0];
  const W = measure || ((s, h) => s.length * h * 0.6);
  const texts = sp.texts.map((t, i) => ({ ...t, i, str: t.lines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim() })).filter(t => t.str);
  const hs = texts.map(t => t.h * Math.max(...t.lines.map(l => l.hf || 1))).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)] || 1;
  const p90 = hs[Math.floor(hs.length * 0.9)] || median;

  // occupancy grid → islands of drawing
  const fit = sp.fit || sp.bounds; const islands = [];
  if (fit) {
    const N = 400; const gw = (fit[2] - fit[0]) / N || 1, gh = (fit[3] - fit[1]) / N || 1;
    const g = new Uint8Array(N * N);
    const big = Math.max(fit[2] - fit[0], fit[3] - fit[1]) * 0.35;
    for (const e of sp.ents) {
      const b = e.b; if (!b) continue;
      if (b[2] - b[0] > big || b[3] - b[1] > big) continue;
      if (e.t === 'TEXT' || e.t === 'MTEXT') continue;
      const x0 = Math.max(0, Math.floor((b[0] - fit[0]) / gw)), x1 = Math.min(N - 1, Math.floor((b[2] - fit[0]) / gw));
      const y0 = Math.max(0, Math.floor((b[1] - fit[1]) / gh)), y1 = Math.min(N - 1, Math.floor((b[3] - fit[1]) / gh));
      if (x0 > N - 1 || y0 > N - 1 || x1 < 0 || y1 < 0) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y * N + x] = 1;
    }
    // dilate once
    const d = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (g[y * N + x]) for (let yy = Math.max(0, y - 1); yy <= Math.min(N - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(N - 1, x + 1); xx++) d[yy * N + xx] = 1;
    const lab = new Int32Array(N * N).fill(-1);
    for (let i = 0; i < N * N; i++) {
      if (!d[i] || lab[i] >= 0) continue;
      const id = islands.length; const q = [i]; lab[i] = id; let bx0 = N, by0 = N, bx1 = 0, by1 = 0, cnt = 0;
      while (q.length) { const c = q.pop(); const x = c % N, y = (c / N) | 0; cnt++; bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
        for (const n of [c - 1, c + 1, c - N, c + N]) { if (n < 0 || n >= N * N) continue; if ((n === c - 1 && x === 0) || (n === c + 1 && x === N - 1)) continue; if (d[n] && lab[n] < 0) { lab[n] = id; q.push(n); } } }
      islands.push({ b: [fit[0] + bx0 * gw, fit[1] + by0 * gh, fit[0] + (bx1 + 1) * gw, fit[1] + (by1 + 1) * gh], cells: cnt });
    }
  }
  const KW = /\b(FLOOR\s?PLAN|PLAN|ELEVATIONS?|SECTIONS?|DETAILS?|LAYOUT|ROOF|FOUNDATION|FRAMING|SCHEDULE|PERSPECTIVE|LOCATION|VICINITY|DOORS|WINDOWS|ROOFPLAN|FLOORPLAN)\b/i;
  const cands = texts.filter(t => t.str.length <= 90 && KW.test(t.str) && !/^(SCALE|NOTE|SEE|REFER|\d+\.)/i.test(t.str) && !/CALLOUT/i.test(t.str) && t.h * Math.max(...t.lines.map(l => l.hf || 1)) >= median * 1.3);
  const views = [];
  for (const t of cands) {
    const hh = t.h * Math.max(...t.lines.map(l => l.hf || 1));
    const w = Math.max(...t.lines.map(l => W(l.text, t.h * (l.hf || 1)))) * (t.wf || 1);
    const cx = t.x + (0.5 - t.ax) * w, cy = t.y;
    const box = localIsland(sp.ents, cx, cy, w, hh, /\b(DOORS|WINDOWS|SCHEDULE|LEGEND|NOTES)\b/i.test(t.str));
    const name = t.lines.map(l => l.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
    views.push({ name, x: cx, y: cy, box, h: hh, ti: t.i });
  }
  // de-duplicate (same name & overlapping)
  const dedup = [];
  for (const v of views.sort((a, b) => b.h - a.h)) {
    if (dedup.some(o => o.name.toUpperCase() === v.name.toUpperCase() && Math.hypot(o.x - v.x, o.y - v.y) < Math.max(o.h, v.h) * 20)) continue;
    dedup.push(v);
  }
  // order: top-to-bottom rows, left-to-right
  dedup.sort((a, b) => (Math.abs(a.y - b.y) > Math.max(a.h, b.h) * 30 ? b.y - a.y : a.x - b.x));

  // rooms with areas
  const rooms = [];
  const AREA = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(SQ\.?\s?M\.?|SQM|M2|M²|SQ\.?\s?MTS?\.?)(?![A-Z])/i;
  for (const t of texts) {
    const full = t.lines.map(l => l.text.trim()).filter(Boolean);
    const joined = full.join(' ');
    const m = joined.match(AREA); if (!m) continue;
    const area = parseFloat(m[1].replace(/,/g, ''));
    if (!(area > 0)) continue;
    let name = joined.slice(0, m.index).replace(/[:=\-–—]+\s*$/, '').trim();
    if (!name) name = joined.slice(m.index + m[0].length).trim();
    if (!name || name.length > 60) name = name ? name.slice(0, 60) : '(unnamed)';
    // nearest view containing it
    let view = '';
    let bestD = Infinity;
    for (const v of dedup) { const b = v.box; if (t.x >= b[0] && t.x <= b[2] && t.y >= b[1] && t.y <= b[3]) { const dd = Math.hypot(t.x - v.x, t.y - v.y); if (dd < bestD) { bestD = dd; view = v.name; } } }
    rooms.push({ name, area, view, ti: t.i, x: t.x, y: t.y, raw: joined });
  }
  return { views: dedup, rooms, islands: islands.length };
}
