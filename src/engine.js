/* =====================================================================================
 *  INTEL ENGINE  -  pure algorithms (no DOM).  Used by the dashboard AND by the Node tests.
 *  Hungarian assignment · AIS interpolation quality · azimuth-shift compensation ·
 *  environmental model · explainable risk score · multi-temporal association ·
 *  AIS spoofing checks · traffic density · SAR preprocessing + CFAR + wake detection ·
 *  synthetic ground-truth benchmark + confusion-matrix metrics.
 * ===================================================================================== */
const INTEL = (function () {
  'use strict';
  const R_E = 6371008.8, KN = 0.514444;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const sig = x => 1 / (1 + Math.exp(-x));
  const CHI2_95 = 5.991, CHI2_99 = 9.210;            // 2-dof chi-square quantiles

  /* ---------------- seeded RNG ---------------- */
  function rng(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

  /* ---------------- geodesy ---------------- */
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  const enu = (lat0, lon0, lat, lon) => ({ e: rad(lon - lon0) * R_E * Math.cos(rad((lat + lat0) / 2)), n: rad(lat - lat0) * R_E });
  function fromEnu(lat0, lon0, e, n) { const lat = lat0 + deg(n / R_E); return { lat, lon: lon0 + deg(e / (R_E * Math.cos(rad((lat + lat0) / 2)))) }; }
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };

  /* ====================================================================
   *  1. HUNGARIAN ALGORITHM  (Kuhn-Munkres, O(n^2 m), rectangular)
   *     returns assign[i] = column index or -1
   * ==================================================================== */
  function hungarian(cost) {
    const n0 = cost.length; if (!n0) return [];
    const m0 = cost[0].length; if (!m0) return Array(n0).fill(-1);
    const tr = n0 > m0, n = tr ? m0 : n0, m = tr ? n0 : m0;
    const a = (i, j) => tr ? cost[j - 1][i - 1] : cost[i - 1][j - 1];
    const u = new Float64Array(n + 1), v = new Float64Array(m + 1), p = new Int32Array(m + 1), way = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0; const minv = new Float64Array(m + 1).fill(Infinity), used = new Uint8Array(m + 1);
      do {
        used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const cur = a(i0, j) - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const assign = Array(n0).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) { const i = p[j] - 1, jj = j - 1; if (tr) assign[jj] = i; else assign[i] = jj; }
    return assign;
  }

  /* ====================================================================
   *  2. AIS INTERPOLATION + QUALITY / UNCERTAINTY
   * ==================================================================== */
  function hermite(p1, p2, tMs) {
    const T = (p2.tMs - p1.tMs) / 1000, h = (tMs - p1.tMs) / (p2.tMs - p1.tMs);
    const d = enu(p1.lat, p1.lon, p2.lat, p2.lon);
    const v = (s, c) => ({ e: s * KN * Math.sin(rad(c)), n: s * KN * Math.cos(rad(c)) });
    const v1 = v(p1.sog, p1.cog), v2 = v(p2.sog, p2.cog);
    const h00 = 2 * h ** 3 - 3 * h ** 2 + 1, h10 = h ** 3 - 2 * h ** 2 + h, h01 = -2 * h ** 3 + 3 * h ** 2, h11 = h ** 3 - h ** 2;
    return fromEnu(p1.lat, p1.lon, h01 * d.e + h10 * T * v1.e + h11 * T * v2.e, h01 * d.n + h10 * T * v1.n + h11 * T * v2.n);
  }
  /** pings: sorted [{tMs,lat,lon,sog,cog}] -> interpolated state at tSarMs or null. */
  function interpolateTrack(pings, tSarMs, opts) {
    opts = opts || {};
    let p1 = null, p2 = null;
    for (const p of pings) { if (p.tMs <= tSarMs) p1 = p; if (p.tMs >= tSarMs && !p2) p2 = p; }
    let lat, lon, minDeltaSec, mode;
    if (p1 && p2 && p1.tMs !== p2.tMs) {
      const al = (tSarMs - p1.tMs) / (p2.tMs - p1.tMs);
      if (opts.method === 'hermite') { const q = hermite(p1, p2, tSarMs); lat = q.lat; lon = q.lon; mode = 'HERMITE_BRACKET'; }
      else { lat = p1.lat + al * (p2.lat - p1.lat); lon = p1.lon + al * (p2.lon - p1.lon); mode = 'LINEAR_BRACKET'; }
      minDeltaSec = Math.min(tSarMs - p1.tMs, p2.tMs - tSarMs) / 1000;
    } else {
      const nr = p1 || p2 || pings[0], dt = (tSarMs - nr.tMs) / 1000;
      if (Math.abs(dt) > 45 * 60) return null;
      const dist = nr.sog * KN * dt, c = rad(nr.cog);
      lat = nr.lat + (dist * Math.cos(c)) / 111320;
      lon = nr.lon + (dist * Math.sin(c)) / (111320 * Math.cos(rad(nr.lat)));
      minDeltaSec = Math.abs(dt); mode = 'DEAD_RECKONED';
    }
    const ref = p1 || p2 || pings[0];
    return { lat, lon, minDeltaSec, mode, ref, p1, p2, quality: aisQuality(pings, tSarMs, p1, p2, mode, ref) };
  }
  /** Brownian-bridge / dead-reckoning error model. Returns sigma (m), along/cross, 0-1 quality, grade. */
  function aisQuality(pings, tMs, p1, p2, mode, ref) {
    const s0 = 10, v = Math.max(ref.sog || 0, 0) * KN, q = (2 + 0.3 * v) ** 2;       // q: manoeuvre diffusion (m^2/s)
    let va, vc, gapMin;
    if (mode === 'LINEAR_BRACKET' || mode === 'HERMITE_BRACKET') {
      const da = (tMs - p1.tMs) / 1000, db = (p2.tMs - tMs) / 1000, vr = q * da * db / (da + db);
      va = 1.3 * vr; vc = 0.7 * vr; gapMin = (p2.tMs - p1.tMs) / 60000;
    } else {
      const nr = p1 || p2 || pings[0], dt = Math.abs(tMs - nr.tMs) / 1000;
      va = q * dt + (0.26 * dt) ** 2; vc = 0.5 * q * dt + (0.052 * v * dt) ** 2; gapMin = dt / 60;
    }
    const sa = Math.sqrt(s0 * s0 + va), sc = Math.sqrt(s0 * s0 + vc), sigma = Math.sqrt((sa * sa + sc * sc) / 2);
    const quality = Math.exp(-sigma / 250), grade = quality >= 0.8 ? 'A' : quality >= 0.6 ? 'B' : quality >= 0.4 ? 'C' : 'D';
    const ints = []; for (let i = 1; i < pings.length; i++) ints.push((pings[i].tMs - pings[i - 1].tMs) / 60000);
    return { sigmaM: sigma, sigmaAlongM: sa, sigmaCrossM: sc, quality, grade, gapMin,
      nPings: pings.length, meanIntervalMin: ints.length ? ints.reduce((a, b) => a + b, 0) / ints.length : null };
  }

  /* ====================================================================
   *  3. SAR GEOMETRY: azimuth displacement of moving ships (Doppler shift)
   * ==================================================================== */
  const SAT = { H: 693e3, V: 7100 };                         // altitude, effective ground-track speed (m/s)
  function slantRange(incDeg) {
    const look = Math.asin(R_E * Math.sin(rad(incDeg)) / (R_E + SAT.H));
    return SAT.H / Math.cos(look);
  }
  /** displacement (m) of a moving target along the flight direction. Positive = along heading. */
  function azimuthShiftM(sogKn, cogDeg, passHeadingDeg, incDeg) {
    const v = (sogKn || 0) * KN, ve = v * Math.sin(rad(cogDeg)), vn = v * Math.cos(rad(cogDeg));
    const toSat = rad(passHeadingDeg - 90);                  // right-looking radar: satellite is to the left of the heading
    const vToward = (ve * Math.sin(toSat) + vn * Math.cos(toSat)) * Math.sin(rad(incDeg));
    return (slantRange(incDeg) / SAT.V) * vToward;
  }
  /** Sentinel-1 over the Gulf: ascending passes ~ 14 UTC (heading ~349 deg), descending ~ 02 UTC (heading ~191 deg). */
  function passHeadingFor(tMs, override) {
    if (override === 'ascending') return 349; if (override === 'descending') return 191;
    return new Date(tMs).getUTCHours() >= 12 ? 349 : 191;
  }

  /* ---- 2x2 covariance helpers (ENU, metres^2) ---- */
  function cov2(sa, sc, bearingDeg) {
    const b = rad(bearingDeg), ax = Math.sin(b), ay = Math.cos(b), cx = Math.cos(b), cy = -Math.sin(b);
    return { ee: sa * sa * ax * ax + sc * sc * cx * cx, nn: sa * sa * ay * ay + sc * sc * cy * cy, en: sa * sa * ax * ay + sc * sc * cx * cy };
  }
  const addCov = (a, b) => ({ ee: a.ee + b.ee, nn: a.nn + b.nn, en: a.en + b.en });
  function mahal2(S, e, n) { const det = S.ee * S.nn - S.en * S.en; return (S.nn * e * e - 2 * S.en * e * n + S.ee * n * n) / det; }
  /** 95% ellipse polygon [[lat,lon]...] around (lat,lon) for covariance S. */
  function ellipsePoly(lat, lon, S, k2, npts) {
    k2 = k2 || CHI2_95; npts = npts || 48;
    const tr = (S.ee + S.nn) / 2, df = (S.ee - S.nn) / 2, r = Math.sqrt(df * df + S.en * S.en);
    const l1 = tr + r, l2 = Math.max(tr - r, 1e-6), th = 0.5 * Math.atan2(2 * S.en, S.ee - S.nn), out = [];
    for (let i = 0; i <= npts; i++) {
      const t = 2 * Math.PI * i / npts, x = Math.sqrt(k2 * l1) * Math.cos(t), y = Math.sqrt(k2 * l2) * Math.sin(t);
      const p = fromEnu(lat, lon, x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)); out.push([p.lat, p.lon]);
    }
    return { poly: out, semiMajorM: Math.sqrt(k2 * l1), semiMinorM: Math.sqrt(k2 * l2), angleDeg: deg(th) };
  }

  /* ====================================================================
   *  4. SAR-AIS ASSIGNMENT (global, Hungarian) with Mahalanobis cost
   * ==================================================================== */
  /**
   * dets: [{lat,lon}]  tracks: [{interpLat,interpLon,sog,cog,quality}]  p: {buffer, assignment, azComp, passHeading, inc, sarSigmaM}
   * returns {matches:[{di,ti,distM,d2,predLat,predLon,shiftM,S}], greedyMatches, hungarianMatches}
   */
  function matchDetections(dets, tracks, p) {
    const BIG = 1e9, sarS = p.sarSigmaM || 20, azSig = p.azComp ? 60 : 150, hd = p.passHeading == null ? 349 : p.passHeading, inc = p.inc || 39;
    const pairs = [], byDet = new Map();
    for (let i = 0; i < dets.length; i++) for (let j = 0; j < tracks.length; j++) {
      const t = tracks[j]; let lat = t.interpLat, lon = t.interpLon, shift = 0;
      const dtS = dets[i].dtSec || 0;                                  // detection acquired dtS seconds after the scene reference time
      if (dtS && (t.sog || 0) > 0.3) { const dd = t.sog * KN * dtS, cr = rad(t.cog || 0); lat += dd * Math.cos(cr) / 111320; lon += dd * Math.sin(cr) / (111320 * Math.cos(rad(lat))); }
      if (p.azComp) {
        shift = azimuthShiftM(t.sog, t.cog, hd, inc);
        const q = fromEnu(lat, lon, shift * Math.sin(rad(hd)), shift * Math.cos(rad(hd))); lat = q.lat; lon = q.lon;
      }
      const dist = haversine(dets[i].lat, dets[i].lon, lat, lon);
      if (dist > p.buffer) continue;
      const qa = t.quality || { sigmaAlongM: 30, sigmaCrossM: 30 };
      const S = addCov(cov2(qa.sigmaAlongM, qa.sigmaCrossM, t.cog || 0), addCov(cov2(azSig, sarS, hd), { ee: 0, nn: 0, en: 0 }));
      const d = enu(lat, lon, dets[i].lat, dets[i].lon), d2 = mahal2(S, d.e, d.n);
      const pen = (p.sizeAware !== false && dets[i].lengthM && (t.shipType || t.ship_type)) ? 0.6 * typeSizeMismatch(t.shipType || t.ship_type, dets[i].lengthM) : 0;
      pairs.push({ di: i, ti: j, distM: dist, d2, pen, predLat: lat, predLon: lon, shiftM: shift, S });
    }
    // --- greedy nearest-first baseline (what a naive pipeline does)
    const used = { d: new Set(), t: new Set() }, greedy = [];
    for (const pr of pairs.slice().sort((a, b) => a.distM - b.distM)) if (!used.d.has(pr.di) && !used.t.has(pr.ti)) { used.d.add(pr.di); used.t.add(pr.ti); greedy.push(pr); }
    if (p.assignment === 'greedy') return { matches: greedy, greedyMatches: greedy.length, hungarianMatches: null };
    // --- Hungarian on the gated, sparsified problem
    const rows = [...new Set(pairs.map(x => x.di))], cols = [...new Set(pairs.map(x => x.ti))];
    const ri = new Map(rows.map((v, k) => [v, k])), ci = new Map(cols.map((v, k) => [v, k]));
    const cost = rows.map(() => cols.map(() => BIG)), at = new Map();
    for (const pr of pairs) { const r = ri.get(pr.di), c = ci.get(pr.ti); cost[r][c] = pr.d2 + pr.pen + pr.distM / p.buffer * 1e-3; at.set(r + ':' + c, pr); }
    const asg = hungarian(cost), matches = [];
    asg.forEach((c, r) => { if (c >= 0 && cost[r][c] < BIG) matches.push(at.get(r + ':' + c)); });
    return { matches, greedyMatches: greedy.length, hungarianMatches: matches.length };
  }

  /* ====================================================================
   *  5. ENVIRONMENT MODEL
   * ==================================================================== */
  const DEFAULT_ENV = { windSpeed: 6, windDir: 315, hs: 0.8, seaState: null, incidence: 39 };
  const douglas = hs => hs < 0.1 ? 1 : hs < 0.5 ? 2 : hs < 1.25 ? 3 : hs < 2.5 ? 4 : hs < 4 ? 5 : hs < 6 ? 6 : hs < 9 ? 7 : hs < 14 ? 8 : 9;
  const beaufort = u => { const t = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7]; let b = 0; while (b < t.length && u >= t[b]) b++; return b; };
  const seaStateOf = env => env.seaState != null && env.seaState !== '' ? +env.seaState : douglas(env.hs);
  /** Simplified empirical VV sea-clutter level (dB). NOT CMOD5: wind, incidence, Hs and look-direction terms. */
  function clutterDb(env, lookAzDeg) {
    const U = Math.max(env.windSpeed, 0.5), phi = rad(env.windDir - (lookAzDeg == null ? 79 : lookAzDeg));
    return -20 + 9.5 * Math.log10(U / 5) - 0.28 * (env.incidence - 35) + 1.0 * Math.cos(2 * phi) + 0.8 * Math.log10(Math.max(env.hs, 0.1) / 0.8);
  }
  const rcsDbsm = L => 19 * Math.log10(Math.max(L, 3)) - 8;
  const NESZ_DB = -23;
  /** probability that a vessel of length L is detected (peak-pixel contrast vs CFAR threshold), 10 m GRD pixel. */
  function detectProb(L, env, lookAz, pixM) {
    pixM = pixM || 10; const pixA = pixM * pixM, peakDb = 10 * Math.log10(0.2 * Math.pow(10, rcsDbsm(L) / 10) / pixA);
    const need = 8 + 0.8 * env.hs; return sig((peakDb - clutterDb(env, lookAz) - need) / 1.5);
  }
  function minDetectableLength(env, lookAz, pixM) { for (let L = 4; L < 400; L += 0.5) if (detectProb(L, env, lookAz, pixM) >= 0.5) return L; return 400; }
  /** multiplicative confidence modifier from signal-to-clutter ratio (1 in calm seas, <1 when contrast is marginal). */
  function envConfFactor(vvDb, env, lookAz) { const scr = vvDb - clutterDb(env, lookAz); return 0.5 + 0.5 * sig((scr - 4) / 2.5); }
  /** 0..1 index of how likely sea-clutter false alarms are (wind, waves, steep incidence). */
  const falseAlarmIndex = env => clamp(0.5 * sig((env.windSpeed - 9) / 3) + 0.3 * sig((env.hs - 2) / 0.8) + 0.2 * sig((env.incidence - 42) / 4), 0, 1);

  /* ====================================================================
   *  6. AIS SPOOFING / INTEGRITY CHECKS
   * ==================================================================== */
  function spoofAnalysis(byMmsi) {
    const out = new Map();
    byMmsi.forEach((pings, mmsi) => {
      const flags = []; let maxKn = 0;
      for (let i = 1; i < pings.length; i++) {
        const a = pings[i - 1], b = pings[i], dt = (b.tMs - a.tMs) / 1000, dist = haversine(a.lat, a.lon, b.lat, b.lon);
        if (dt <= 0) { if (dist > 100) flags.push({ code: 'DUPLICATE_TIME', sev: 0.8, detail: `Two different positions at the same timestamp (${Math.round(dist)} m apart)`, t: b.tMs }); continue; }
        const kn = dist / dt / KN; maxKn = Math.max(maxKn, kn);
        const sogAvg = ((a.sog || 0) + (b.sog || 0)) / 2;
        if (kn > 45 && dist > 2000) flags.push({ code: 'TELEPORT', sev: 1.0, detail: `Implied speed ${kn.toFixed(0)} kn over ${(dt / 60).toFixed(0)} min (${(dist / 1000).toFixed(0)} km jump)`, t: b.tMs });
        else if (dt <= 7200 && Math.abs(kn - sogAvg) > Math.max(10, sogAvg)) flags.push({ code: 'SPEED_MISMATCH', sev: 0.4, detail: `Implied ${kn.toFixed(1)} kn vs reported SOG ${sogAvg.toFixed(1)} kn`, t: b.tMs });
        if (kn > 4 && (a.sog || 0) > 4 && dt <= 7200 && angDiff(bearing(a.lat, a.lon, b.lat, b.lon), a.cog || 0) > 70) flags.push({ code: 'COG_MISMATCH', sev: 0.3, detail: `Track bearing differs from reported COG by >70°`, t: b.tMs });
        if ((a.sog || 0) > 3 && dist < 30 && dt > 600) flags.push({ code: 'FROZEN_POSITION', sev: 0.5, detail: `Reports ${(a.sog).toFixed(1)} kn but position unchanged for ${(dt / 60).toFixed(0)} min`, t: b.tMs });
      }
      const score = 1 - Math.exp(-1.2 * flags.reduce((s, f) => s + f.sev, 0));
      out.set(mmsi, { score, flags, maxImpliedKn: maxKn });
    });
    return out;
  }

  /* ====================================================================
   *  7. TRAFFIC-DENSITY MODEL (historical AIS KDE + optional lane prior)
   * ==================================================================== */
  function buildDensity(pings, b, cellDeg, lanes, laneWeight) {
    const nx = Math.ceil((b.east - b.west) / cellDeg), ny = Math.ceil((b.north - b.south) / cellDeg);
    let g = new Float64Array(nx * ny);
    const add = (lat, lon, w) => { const x = Math.floor((lon - b.west) / cellDeg), y = Math.floor((lat - b.south) / cellDeg); if (x >= 0 && y >= 0 && x < nx && y < ny) g[y * nx + x] += w; };
    pings.forEach(p => add(p.lat, p.lon, 1));
    (lanes || []).forEach(poly => { for (let i = 1; i < poly.length; i++) { const [a, c] = [poly[i - 1], poly[i]], n = Math.max(2, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / (cellDeg / 2))); for (let k = 0; k <= n; k++) add(a[0] + (c[0] - a[0]) * k / n, a[1] + (c[1] - a[1]) * k / n, (laneWeight || 0) / n * 4); } });
    const kern = [0.06, 0.24, 0.4, 0.24, 0.06], blur = (src, dx, dy) => { const o = new Float64Array(nx * ny); for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { let s = 0; for (let k = -2; k <= 2; k++) { const xx = x + k * dx, yy = y + k * dy; if (xx >= 0 && yy >= 0 && xx < nx && yy < ny) s += src[yy * nx + xx] * kern[k + 2]; } o[y * nx + x] = s; } return o; };
    for (let it = 0; it < 2; it++) g = blur(blur(g, 1, 0), 0, 1);
    let max = 0, tot = 0; for (const v of g) { if (v > max) max = v; tot += v; }
    const order = Array.from(g.keys()).sort((i, j) => g[i] - g[j]), cdfV = [], cdfM = []; let acc = 0;
    for (const i of order) { acc += g[i]; cdfV.push(g[i]); cdfM.push(tot ? acc / tot : 0); }
    return { nx, ny, g, max, b, cellDeg, tot, at(lat, lon) { const x = Math.floor((lon - b.west) / cellDeg), y = Math.floor((lat - b.south) / cellDeg); return x < 0 || y < 0 || x >= nx || y >= ny ? 0 : g[y * nx + x]; },
      /** 0 = normal (busy lane) ... 1 = very unusual location */
      anomaly(lat, lon) { const v = this.at(lat, lon); let lo = 0, hi = cdfV.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (cdfV[m] <= v) { r = cdfM[m]; lo = m + 1; } else hi = m - 1; } return clamp(1 - r, 0, 1); } };
  }

  /* ====================================================================
   *  8. MULTI-TEMPORAL ASSOCIATION  (identity tracks + Hungarian linking of dark hulls)
   * ==================================================================== */
  function associate(scenes, o) {
    o = o || {}; const STAT = o.stationaryRadiusM || 2500, VMAX = (o.vmaxKn || 20) * KN, tracks = [], byDet = new Map();
    // (a) identity tracks: same MMSI seen in several passes
    const byMmsi = new Map();
    scenes.forEach((sc, si) => sc.dets.filter(d => d.status === 'AIS_MATCHED').forEach(d => { const k = d.mmsi; if (!byMmsi.has(k)) byMmsi.set(k, []); byMmsi.get(k).push({ scene: si, ...d }); }));
    byMmsi.forEach((mem, mmsi) => { if (mem.length >= 2) { const tk = { id: 'AIS-' + mmsi, kind: 'AIS', members: mem, passes: new Set(mem.map(m => m.scene)).size }; tracks.push(tk); mem.forEach(m => byDet.set(m.det_id, tk)); } });
    // (b) dark hulls: scene-to-scene linking with kinematic + signature gate
    const active = []; let nid = 1;
    scenes.forEach((sc, si) => {
      const darks = sc.dets.filter(d => d.status === 'DARK_VESSEL').map(d => ({ scene: si, ...d }));
      const cand = active.filter(t => si - t.members[t.members.length - 1].scene <= 2);
      const BIG = 1e9, cost = cand.map(t => darks.map(d => {
        const l = t.members[t.members.length - 1], dt = (sc.tMs - l.tMs) / 1000, D = haversine(l.lat, l.lon, d.lat, d.lon);
        const gate = dt <= 6 * 3600 ? Math.max(STAT, VMAX * dt) : STAT;
        if (D > gate) return BIG; const dl = Math.abs(l.estLengthM - d.estLengthM) / Math.max(l.estLengthM, d.estLengthM); if (dl > 0.35) return BIG;
        const c = 0.5 * D / gate + 0.3 * dl / 0.35 + 0.2 * Math.min(Math.abs(l.vv_db - d.vv_db) / 6, 1); return c;
      }));
      const asg = cand.length && darks.length ? hungarian(cost) : [], taken = new Set();
      asg.forEach((c, r) => { if (c >= 0 && cost[r][c] <= 0.8) { cand[r].members.push(darks[c]); taken.add(c); } });
      darks.forEach((d, i) => { if (!taken.has(i)) { const tk = { id: 'DK-' + String(nid++).padStart(2, '0'), kind: 'DARK', members: [d], passes: 1 }; tracks.push(tk); active.push(tk); } });
    });
    tracks.forEach(t => { if (t.kind === 'DARK') { t.passes = t.members.length; t.members.forEach(m => byDet.set(m.det_id, t)); } });
    const out = tracks.filter(t => t.members.length >= 2 || t.kind === 'DARK');
    out.forEach(t => { const p = t.members; let dMax = 0; for (let i = 1; i < p.length; i++) dMax = Math.max(dMax, haversine(p[0].lat, p[0].lon, p[i].lat, p[i].lon)); t.maxDriftM = dMax; });
    return { tracks: out, byDet };
  }

  /* ====================================================================
   *  9. EXPLAINABLE RISK SCORE  (additive log-odds model; each factor reported)
   * ==================================================================== */
  const TYPE_LEN = { tug: [15, 60], fishing: [8, 90], cargo: [70, 400], container: [100, 400], tanker: [100, 340], passenger: [30, 360], service: [10, 60], dredger: [40, 250] };
  function typeSizeMismatch(type, L) { const r = TYPE_LEN[String(type || '').toLowerCase()]; if (!r) return 0; if (L >= r[0] * 0.6 && L <= r[1] * 1.5) return 0; return L >= r[0] * 0.4 && L <= r[1] * 2.2 ? 0.5 : 1; }
  function riskScore(kind, f) {
    const F = []; const push = (key, label, x, w, detail) => F.push({ key, label, x: clamp(x, 0, 1), w, c: w * clamp(x, 0, 1), detail });
    let b0;
    if (kind === 'dark') {
      b0 = -3.0; const nd = f.nearestDistM == null ? Infinity : f.nearestDistM;
      push('no_ais', 'No AIS correlate', nd === Infinity ? 1 : Math.log10(Math.max(nd, f.buffer) / f.buffer), 1.5, nd === Infinity ? 'No AIS vessel in window' : `Nearest AIS ${(nd / 1000).toFixed(2)} km vs ${f.buffer} m buffer`);
      push('ais_gap', 'AIS dropout plausible', (nd < 15000 && f.nearestGapMin > 45) ? f.nearestGapMin / 180 : 0, -1.3, `Nearest AIS vessel has a ${f.nearestGapMin == null ? '–' : Math.round(f.nearestGapMin)} min reporting gap`);
      push('size', 'Large hull', (f.lengthM - 40) / 200, 0.9, `~${Math.round(f.lengthM)} m`);
      push('sar_conf', 'SAR detection confidence', f.confidence, 1.0, `${Math.round(f.confidence * 100)}% (environment-adjusted)`);
      push('env', 'Sea-clutter false-alarm risk', f.envFalseAlarm, -1.0, `FA index ${Math.round(f.envFalseAlarm * 100)}%`);
      push('persist', 'Persists across passes', (f.persistPasses - 1) / 2, 1.4, `Seen in ${f.persistPasses} pass(es) at ≈ the same place`);
      push('platform', 'Loitering near a rig (1-4 km)', f.platDistM != null && f.platDistM < 8000 ? Math.exp(-(((f.platDistM - 2000) / 1500) ** 2)) : 0, 0.9, f.platDistM == null ? '' : `${(f.platDistM / 1000).toFixed(1)} km from nearest rig`);
      push('traffic', 'Outside established traffic lanes', f.trafficAnomaly, 0.8, `Traffic anomaly ${Math.round(f.trafficAnomaly * 100)}%`);
      push('spoof', 'Nearby AIS identity shows spoofing', f.spoofNear, 1.2, f.spoofNearName ? `${f.spoofNearName} flagged near this hull` : 'none nearby');
      push('rendezvous', 'Beside a transmitting vessel (STS pattern)', f.lostTo ? 1 : 0, 1.0, f.lostTo ? 'Closest AIS vessel is already matched to another hull' : '');
      if (f.wake != null) push('wake', 'Wake visible (underway)', f.wake ? 1 : 0, 0.4, 'Radon wake detector');
    } else {
      b0 = -3.5;
      push('spoof_ais', 'AIS spoofing indicators', f.spoofScore, 3.0, (f.spoofFlags || []).join(', ') || 'none');
      push('match_stat', 'Statistical match inconsistency', (f.d2 - 2) / (CHI2_99 - 2), 1.2, `Mahalanobis d² = ${f.d2.toFixed(1)} (99% gate ${CHI2_99})`);
      push('type_size', 'Ship type vs SAR size mismatch', f.typeMismatch, 1.4, `${f.shipType || '?'} vs ~${Math.round(f.lengthM)} m`);
      push('ais_quality', 'Poor AIS interpolation quality', 1 - f.aisQuality, 0.8, `grade ${f.aisGrade || '?'}`);
      if (f.headingErrDeg != null) push('heading', 'Wake heading disagrees with AIS COG', f.headingErrDeg / 90, 1.0, `${Math.round(f.headingErrDeg)}° off`);
      push('traffic', 'Outside established traffic lanes', f.trafficAnomaly, 0.4, `Traffic anomaly ${Math.round(f.trafficAnomaly * 100)}%`);
    }
    const logit = b0 + F.reduce((s, x) => s + x.c, 0), score = Math.round(100 * sig(logit));
    return { score, level: score < 30 ? 'LOW' : score < 55 ? 'MEDIUM' : score < 75 ? 'HIGH' : 'CRITICAL', baseline: b0, logit, factors: F };
  }

  /* ====================================================================
   *  10. SAR RASTER: simulation, preprocessing, CFAR, labelling, wake detection
   * ==================================================================== */
  const mkSAT = (arr, w, h, f) => { const W = w + 1, s = new Float64Array(W * (h + 1)); for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += f ? f(arr[y * w + x]) : arr[y * w + x]; s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row; } } return s; };
  const boxSum = (s, w, x0, y0, x1, y1) => { const W = w + 1; return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0]; };
  function invNorm(p) {                                       // Acklam rational approximation
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
      b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
      c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
      d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function landMask(w, h, geo, polys) {                       // even-odd scanline fill of [lat,lon] polygons
    const m = new Uint8Array(w * h);
    polys.forEach(poly => {
      const pts = poly.map(([la, lo]) => [(lo - geo.west) / geo.dLon, (geo.north - la) / geo.dLat]);
      for (let y = 0; y < h; y++) {
        const yc = y + 0.5, xs = [];
        for (let i = 0; i < pts.length - 1; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[i + 1]; if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + (yc - y1) / (y2 - y1) * (x2 - x1)); }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) { const a = Math.max(0, Math.ceil(xs[k] - 0.5)), c = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); for (let x = a; x <= c; x++) m[y * w + x] = 1; }
      }
    });
    return m;
  }
  function boxBlur(a, w, h, r) { const s = mkSAT(a, w, h), o = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1); o[y * w + x] = boxSum(s, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0)); } return o; }

  /**
   * Simulate a calibrated SAR chip (sigma0, linear) + raw DN image.
   * spec: {bounds,pixM,env,passHeading,ships:[{lon,lat,L,headingDeg,sogKn,wake}],platforms:[{lon,lat}],landPolys,seed,enl,applyAzShift,calA,noiseDb}
   */
  function simulateRaster(spec) {
    const r = rng(spec.seed || 1), b = spec.bounds, latc = (b.north + b.south) / 2, pix = spec.pixM || 25, ENL = spec.enl || 4;
    const w = Math.round((b.east - b.west) * 111320 * Math.cos(rad(latc)) / pix), h = Math.round((b.north - b.south) * 110574 / pix);
    const geo = { west: b.west, north: b.north, dLon: (b.east - b.west) / w, dLat: (b.north - b.south) / h };
    const hd = spec.passHeading == null ? 349 : spec.passHeading, lookAz = (hd + 90) % 360, ex = Math.sin(rad(lookAz)), ey = Math.cos(rad(lookAz));
    const env = spec.env, mask = spec.landPolys && spec.landPolys.length ? landMask(w, h, geo, spec.landPolys) : new Uint8Array(w * h);
    const incAt = new Float32Array(w * h), tex0 = new Float32Array(w * h);
    for (let i = 0; i < tex0.length; i++) tex0[i] = gauss(r);
    let tex = boxBlur(boxBlur(tex0, w, h, 3), w, h, 3);        // spatially correlated sea texture
    let sd = 0; for (const v of tex) sd += v * v; sd = Math.sqrt(sd / tex.length) || 1;
    const texDb = Math.min(3, 0.4 + 0.5 * env.hs), lin = new Float32Array(w * h), pixA = pix * pix, rc = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, rngKm = ((x - w / 2) * pix * ex - (y - h / 2) * pix * ey) / 1000;     // ground-range coordinate along look direction
      const inc = env.incidence + 0.068 * rngKm; incAt[i] = inc;
      const meanDb = mask[i] ? -8 + 0.5 * tex[i] / sd * 4 : clutterDb({ ...env, incidence: inc }, lookAz) + tex[i] / sd * texDb;
      let s = 0; for (let k = 0; k < ENL; k++) s -= Math.log(1 - r()); s /= ENL;
      lin[i] = Math.pow(10, meanDb / 10) * s;
    }
    const truth = [];
    const stamp = (lon, lat, rcsM2, sA, sC, headDeg, tag) => {                      // add a gaussian-spread target (m^2 RCS -> sigma0 contribution)
      const cx = (lon - geo.west) / geo.dLon, cy = (geo.north - lat) / geo.dLat; if (cx < -5 || cy < -5 || cx > w + 5 || cy > h + 5) return null;
      const hdr = rad(headDeg), ax = Math.sin(hdr), ay = -Math.cos(hdr);                 // along-axis in image coords (y down)
      const pS = 0.6 * pix, sa = Math.sqrt(sA * sA + pS * pS) / pix, sc = Math.sqrt(sC * sC + pS * pS) / pix, R = Math.ceil(3 * Math.max(sa, sc)) + 1, wts = [];
      let tot = 0;
      for (let y = Math.floor(cy) - R; y <= Math.floor(cy) + R; y++) for (let x = Math.floor(cx) - R; x <= Math.floor(cx) + R; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue; const dx = x + 0.5 - cx - 0.0, dy = y + 0.5 - cy, u = dx * ax + dy * ay, v = -dx * ay + dy * ax, wv = Math.exp(-0.5 * ((u / sa) ** 2 + (v / sc) ** 2)); wts.push([y * w + x, wv]); tot += wv;
      }
      wts.forEach(([i, wv]) => { let s = 0; for (let k = 0; k < ENL; k++) s -= Math.log(1 - r()); lin[i] += (rcsM2 / pixA) * (wv / tot) * (s / ENL); });
      return { x: cx, y: cy };
    };
    (spec.ships || []).forEach(sh => {
      let lon = sh.lon, lat = sh.lat, shift = 0;
      if (spec.applyAzShift) { shift = azimuthShiftM(sh.sogKn, sh.headingDeg, hd, env.incidence); const q = fromEnu(lat, lon, shift * Math.sin(rad(hd)), shift * Math.cos(rad(hd))); lon = q.lon; lat = q.lat; }
      const rcs = Math.pow(10, rcsDbsm(sh.L) / 10), W = sh.L / 7, p = stamp(lon, lat, rcs, sh.L / 4, W / 4, sh.headingDeg, 'ship');
      if (sh.wake && sh.sogKn > 3) {                                                  // turbulent wake: faint line behind the hull
        const wl = clamp(sh.sogKn * 300, 1500, 5000) / pix, bd = rad((sh.headingDeg + 180) % 360), dx = Math.sin(bd), dy = -Math.cos(bd), cx0 = (lon - geo.west) / geo.dLon, cy0 = (geo.north - lat) / geo.dLat;
        for (let t = sh.L / 2 / pix + 1; t < wl; t += 0.5) { for (let q = -1; q <= 1; q++) { const x = Math.round(cx0 + dx * t - dy * q), y = Math.round(cy0 + dy * t + dx * q); if (x >= 0 && y >= 0 && x < w && y < h) lin[y * w + x] *= 1 + (spec.wakeBoost || 2.2) * Math.exp(-t / (wl * 0.6)) * (q ? 0.6 : 1); } }
      }
      truth.push({ lon: sh.lon, lat: sh.lat, L: sh.L, headingDeg: sh.headingDeg, sogKn: sh.sogKn, id: sh.id, x: p && p.x, y: p && p.y, wake: !!(sh.wake && sh.sogKn > 3), inChip: !!p });
    });
    (spec.platforms || []).forEach(pl => stamp(pl.lon, pl.lat, 3e4, 40, 40, 0, 'plat'));
    const A = spec.calA || 600, noiseLin = Math.pow(10, (spec.noiseDb == null ? -25 : spec.noiseDb) / 10), dn = new Uint16Array(w * h);
    for (let i = 0; i < dn.length; i++) dn[i] = clamp(Math.round(Math.sqrt((lin[i] + noiseLin) * A * A)), 0, 65535);
    return { w, h, pixM: pix, geo, lookAz, dn, lin, incAt, mask, truth, calA: A, noiseDb: spec.noiseDb == null ? -25 : spec.noiseDb, passHeading: hd };
  }

  /** Calibration -> noise subtraction -> incidence normalisation -> speckle filter. Returns linear sigma0 + dB image. */
  function preprocess(R, o) {
    o = o || {}; const n = R.w * R.h, lin = new Float32Array(n), A = o.calA || R.calA || 600, nz = Math.pow(10, (o.noiseDb == null ? R.noiseDb : o.noiseDb) / 10);
    const src = o.inputType || 'dn';
    for (let i = 0; i < n; i++) {
      let v = src === 'dn' ? (R.dn[i] * R.dn[i]) / (A * A) : src === 'sigma0_db' ? Math.pow(10, R.dn[i] / 10) : R.dn[i];
      if (o.noiseSub !== false && src === 'dn') v = Math.max(v - nz, 1e-6);                         // thermal-noise subtraction
      if (o.incNorm && R.incAt) v *= Math.cos(rad(o.thetaRef || 39)) / Math.cos(rad(R.incAt[i]));    // cos-law normalisation to reference angle
      lin[i] = v;
    }
    let f = lin; const ft = o.speckle || 'lee', win = o.win || 5, rr = (win - 1) >> 1;
    if (ft === 'boxcar') f = boxBlur(lin, R.w, R.h, rr);
    else if (ft === 'median') { f = new Float32Array(n); const buf = []; for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) { buf.length = 0; for (let yy = Math.max(0, y - rr); yy <= Math.min(R.h - 1, y + rr); yy++) for (let xx = Math.max(0, x - rr); xx <= Math.min(R.w - 1, x + rr); xx++) buf.push(lin[yy * R.w + xx]); buf.sort((a, b) => a - b); f[y * R.w + x] = buf[buf.length >> 1]; } }
    else if (ft === 'lee') {
      const s1 = mkSAT(lin, R.w, R.h), s2 = mkSAT(lin, R.w, R.h, v => v * v), Cu2 = 1 / (o.enl || 4.4); f = new Float32Array(n);
      for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
        const x0 = Math.max(0, x - rr), x1 = Math.min(R.w, x + rr + 1), y0 = Math.max(0, y - rr), y1 = Math.min(R.h, y + rr + 1), c = (x1 - x0) * (y1 - y0);
        const m = boxSum(s1, R.w, x0, y0, x1, y1) / c, v = Math.max(boxSum(s2, R.w, x0, y0, x1, y1) / c - m * m, 0), Ci2 = v / (m * m + 1e-12), k = Ci2 > Cu2 ? 1 - Cu2 / Ci2 : 0;
        f[y * R.w + x] = m + k * (lin[y * R.w + x] - m);
      }
    }
    const db = new Float32Array(n); for (let i = 0; i < n; i++) db[i] = 10 * Math.log10(Math.max(f[i], 1e-8));
    return { lin, filt: f, db };
  }

  /** CFAR on the (despeckled) dB image. mode 'CA' (two-parameter, SAT based) or 'OS' (median/MAD refinement of CA candidates). */
  function cfar(P, R, o) {
    o = o || {}; const w = R.w, h = R.h, G = o.guard || 6, B = o.bg || 16, pfa = o.pfa || 1e-6, k = invNorm(1 - pfa), mask = o.useMask === false ? null : R.mask;
    const data = new Float32Array(w * h), valid = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) { const ok = !(mask && mask[i]); valid[i] = ok ? 1 : 0; data[i] = ok ? P.db[i] : 0; }
    const sS = mkSAT(data, w, h), sQ = mkSAT(data, w, h, v => v * v), sC = mkSAT(valid, w, h), det = new Uint8Array(w * h), thr = new Float32Array(w * h);
    const floorDb = o.minDb == null ? -30 : o.minDb;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!valid[i]) continue;
      const ox0 = Math.max(0, x - B), ox1 = Math.min(w, x + B + 1), oy0 = Math.max(0, y - B), oy1 = Math.min(h, y + B + 1), gx0 = Math.max(0, x - G), gx1 = Math.min(w, x + G + 1), gy0 = Math.max(0, y - G), gy1 = Math.min(h, y + G + 1);
      const cnt = boxSum(sC, w, ox0, oy0, ox1, oy1) - boxSum(sC, w, gx0, gy0, gx1, gy1); if (cnt < 30) continue;
      const m = (boxSum(sS, w, ox0, oy0, ox1, oy1) - boxSum(sS, w, gx0, gy0, gx1, gy1)) / cnt, v = Math.max((boxSum(sQ, w, ox0, oy0, ox1, oy1) - boxSum(sQ, w, gx0, gy0, gx1, gy1)) / cnt - m * m, 0.25 * 0.25);
      const T = m + k * Math.sqrt(v); thr[i] = T; if (data[i] > T && data[i] > floorDb) det[i] = 1;
    }
    if (o.mode === 'OS') {                                      // robust re-test with median + MAD of the ring
      const ring = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!det[i]) continue; ring.length = 0;
        for (let yy = Math.max(0, y - B); yy <= Math.min(h - 1, y + B); yy += 2) for (let xx = Math.max(0, x - B); xx <= Math.min(w - 1, x + B); xx += 2) { if (Math.abs(xx - x) <= G && Math.abs(yy - y) <= G) continue; const j = yy * w + xx; if (valid[j]) ring.push(data[j]); }
        if (ring.length < 20) continue; ring.sort((a, b) => a - b); const med = ring[ring.length >> 1], mad = ring.map(v => Math.abs(v - med)).sort((a, b) => a - b)[ring.length >> 1] * 1.4826 + 0.25;
        if (data[i] < med + k * mad * 0.9) det[i] = 0; }
    }
    return { det, thr, k };
  }

  /** 8-connected components of a binary image (after optional dilation to merge fragments) with ship-like shape stats. */
  function components(det, P, R, o) {
    o = o || {}; const w = R.w, h = R.h, merge = o.mergePx == null ? 1 : o.mergePx, minPx = o.minPx || 2, maxPx = o.maxPx || 4000;
    let m = det;
    if (merge > 0) { m = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (det[y * w + x]) for (let yy = Math.max(0, y - merge); yy <= Math.min(h - 1, y + merge); yy++) for (let xx = Math.max(0, x - merge); xx <= Math.min(w - 1, x + merge); xx++) m[yy * w + xx] = 1; }
    const lab = new Int32Array(w * h), out = [], stack = new Int32Array(w * h); let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || lab[s]) continue; id++; let sp = 0; stack[sp++] = s; lab[s] = id; const px = [];
      while (sp) { const c = stack[--sp], cx = c % w, cy = (c / w) | 0; if (det[c]) px.push(c);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= w || y >= h) continue; const j = y * w + x; if (m[j] && !lab[j]) { lab[j] = id; stack[sp++] = j; } } }
      if (px.length < minPx || px.length > maxPx) continue;
      let sw = 0, sx = 0, sy = 0, sl = 0, pk = -1e9;
      px.forEach(i => { const wv = P.lin[i], x = i % w, y = (i / w) | 0; sw += wv; sx += wv * (x + 0.5); sy += wv * (y + 0.5); sl += wv; if (P.db[i] > pk) pk = P.db[i]; });
      const cx = sx / sw, cy = sy / sw; let mxx = 0, myy = 0, mxy = 0; px.forEach(i => { const x = (i % w) + 0.5 - cx, y = ((i / w) | 0) + 0.5 - cy; mxx += x * x; myy += y * y; mxy += x * y; }); mxx /= px.length; myy /= px.length; mxy /= px.length;
      const tr = (mxx + myy) / 2, rr = Math.sqrt(((mxx - myy) / 2) ** 2 + mxy * mxy), l1 = tr + rr + 1 / 12, l2 = Math.max(tr - rr, 0) + 1 / 12, th = 0.5 * Math.atan2(2 * mxy, mxx - myy);
      const lon = R.geo.west + cx * R.geo.dLon, lat = R.geo.north - cy * R.geo.dLat;
      out.push({ x: cx, y: cy, lon, lat, nPx: px.length, area_m2: px.length * R.pixM * R.pixM, vv_db: 10 * Math.log10(sl / px.length), peak_db: pk, lengthM: Math.sqrt(12 * l1) * R.pixM, widthM: Math.sqrt(12 * l2) * R.pixM, orientDeg: (deg(Math.atan2(Math.cos(th), Math.sin(th))) + 360) % 360 });
    }
    return out;
  }

  /** Wake detection: one-sided Radon scan behind a detection; also resolves the 180° heading ambiguity. */
  function wakeDetect(img, w, h, mask, cx, cy, pixM, lengthM, o) {
    o = o || {}; const rMin = Math.max(6, 0.75 * lengthM / pixM + 3), rMax = o.rMax || 60, nAng = o.nAng || 72, thr = o.thr || 5;
    const vals = []; for (let y = Math.max(0, Math.floor(cy - 60)); y < Math.min(h, cy + 60); y++) for (let x = Math.max(0, Math.floor(cx - 60)); x < Math.min(w, cx + 60); x++) { const d = Math.hypot(x - cx, y - cy); if (d > rMin + 2 && !(mask && mask[y * w + x])) vals.push(img[y * w + x]); }
    if (vals.length < 200) return { detected: false, score: 0 };
    vals.sort((a, b) => a - b); const med = vals[vals.length >> 1], sd = 1.4826 * vals.map(v => Math.abs(v - med)).sort((a, b) => a - b)[vals.length >> 1] + 0.1;
    const bil = (x, y) => { const x0 = Math.floor(x), y0 = Math.floor(y); if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return med; const fx = x - x0, fy = y - y0; return img[y0 * w + x0] * (1 - fx) * (1 - fy) + img[y0 * w + x0 + 1] * fx * (1 - fy) + img[(y0 + 1) * w + x0] * (1 - fx) * fy + img[(y0 + 1) * w + x0 + 1] * fx * fy; };
    const z = [];
    for (let a = 0; a < nAng; a++) { const phi = 360 * a / nAng, dx = Math.sin(rad(phi)), dy = -Math.cos(rad(phi)); let s = 0, n = 0; for (let t = rMin; t <= rMax; t += 1) { const px = cx + dx * t, py = cy + dy * t; if (mask && px >= 0 && py >= 0 && px < w && py < h && mask[(py | 0) * w + (px | 0)]) break; s += (bil(px, py) - med) / sd; n++; } z.push(n >= 12 ? s / n : 0); }
    // a wake is ONE-SIDED: the hull's own skirt is symmetric front/back, so subtract the opposite ray
    const dif = z.map((za, a) => za - Math.max(z[(a + nAng / 2 - 1) % nAng], z[(a + nAng / 2) % nAng], z[(a + nAng / 2 + 1) % nAng]));
    let best = 0; dif.forEach((v, a) => { if (v > dif[best]) best = a; });
    const oth = dif.filter((_, a) => Math.min(Math.abs(a - best), nAng - Math.abs(a - best)) > 4 && Math.min(Math.abs(a - best - nAng / 2), nAng - Math.abs(a - best - nAng / 2)) > 4), mu = oth.reduce((x, y) => x + y, 0) / oth.length, sdv = Math.sqrt(oth.reduce((x, y) => x + (y - mu) ** 2, 0) / oth.length) + 0.05;
    const score = (dif[best] - mu) / sdv, phi = 360 * best / nAng;
    return { detected: score >= thr, score, wakeDirDeg: phi, headingDeg: (phi + 180) % 360 };
  }

  /** CFAR also lights up pieces of a ship's turbulent wake. Drop small hits lying along a CONFIRMED wake ray of a larger hit. */
  function dropWakeFragments(comps, maxPx) {
    maxPx = maxPx || 160; const drop = new Set();
    comps.forEach(b => { if (!b.wake || !b.wake.detected) return; const a = rad(b.wake.wakeDirDeg), dx = Math.sin(a), dy = -Math.cos(a);
      comps.forEach((c, i) => { if (c === b || c.nPx > b.nPx * 0.6) return; const rx = c.x - b.x, ry = c.y - b.y, t = rx * dx + ry * dy, perp = Math.abs(-rx * dy + ry * dx); if (t > 0 && t < maxPx && perp < 4 + 0.08 * t) drop.add(i); }); });
    return comps.filter((_, i) => !drop.has(i));
  }

  /* ====================================================================
   *  11. VALIDATION: synthetic ground-truth benchmark + confusion matrices
   * ==================================================================== */
  const metrics = (tp, fp, fn, tn) => { const P = tp / (tp + fp || 1), Rc = tp / (tp + fn || 1), F1 = 2 * P * Rc / (P + Rc || 1), den = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)); return { tp, fp, fn, tn, precision: P, recall: Rc, f1: F1, specificity: tn / (tn + fp || 1), accuracy: (tp + tn) / (tp + fp + fn + tn || 1), mcc: den ? (tp * tn - fp * fn) / den : 0, fpr: fp / (fp + tn || 1) }; };
  function auc(pos, neg) { if (!pos.length || !neg.length) return null; let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0; return s / (pos.length * neg.length); }

  /** Build K synthetic scenes with known truth. Every ship: AIS-on | dark | spoofed. */
  function genScenes(cfg) {
    const r = rng(cfg.seed || 7), scenes = [], c0 = { lat: 25.9, lon: 55.4 }, env = cfg.env || DEFAULT_ENV;
    for (let s = 0; s < cfg.nScenes; s++) {
      const tMs = Date.UTC(2026, 9, 1 + s, s % 2 ? 2 : 14, 15), hd = passHeadingFor(tMs), ships = [], tracks = [], dets = [];
      const nShip = cfg.nShips, nCl = Math.round(nShip * (cfg.cluster == null ? 0.35 : cfg.cluster));
      for (let i = 0; i < nShip; i++) {
        const cl = i < nCl, ctr = cl ? { lat: c0.lat + 0.12 * Math.floor(i / 6), lon: c0.lon + 0.08 * (i % 3) } : null;
        const e = cl ? (r() - 0.5) * (cfg.clusterM || 2200) : (r() - 0.5) * 60000, n = cl ? (r() - 0.5) * (cfg.clusterM || 2200) : (r() - 0.5) * 60000, base = fromEnu(ctr ? ctr.lat : c0.lat, ctr ? ctr.lon : c0.lon, e, n);
        const L = Math.exp(Math.log(30) + r() * Math.log(10)), anch = cl && r() < 0.6, sog = anch ? 0.1 : 4 + r() * 12, cog = r() * 360, u = r();
        const state = u < cfg.darkFrac ? 'DARK' : u < cfg.darkFrac + cfg.spoofFrac ? 'SPOOF' : 'AIS';
        ships.push({ id: 's' + s + '_' + i, lat: base.lat, lon: base.lon, L, sog, cog, state, type: L < 45 ? 'Tug' : r() < 0.5 ? 'Cargo' : 'Tanker' });
      }
      // detections
      ships.forEach(sh => {
        if (r() > detectProb(sh.L, env, (hd + 90) % 360)) { sh.detected = false; return; }
        const sh0 = azimuthShiftM(sh.sog, sh.cog, hd, env.incidence), np = cfg.azimuth === false ? { lat: sh.lat, lon: sh.lon } : fromEnu(sh.lat, sh.lon, sh0 * Math.sin(rad(hd)), sh0 * Math.cos(rad(hd)));
        const sn = cfg.sarNoiseM || 20, q = fromEnu(np.lat, np.lon, gauss(r) * sn, gauss(r) * sn), area = sh.L * sh.L / 4.2, vv = -7 + 9 * Math.log10(sh.L / 20) + gauss(r) * 1.2;
        sh.detected = true; dets.push({ det_id: 'D' + dets.length, lat: q.lat, lon: q.lon, vv_db: vv, area_m2: area, lengthM: sh.L * (1 + 0.08 * gauss(r)), truth: sh.state === 'AIS' ? 'AIS' : 'DARK', ship: sh.id });
      });
      // false alarms (rate rises with wind / sea state), appear dim
      const nFa = Math.round(cfg.faBase * (0.2 + 2.2 * falseAlarmIndex(env)) * (0.6 + r() * 0.8));
      for (let k = 0; k < nFa; k++) { const q = fromEnu(c0.lat, c0.lon, (r() - 0.5) * 60000, (r() - 0.5) * 60000); dets.push({ det_id: 'C' + k, lat: q.lat, lon: q.lon, vv_db: clutterDb(env) + 11 + Math.abs(gauss(r)) * 3, area_m2: 300 + r() * 2200, truth: 'CLUTTER' }); }
      // AIS pings: AIS-on ships report with noise and random gaps; spoofed ships report a displaced ghost track; extra small AIS-only boats
      const pushTrack = (id, lat0, lon0, sog, cog, gap, ghost, extra) => {
        const pings = []; let t = -75 * 60000;
        while (t <= 75 * 60000) { const dt = t / 1000, st = enu(0, 0, 0, 0); void st; const q = sog < 0.5 ? fromEnu(lat0, lon0, gauss(r) * 8, gauss(r) * 8) : fromEnu(lat0, lon0, (sog * KN * dt) * Math.sin(rad(cog)) + gauss(r) * 8, (sog * KN * dt) * Math.cos(rad(cog)) + gauss(r) * 8);
          if (!(gap && t > -gap.a && t < gap.b)) pings.push({ tMs: tMs + t, lat: q.lat, lon: q.lon, sog: Math.max(0, sog + gauss(r) * 0.3), cog: (cog + gauss(r) * 3 + 360) % 360, mmsi: id });
          t += (3 + r() * 7) * 60000; }
        return pings;
      };
      ships.forEach(sh => {
        if (sh.state === 'DARK') return;
        const gap = r() < cfg.gapProb ? { a: (10 + r() * 30) * 60000, b: (15 + r() * 40) * 60000 } : null;
        let la = sh.lat, lo = sh.lon; if (sh.state === 'SPOOF') { const q = fromEnu(sh.lat, sh.lon, (r() < .5 ? -1 : 1) * (4000 + r() * 20000), (r() - 0.5) * 20000); la = q.lat; lo = q.lon; }
        const pings = pushTrack(sh.id, la, lo, sh.sog, sh.cog, gap); const iv = interpolateTrack(pings, tMs, { method: cfg.interp });
        if (iv) tracks.push({ id: sh.id, mmsi: sh.id, interpLat: iv.lat, interpLon: iv.lon, sog: iv.ref.sog, cog: iv.ref.cog, quality: iv.quality, type: sh.type, shipType: sh.type, state: sh.state });
      });
      for (let k = 0; k < 4; k++) { const q = fromEnu(c0.lat, c0.lon, (r() - 0.5) * 60000, (r() - 0.5) * 60000), pings = pushTrack('x' + s + '_' + k, q.lat, q.lon, 3 + r() * 5, r() * 360, null), iv = interpolateTrack(pings, tMs, { method: cfg.interp }); if (iv) tracks.push({ id: 'x' + s + '_' + k, mmsi: 'x' + s + '_' + k, interpLat: iv.lat, interpLon: iv.lon, sog: iv.ref.sog, cog: iv.ref.cog, quality: iv.quality, state: 'AIS_ONLY' }); }
      scenes.push({ tMs, hd, ships, dets, tracks });
    }
    return scenes;
  }
  /** Run the *same matching code as the dashboard* over generated scenes with a given algorithm configuration. */
  function evaluate(scenes, cfg) {
    const env = cfg.env || DEFAULT_ENV; let tp = 0, fp = 0, fn = 0, tn = 0, wrongId = 0, missed = 0, clutterFlag = 0, clutterTotal = 0, aisShips = 0, darkShips = 0, hungGain = 0, matrix = { AIS: { M: 0, D: 0, F: 0, N: 0 }, DARK: { M: 0, D: 0, F: 0, N: 0 }, CLUTTER: { M: 0, D: 0, F: 0, N: 0 } };
    const alertScores = [], posScores = [], negScores = [];
    for (const sc of scenes) {
      const dets = sc.dets.map(d => ({ ...d, conf: 0 }));
      dets.forEach(d => { let c = Math.min(Math.max(0.65 * clamp((d.vv_db + 12) / 18, 0, 1) + 0.35 * clamp((Math.log10(Math.max(d.area_m2, 100)) - 2.4) / 2, 0, 1), 0.12), 0.99); if (cfg.envConf) c *= envConfFactor(d.vv_db, env, (sc.hd + 90) % 360); d.conf = c; });
      const kept = dets.filter(d => d.conf >= (cfg.minConf == null ? 0.45 : cfg.minConf)), rest = dets.filter(d => d.conf < (cfg.minConf == null ? 0.45 : cfg.minConf));
      const res = matchDetections(kept, sc.tracks, { buffer: cfg.buffer || 500, assignment: cfg.assignment, azComp: cfg.azComp, passHeading: sc.hd, inc: env.incidence, sizeAware: cfg.sizeAware !== false });
      hungGain += (res.hungarianMatches == null ? 0 : res.hungarianMatches - res.greedyMatches);
      const mt = new Map(res.matches.map(m => [m.di, m]));
      kept.forEach((d, i) => {
        const m = mt.get(i), col = m ? 'M' : 'D';
        if (d.truth === 'CLUTTER') { clutterTotal++; matrix.CLUTTER[col]++; if (!m) { clutterFlag++; negScores.push(1); } return; }
        matrix[d.truth][col]++;
        if (d.truth === 'DARK') { darkShips++; if (!m) tp++; else fn++; } else { aisShips++; if (!m) fp++; else { tn++; if (sc.tracks[m.ti].id !== d.ship) wrongId++; } }
      });
      rest.forEach(d => { if (d.truth === 'CLUTTER') { clutterTotal++; matrix.CLUTTER.F++; } else matrix[d.truth].F++; });
      sc.ships.forEach(sh => { if (!sh.detected) { missed++; matrix[sh.state === 'AIS' ? 'AIS' : 'DARK'].N++; } });
    }
    const darkAll = darkShips + scenes.reduce((s, sc) => s + sc.ships.filter(x => !x.detected && x.state !== 'AIS').length, 0);
    const assoc = metrics(tp, fp, fn, tn), alerts = tp + fp + clutterFlag;
    return { assoc, wrongId, wrongIdRate: (tn ? wrongId / tn : 0), matrix, endToEnd: { alerts, precision: alerts ? tp / alerts : 0, recall: darkAll ? tp / darkAll : 0 }, clutterFlag, clutterTotal, missed, hungGain, aisShips, darkShips, darkAll };
  }
  function runBenchmark(cfg) {
    const scenes = genScenes(cfg), one = c => evaluate(scenes, { ...cfg, ...c });
    const variants = [
      { name: 'Greedy nearest-first (baseline)', c: { assignment: 'greedy', azComp: false, envConf: false } },
      { name: 'Hungarian (global assignment)', c: { assignment: 'hungarian', azComp: false, envConf: false } },
      { name: 'Hungarian + azimuth compensation', c: { assignment: 'hungarian', azComp: true, envConf: false } },
      { name: 'Hungarian + azimuth + environment-aware confidence', c: { assignment: 'hungarian', azComp: true, envConf: true } }];
    const table = variants.map(v => ({ name: v.name, ...one(v.c) }));
    const current = one({ assignment: cfg.assignment, azComp: cfg.azComp, envConf: cfg.envConf });
    const bufSweep = [100, 200, 300, 500, 750, 1000, 1500, 2000].map(b => { const e = evaluate(scenes, { ...cfg, buffer: b }); return { buffer: b, precision: e.endToEnd.precision, recall: e.endToEnd.recall, f1: e.assoc.f1 }; });
    return { scenes: scenes.length, detections: scenes.reduce((s, x) => s + x.dets.length, 0), table, current, bufSweep };
  }
  function windSweep(cfg, winds) {
    return winds.map(u => { const env = { ...(cfg.env || DEFAULT_ENV), windSpeed: u, hs: Math.min(0.2 + u * 0.18, 5) }, scenes = genScenes({ ...cfg, env }), e = evaluate(scenes, { ...cfg, env });
      const shipsTot = scenes.reduce((s, x) => s + x.ships.length, 0), det = scenes.reduce((s, x) => s + x.ships.filter(q => q.detected).length, 0);
      return { wind: u, pd: det / shipsTot, f1: e.assoc.f1, darkRecall: e.endToEnd.recall, alertPrecision: e.endToEnd.precision, clutter: e.clutterFlag, minLen: minDetectableLength(env) }; });
  }
  /** Compare current live pipeline output to user labels [{det_id,label}] with label in dark|matched|platform|clutter. */
  function confusionFromLabels(pred, labels) {
    const cls = ['dark', 'matched', 'platform', 'clutter'], M = {}; cls.forEach(a => { M[a] = {}; cls.concat(['filtered']).forEach(b => M[a][b] = 0); });
    let n = 0; labels.forEach(l => { const t = String(l.label).toLowerCase(), p = pred.get(l.det_id); if (!M[t]) return; n++; const pc = p == null ? 'filtered' : p === 'dark' ? 'dark' : p === 'matched' ? 'matched' : p === 'platform' ? 'platform' : 'filtered'; M[t][pc === 'clutter' ? 'filtered' : pc]++; });
    const tp = M.dark.dark, fn = M.dark.matched + M.dark.platform + M.dark.filtered, fp = M.matched.dark + M.platform.dark + M.clutter.dark, tn = n - tp - fn - fp;
    return { M, n, ...metrics(tp, fp, fn, tn) };
  }


  /* ====================================================================
   *  12. DATA QUALITY / PROVENANCE CHECKS
   * ==================================================================== */
  function qc(sar, ais, o) {
    o = o || {}; const aoi = o.aoi, C = [], add = (level, id, title, detail) => C.push({ level, id, title, detail });
    const cols = r => r.length ? Object.keys(r[0]) : [];
    const sc = cols(sar), ac = cols(ais), need = (have, list) => list.filter(c => !have.includes(c));
    // --- SAR schema
    const ms = need(sc, ['lon', 'lat', 'time_utc', 'vv_db', 'area_m2']);
    if (ms.length) add('fail', 'sar.schema', 'SAR file is missing required columns', 'Missing: ' + ms.join(', ') + '. Expected lon, lat, time_utc, vv_db, area_m2.'); else add('pass', 'sar.schema', 'SAR columns present', sc.join(', '));
    const ma = need(ac, ['mmsi', 'time_utc', 'lon', 'lat']);
    if (ma.length) add('fail', 'ais.schema', 'AIS file is missing required columns', 'Missing: ' + ma.join(', ')); else add('pass', 'ais.schema', 'AIS columns present', ac.join(', '));
    if (ais.length && !ac.includes('sog') || ais.length && !ac.includes('cog')) add('warn', 'ais.motion', 'AIS has no SOG/COG', 'Dead-reckoning, Hermite interpolation and azimuth-shift compensation need speed and course.');
    // --- SAR values
    const num = (rows, k) => rows.map(r => parseFloat(r[k]));
    const lon = num(sar, 'lon'), lat = num(sar, 'lat'), vv = num(sar, 'vv_db'), ar = num(sar, 'area_m2'), tms = sar.map(r => Date.parse(r.time_utc));
    const bad = (arr) => arr.filter(x => !isFinite(x)).length;
    const nbad = bad(lon) + bad(lat) + bad(vv) + bad(ar) + tms.filter(x => isNaN(x)).length;
    if (sar.length) add(nbad ? 'fail' : 'pass', 'sar.parse', nbad ? `${nbad} SAR cells are not numbers / valid timestamps` : 'All SAR numeric and time fields parse', nbad ? 'Rows with unparseable values are dropped by the pipeline silently otherwise.' : `${sar.length} rows`);
    const swapped = lat.filter((v, i) => Math.abs(v) > 90 && Math.abs(lon[i]) <= 90).length;
    if (swapped) add('fail', 'sar.latlon', 'Latitude/longitude look swapped', `${swapped} rows have |lat| > 90.`);
    if (aoi && sar.length) { const inn = lon.filter((x, i) => x >= aoi.minLon && x <= aoi.maxLon && lat[i] >= aoi.minLat && lat[i] <= aoi.maxLat).length / sar.length; add(inn < 0.5 ? 'fail' : inn < 0.9 ? 'warn' : 'pass', 'sar.aoi', `${(100 * inn).toFixed(0)}% of SAR detections fall inside the AOI box`, inn < 0.9 ? 'Detections outside the box are drawn off-view and rig masks do not apply there.' : ''); }
    const fv = vv.filter(isFinite); if (fv.length) {
      const mn = Math.min(...fv), mx = Math.max(...fv), med = fv.slice().sort((a, b) => a - b)[fv.length >> 1];
      if (mx <= 1.5 && mn >= 0) add('fail', 'sar.units', 'vv_db looks like linear σ⁰, not dB', `All values lie in ${mn.toFixed(3)}–${mx.toFixed(3)}. Convert with 10·log10(σ⁰).`);
      else if (mn > 30 || med > 20) add('fail', 'sar.units', 'vv_db looks like raw digital numbers', `Median ${med.toFixed(1)}. Calibrate to σ⁰ in dB first (SAR Lab does this for rasters).`);
      else if (mn < -45 || mx > 35) add('warn', 'sar.range', 'vv_db has implausible values', `Range ${mn.toFixed(1)} to ${mx.toFixed(1)} dB.`);
      else add('pass', 'sar.units', 'vv_db is in a plausible dB range', `${mn.toFixed(1)} to ${mx.toFixed(1)} dB (median ${med.toFixed(1)})`);
    }
    const fa = ar.filter(isFinite); if (fa.length) { const neg = fa.filter(x => x <= 0).length, huge = fa.filter(x => x > 2e5).length; add(neg ? 'fail' : huge ? 'warn' : 'pass', 'sar.area', neg ? `${neg} detections have area ≤ 0` : huge ? `${huge} blobs are larger than 0.2 km² (land or ice?)` : 'Blob areas are plausible', ''); }
    const ids = sar.map(r => r.det_id).filter(Boolean); if (ids.length && new Set(ids).size !== ids.length) add('warn', 'sar.dupid', 'Duplicate det_id values', `${ids.length - new Set(ids).size} duplicates; alerts may overwrite each other in the UI.`);
    // --- scenes
    const scenes = o.scenes || [...new Set(sar.map(r => r.time_utc))].sort();
    if (scenes.length > 12) add('warn', 'sar.scenes', `${scenes.length} distinct SAR timestamps`, 'Looks like per-detection times. Timestamps within 2 minutes are merged into one scene on load; the offset is kept as acq_time_utc.'); else if (scenes.length) add('pass', 'sar.scenes', `${scenes.length} SAR scene(s)`, scenes.map(x => x.slice(0, 16).replace('T', ' ')).join(' · '));
    const meta = ['pass_direction', 'incidence_deg', 'heading_deg', 'orbit', 'platform'].filter(c => sc.includes(c));
    add(meta.length ? 'pass' : 'warn', 'sar.meta', meta.length ? 'Orbit metadata present' : 'No orbit metadata columns', meta.length ? meta.join(', ') + ' — used for azimuth geometry.' : 'Pass direction is inferred from the UTC hour (≈02h descending, ≈14h ascending). Add pass_direction / heading_deg / incidence_deg for real data.');
    // --- AIS values
    if (ais.length) {
      const alon = num(ais, 'lon'), alat = num(ais, 'lat'), at = ais.map(r => Date.parse(r.time_utc)), nb = bad(alon) + bad(alat) + at.filter(isNaN).length;
      add(nb ? 'fail' : 'pass', 'ais.parse', nb ? `${nb} AIS cells fail to parse` : 'All AIS numeric and time fields parse', `${ais.length} pings`);
      const sentinel = ais.filter((r, i) => Math.abs(alat[i]) === 91 || Math.abs(alon[i]) === 181 || +r.sog === 102.3 || +r.sog === 1023).length; if (sentinel) add('warn', 'ais.sentinel', `${sentinel} AIS rows carry “not available” sentinel values`, 'lat 91 / lon 181 / SOG 102.3 (1023) mean unavailable; remove them.');
      const ids9 = ais.filter(r => !/^\d{9}$/.test(String(r.mmsi))).length; if (ids9) add('warn', 'ais.mmsi', `${ids9} AIS rows have a non-9-digit MMSI`, '');
      const dup = ais.length - new Set(ais.map(r => r.mmsi + '|' + r.time_utc)).size; if (dup) add('warn', 'ais.dup', `${dup} duplicate (MMSI, time) AIS rows`, 'Duplicates inflate density and can trip the duplicate-timestamp spoofing check.');
      if (sar.length && scenes.length) {
        const st = scenes.map(x => Date.parse(x)), lo = Math.min(...at.filter(isFinite)), hi = Math.max(...at.filter(isFinite));
        const covered = st.filter(t => at.some(a => Math.abs(a - t) <= 3600e3)), uncovered = scenes.length - covered.length;
        if (!st.some(t => t >= lo - 6 * 3600e3 && t <= hi + 6 * 3600e3)) add('fail', 'ais.overlap', 'AIS and SAR time ranges do not overlap', 'Every detection would be reported dark.');
        else if (uncovered) add('fail', 'ais.coverage', `${uncovered} of ${scenes.length} scenes have no AIS within ±1 h`, 'Every detection in those scenes will look dark. Fetch AIS for the missing time windows.');
        else add('pass', 'ais.coverage', 'AIS covers every scene (±1 h)', `AIS spans ${new Date(lo).toISOString().slice(0, 16)} → ${new Date(hi).toISOString().slice(0, 16)} UTC`);
        const per = new Map(); ais.forEach((r, i) => { if (!per.has(r.mmsi)) per.set(r.mmsi, []); per.get(r.mmsi).push(at[i]); });
        const gaps = []; per.forEach(a => { a.sort((x, y) => x - y); for (let i = 1; i < a.length; i++) gaps.push((a[i] - a[i - 1]) / 60000); });
        if (gaps.length) { gaps.sort((x, y) => x - y); const med = gaps[gaps.length >> 1]; add(med > 30 ? 'warn' : 'pass', 'ais.rate', `Median AIS reporting interval ${med.toFixed(1)} min`, med > 30 ? 'Sparse AIS: interpolation uncertainty will be large and false dark alerts likely.' : `${per.size} vessels, ${ais.length} pings`); }
      }
      if (o.landFn) { const onland = ais.filter((r, i) => isFinite(alat[i]) && o.landFn(alat[i], alon[i])).length; if (onland / ais.length > 0.02) add('warn', 'ais.land', `${onland} AIS pings fall on land`, 'Check coordinate order, datum, or spoofed positions. (Coarse coastline only.)'); }
    }
    // --- provenance
    add(o.synthetic ? 'warn' : (o.source ? 'pass' : 'warn'), 'prov.source', o.synthetic ? 'Synthetic data' : (o.source ? 'Source recorded' : 'No source recorded'), o.synthetic ? 'Bundled fictional dataset. Do not present results as real incidents.' : (o.source || 'Add where the files came from (e.g. COPERNICUS/S1_GRD via Earth Engine, AIS provider, query window) so results can be reproduced.'));
    const sum = { pass: 0, warn: 0, fail: 0 }; C.forEach(c => sum[c.level]++);
    return { checks: C, summary: sum, scenes, nSar: sar.length, nAis: ais.length };
  }
  /** Merge per-detection timestamps into scenes (gap > gapSec starts a new scene). Returns {rows, scenes, merged}. */
  function clusterScenes(sar, gapSec) {
    gapSec = gapSec || 120; const idx = sar.map((r, i) => ({ i, t: Date.parse(r.time_utc) })).filter(x => !isNaN(x.t)).sort((a, b) => a.t - b.t);
    const groups = []; idx.forEach(x => { const g = groups[groups.length - 1]; if (g && x.t - g[g.length - 1].t <= gapSec * 1000) g.push(x); else groups.push([x]); });
    const rows = sar.map(r => ({ ...r })); let merged = 0;
    groups.forEach(g => { const ts = g.map(x => x.t).sort((a, b) => a - b), ref = ts[ts.length >> 1], iso = new Date(ref).toISOString().replace('.000Z', 'Z'); g.forEach(x => { const r = rows[x.i]; if (r.time_utc !== iso) { r.acq_time_utc = sar[x.i].time_utc; r.time_utc = iso; merged++; } }); });
    return { rows, scenes: groups.map(g => new Date(g.map(x => x.t).sort((a, b) => a - b)[g.length >> 1]).toISOString().replace('.000Z', 'Z')), merged };
  }
  /** Per-scene orbit geometry from optional metadata columns, falling back to a UTC-hour heuristic. */
  function sceneMeta(rows, iso, override) {
    const r = rows.find(x => x.time_utc === iso) || {}, tMs = Date.parse(iso), out = { source: 'inferred from UTC hour', pass: null, heading: null, inc: null };
    const pd = String(r.pass_direction || r.orbit_pass || '').toUpperCase();
    if (override === 'ascending' || override === 'descending') { out.pass = override; out.source = 'manual override'; }
    else if (pd.startsWith('ASC')) { out.pass = 'ascending'; out.source = 'from pass_direction'; } else if (pd.startsWith('DESC')) { out.pass = 'descending'; out.source = 'from pass_direction'; }
    else out.pass = new Date(tMs).getUTCHours() >= 12 ? 'ascending' : 'descending';
    out.heading = isFinite(parseFloat(r.heading_deg)) ? parseFloat(r.heading_deg) : (out.pass === 'ascending' ? 349 : 191); if (isFinite(parseFloat(r.heading_deg))) out.source += ' + heading_deg';
    out.inc = isFinite(parseFloat(r.incidence_deg)) ? parseFloat(r.incidence_deg) : null; out.orbit = r.relative_orbit || r.orbit || null; out.platform = r.platform || null; out.mode = r.instrument_mode || null; out.pol = r.polarisation || null;
    return out;
  }

  /* ====================================================================
   *  13. ALERT EXPLANATIONS  (what, why, what else it could be, what would settle it)
   * ==================================================================== */
  function explainAlert(d, c) {
    c = c || {}; const out = { headline: '', why: [], innocent: [], settle: [], counter: [] }, F = d.risk ? Object.fromEntries(d.risk.factors.map(f => [f.key, f])) : {}, km = m => (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
    if (d.status === 'DARK_VESSEL') {
      out.headline = `${d.risk.level === 'CRITICAL' || d.risk.level === 'HIGH' ? 'Strong' : d.risk.level === 'MEDIUM' ? 'Moderate' : 'Weak'} dark-vessel candidate: a ~${d.estLengthM} m radar target with no matching AIS.`;
      out.why.push(d.nearestAis ? `Nearest AIS vessel (${d.nearestAis.name}) is ${km(d.nearestAisDistM)} away, outside the ${c.buffer} m match buffer.` : 'No AIS vessel was reported anywhere inside the ±6 h window.');
      out.why.push(`SAR confidence ${Math.round(d.confidence * 100)}%${d.envFactor != null && d.envFactor < 0.95 ? ' (reduced by sea clutter)' : ''}; backscatter ${f1x(d.vv_db)} dB.`);
      if (d.persistPasses > 1) out.why.push(`The same hull is present on ${d.persistPasses} passes within ${Math.round(d.track.maxDriftM)} m — it is staying put, not a one-off blob.`);
      if (F.platform && F.platform.x > 0.4) out.why.push(`It sits ${km(d.nearestPlatformDistM)} from a rig, a typical standoff for bunkering or transfers.`);
      if (F.traffic && F.traffic.x > 0.7) out.why.push(`It is outside the area where AIS traffic normally runs (${Math.round(d.trafficAnomaly * 100)}% unusual).`);
      if (d.spoofNear) out.why.push(`${d.spoofNear.name} (MMSI ${d.spoofNear.mmsi}) shows spoofing indicators and its reported track passes ${Math.round(d.spoofNear.distM)} m from this hull.`);
      if (d.lostTo) out.why.push('The closest AIS vessel was already assigned to a different hull, so this one is left unmatched beside a transmitting ship.');
      if (d.nearestAis && d.nearestAis.quality.gapMin > 45 && d.nearestAisDistM < 15000) out.innocent.push(`${d.nearestAis.name} had a ${Math.round(d.nearestAis.quality.gapMin)} min reporting gap; its true position at SAR time is uncertain (95% radius ≈ ${Math.round(Math.sqrt(CHI2_95) * d.nearestAis.quality.sigmaAlongM)} m) and it may simply have been silent.`);
      if (d.nearestAis && d.nearestAisDistM < 3 * c.buffer) { out.counter.push(`Would be matched to ${d.nearestAis.name} if the buffer were ≥ ${Math.ceil(d.nearestAisDistM / 50) * 50} m.`); out.innocent.push('Close to a transmitting vessel: could be position error rather than a missing transponder.'); }
      if (F.env && F.env.x > 0.35) out.innocent.push(`Rough sea (false-alarm index ${Math.round(F.env.x * 100)}%): bright wave patterns can look like a vessel.`);
      if (d.estLengthM < 40) out.innocent.push('Small target near the radar resolution limit; length and existence are uncertain.');
      if (d.confidence < 0.65) out.innocent.push('Moderate radar contrast; a lower-confidence blob.');
      if (!out.innocent.length) out.innocent.push('No strong innocent explanation in the data, but AIS dropouts and ship-to-ship manoeuvres cannot be excluded.');
      out.settle.push(d.persistPasses > 1 ? 'Check whether it is still there on the next pass.' : 'Re-image on the next pass (check whether it moved).');
      if (d.nearestAis && d.nearestAisDistM < 15000) out.settle.push(`Pull ${d.nearestAis.name}'s AIS history from a second provider to rule out a gap.`);
      out.settle.push(d.estLengthM >= 60 ? 'Task a higher-resolution sensor (optical / X-band SAR) for identification.' : 'Treat as unconfirmed; resolution is too coarse to characterise.');
    } else if (d.status === 'AIS_MATCHED') {
      const r = d.risk; out.headline = r.score >= 40 ? `Matched to ${d.matchedAis.name}, but the match has warning signs.` : `Consistent match to ${d.matchedAis.name}.`;
      out.why.push(`Detection is ${d.matchDistM} m from the interpolated AIS position (statistical distance d² = ${f1x(d.match.d2)}; 95% gate ${CHI2_95}).`);
      if (d.spoof && d.spoof.flags.length) out.why.push('AIS integrity flags: ' + d.spoof.flags.map(f => f.detail).join('; ') + '.');
      if (F.type_size && F.type_size.x > 0.4) out.why.push(`Declared type (${d.matchedAis.ship_type}) does not fit a ~${d.estLengthM} m radar target.`);
      if (d.matchedAis.quality.grade === 'C' || d.matchedAis.quality.grade === 'D') out.innocent.push(`AIS interpolation quality is only ${d.matchedAis.quality.grade} (σ ≈ ${Math.round(d.matchedAis.quality.sigmaM)} m) so the match may be coincidental.`);
      if (r.score < 40) out.innocent.push('No integrity or consistency problems found.');
      out.settle.push('Confirm identity against a second AIS source or registry.');
    } else { out.headline = 'Static platform (masked).'; out.why.push(`Within the rig mask of ${d.nearestPlatform ? d.nearestPlatform.name : 'a platform'}.`); }
    return out;
  }
  const f1x = v => (v == null || isNaN(v)) ? '–' : Number(v).toFixed(1);

  /* ====================================================================
   *  14. STATISTICAL VALIDATION SUITE
   * ==================================================================== */
  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1), sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
  const tq = n => ({ 2: 12.7, 3: 4.3, 4: 3.18, 5: 2.78, 6: 2.57, 7: 2.45, 8: 2.36, 9: 2.31, 10: 2.26 }[n] || (n < 30 ? 2.1 : 1.96));
  const summ = a => { const m = mean(a), s = sd(a), h = tq(a.length) * s / Math.sqrt(a.length); return { mean: m, sd: s, lo: m - h, hi: m + h, n: a.length }; };
  const VARIANTS = [
    { key: 'greedy', name: 'Greedy nearest-first', c: { assignment: 'greedy', azComp: false, envConf: false, sizeAware: false } },
    { key: 'hung', name: 'Hungarian', c: { assignment: 'hungarian', azComp: false, envConf: false, sizeAware: false } },
    { key: 'hung_size', name: '+ size-aware cost', c: { assignment: 'hungarian', azComp: false, envConf: false, sizeAware: true } },
    { key: 'hung_az', name: '+ azimuth compensation', c: { assignment: 'hungarian', azComp: true, envConf: false, sizeAware: true } },
    { key: 'full', name: '+ environment-aware confidence', c: { assignment: 'hungarian', azComp: true, envConf: true, sizeAware: true } }];
  function multiSeed(cfg, nSeeds, variants) {
    variants = variants || VARIANTS; const res = variants.map(v => ({ ...v, f1: [], precision: [], recall: [], mcc: [], wrongId: [], alertP: [], alertR: [] }));
    for (let k = 0; k < nSeeds; k++) { const scenes = genScenes({ ...cfg, seed: (cfg.seed || 1) * 1000 + k * 7919 + 13 }); res.forEach(v => { const e = evaluate(scenes, { ...cfg, ...v.c }); v.f1.push(e.assoc.f1); v.precision.push(e.endToEnd.precision); v.recall.push(e.endToEnd.recall); v.mcc.push(e.assoc.mcc); v.wrongId.push(e.wrongId); }); }
    const base = res[0];
    return res.map((v, i) => ({ key: v.key, name: v.name, f1: summ(v.f1), precision: summ(v.precision), recall: summ(v.recall), mcc: summ(v.mcc), wrongId: summ(v.wrongId),
      vsBase: i ? (() => { const d = v.f1.map((x, j) => x - base.f1[j]); return { ...summ(d), wins: d.filter(x => x > 1e-9).length, ties: d.filter(x => Math.abs(x) <= 1e-9).length, losses: d.filter(x => x < -1e-9).length }; })() : null }));
  }
  function ablation(cfg, nSeeds) {
    const full = { assignment: 'hungarian', azComp: true, envConf: true, sizeAware: true }, mk = (n, o) => ({ key: n, name: n, c: { ...full, ...o } });
    return multiSeed(cfg, nSeeds, [mk('Full pipeline', {}), mk('− Hungarian (use greedy)', { assignment: 'greedy' }), mk('− azimuth compensation', { azComp: false }), mk('− environment-aware confidence', { envConf: false }), mk('− size-aware cost', { sizeAware: false })]);
  }
  function stress(cfg, kind, values, nSeeds) {
    nSeeds = nSeeds || 4; const keyOf = { cluster: 'cluster', gap: 'gapProb', noise: 'sarNoiseM', dark: 'darkFrac', ships: 'nShips' }[kind];
    return values.map(v => { const c = { ...cfg, [keyOf]: v }, f = [], p = [], r = []; for (let k = 0; k < nSeeds; k++) { const sc = genScenes({ ...c, seed: (cfg.seed || 1) * 977 + k * 31 + 5 }), e = evaluate(sc, c); f.push(e.assoc.f1); p.push(e.endToEnd.precision); r.push(e.endToEnd.recall); } return { x: v, f1: summ(f), precision: summ(p), recall: summ(r) }; });
  }
  function prCurve(cfg) {
    const sc = genScenes(cfg), pts = [0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(t => { const e = evaluate(sc, { ...cfg, minConf: t }); return { t, precision: e.endToEnd.precision, recall: e.endToEnd.recall, alerts: e.endToEnd.alerts }; });
    const s = pts.slice().sort((a, b) => a.recall - b.recall), env = s.map((p, i) => ({ recall: p.recall, precision: Math.max(...s.slice(i).map(q => q.precision)) })); env.unshift({ recall: 0, precision: env[0].precision }); let ap = 0; for (let i = 1; i < env.length; i++) ap += (env[i].recall - env[i - 1].recall) * env[i].precision;   // area under the precision envelope, from recall 0
    return { pts, ap };
  }
  function selfTests() {
    const T = [], t = (name, f) => { try { const r = f(); T.push({ name, pass: r === true || (r && r.pass), detail: r && r.detail || '' }); } catch (e) { T.push({ name, pass: false, detail: 'threw: ' + e.message }); } };
    t('Hungarian is optimal (200 random rectangular matrices vs brute force)', () => { const r = rng(5); const brute = c => { const n = c.length, m = c[0].length; let best = Infinity; const used = Array(m).fill(false); (function rec(i, s) { if (s >= best) return; if (i === n) { best = s; return; } for (let j = 0; j < m; j++) if (!used[j]) { used[j] = true; rec(i + 1, s + c[i][j]); used[j] = false; } })(0, 0); return best; }; let bad = 0; for (let k = 0; k < 200; k++) { const n = 1 + Math.floor(r() * 5), m = n + Math.floor(r() * 3), c = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.floor(r() * 40))), a = hungarian(c); if (Math.abs(a.reduce((q, j, i) => q + c[i][j], 0) - brute(c)) > 1e-9) bad++; } return { pass: bad === 0, detail: bad + ' mismatches' }; });
    t('Hungarian beats greedy on the contested-pair case', () => { const a = hungarian([[1, 2], [1.1, 100]]); return a[0] === 1 && a[1] === 0; });
    t('Linear interpolation hits the midpoint; dead-reckoning refuses > 45 min', () => { const p = [{ tMs: 0, lat: 25, lon: 55, sog: 10, cog: 90 }, { tMs: 3600e3, lat: 25, lon: 55.1, sog: 10, cog: 90 }]; const a = interpolateTrack(p, 1800e3), b = interpolateTrack(p, 3600e3 + 50 * 60e3); return Math.abs(a.lon - 55.05) < 1e-9 && b === null; });
    t('AIS position error is smallest next to a real fix, peaks mid-gap and grows with gap length', () => { const mk = g => [{ tMs: 0, lat: 25, lon: 55, sog: 8, cog: 90 }, { tMs: g * 60e3, lat: 25, lon: 55.1, sog: 8, cog: 90 }]; const a = interpolateTrack(mk(10), 5 * 60e3).quality.sigmaM, b = interpolateTrack(mk(10), 1 * 60e3).quality.sigmaM, c = interpolateTrack(mk(120), 60 * 60e3).quality.sigmaM; return { pass: b < a && a < c, detail: `edge ${b.toFixed(0)} m < mid ${a.toFixed(0)} m < 2 h gap ${c.toFixed(0)} m` }; });
    t('Azimuth shift is linear in speed and flips sign with direction', () => { const a = azimuthShiftM(5, 90, 191, 39), b = azimuthShiftM(10, 90, 191, 39), c = azimuthShiftM(10, 270, 191, 39); return { pass: Math.abs(b - 2 * a) < 1e-6 && Math.abs(b + c) < 1e-6 && Math.abs(b) > 100, detail: `10 kn east: ${b.toFixed(0)} m` }; });
    t('Uncertainty ellipse covers ~95% of Gaussian samples', () => { const r = rng(9), S = cov2(60, 20, 35); let inn = 0, N = 6000; const sa = Math.sqrt(S.ee), L = [[Math.sqrt(S.ee), 0], [S.en / Math.sqrt(S.ee), Math.sqrt(Math.max(S.nn - S.en * S.en / S.ee, 1e-9))]]; for (let i = 0; i < N; i++) { const z1 = gauss(r), z2 = gauss(r), e = L[0][0] * z1, n = L[1][0] * z1 + L[1][1] * z2; if (mahal2(S, e, n) <= CHI2_95) inn++; } void sa; return { pass: Math.abs(inn / N - 0.95) < 0.015, detail: (100 * inn / N).toFixed(1) + '% inside' }; });
    t('Ellipse polygon matches its covariance (axes ratio)', () => { const S = cov2(100, 25, 0), e = ellipsePoly(25, 55, S); return { pass: Math.abs(e.semiMajorM / e.semiMinorM - 4) < 0.05, detail: `ratio ${(e.semiMajorM / e.semiMinorM).toFixed(2)}` }; });
    t('Land mask: point inside / outside a square', () => { const m = landMask(10, 10, { west: 0, north: 10, dLon: 1, dLat: 1 }, [[[8, 2], [8, 6], [2, 6], [2, 2], [8, 2]]]); return m[5 * 10 + 4] === 1 && m[0] === 0; });
    t('CFAR: empirical false-alarm rate on pure sea clutter stays far below 1e-3 (raw pixels)', () => { const R = simulateRaster({ bounds: { west: 55, east: 55.08, south: 25, north: 25.07 }, pixM: 25, env: DEFAULT_ENV, seed: 4, ships: [], landPolys: [] }), P = preprocess(R, { speckle: 'none' }), C = cfar(P, R, { pfa: 1e-6 }); let n = 0; C.det.forEach(v => n += v); const rate = n / (R.w * R.h); return { pass: rate < 1e-3, detail: `${n} hits / ${R.w * R.h} px = ${rate.toExponential(1)} (nominal 1e-6)` }; });
    t('CFAR + Lee finds a 150 m ship at 6 m/s wind', () => { const b = { west: 55, east: 55.06, south: 25, north: 25.05 }, R = simulateRaster({ bounds: b, pixM: 25, env: DEFAULT_ENV, seed: 2, ships: [{ id: 'x', lon: 55.03, lat: 25.025, L: 150, headingDeg: 90, sogKn: 0 }], landPolys: [] }), P = preprocess(R, { speckle: 'lee' }), cs = components(cfar(P, R, { pfa: 1e-6, mode: 'OS' }).det, P, R, { mergePx: 2, minPx: 3 }); return cs.some(c => haversine(25.025, 55.03, c.lat, c.lon) < 200); });
    t('Wake detector: moving ship gets a wake, anchored ship does not', () => { const b = { west: 55, east: 55.06, south: 25, north: 25.06 }, R = simulateRaster({ bounds: b, pixM: 25, env: DEFAULT_ENV, seed: 3, passHeading: 191, ships: [{ id: 'm', lon: 55.015, lat: 25.04, L: 160, headingDeg: 60, sogKn: 12, wake: true }, { id: 's', lon: 55.045, lat: 25.02, L: 160, headingDeg: 60, sogKn: 0 }], landPolys: [] }), sm = preprocess(R, { speckle: 'boxcar', win: 5 }), at = (lon, lat) => wakeDetect(sm.db, R.w, R.h, null, (lon - R.geo.west) / R.geo.dLon, (R.geo.north - lat) / R.geo.dLat, 25, 160); const a = at(55.015, 25.04), s = at(55.045, 25.02); return { pass: a.detected && !s.detected && angDiff(a.headingDeg, 60) < 15, detail: `moving ${a.score.toFixed(1)} / anchored ${s.score.toFixed(1)}` }; });
    t('Spoof detector flags a teleport and leaves a clean track alone', () => { const clean = [{ tMs: 0, lat: 25, lon: 55, sog: 10, cog: 90 }, { tMs: 600e3, lat: 25, lon: 55.0495, sog: 10, cog: 90 }], jump = [clean[0], { tMs: 600e3, lat: 25.5, lon: 56, sog: 10, cog: 90 }], r = spoofAnalysis(new Map([['a', clean], ['b', jump]])); return r.get('a').score < 0.1 && r.get('b').score > 0.6; });
    t('Multi-pass linking joins a stationary hull and ignores a far one', () => { const mk = (si, id, lat, lon) => ({ det_id: id, lat, lon, estLengthM: 100, vv_db: 3, status: 'DARK_VESSEL' }); const sc = [0, 1, 2].map(i => ({ tMs: i * 6 * 86400e3, dets: [mk(i, 'a' + i, 25.5 + 0.002 * i, 55.5), mk(i, 'z' + i, 26.2 + 0.4 * i, 56 + 0.4 * i)] })); const A = associate(sc); const ta = A.byDet.get('a2'); return ta && ta.members.length === 3 && A.byDet.get('z2').members.length === 1; });
    t('Risk score rises with persistence and falls with a plausible AIS gap', () => { const base = { nearestDistM: 4000, buffer: 500, nearestGapMin: 10, lengthM: 100, confidence: .8, envFalseAlarm: .2, persistPasses: 1, platDistM: null, trafficAnomaly: .5, spoofNear: 0 }, a = riskScore('dark', base).score, b = riskScore('dark', { ...base, persistPasses: 3 }).score, c = riskScore('dark', { ...base, nearestGapMin: 150 }).score; return { pass: b > a && c < a, detail: `${a} → persist ${b}, gap ${c}` }; });
    t('Time-offset aware matching moves the prediction along COG', () => { const tr = [{ interpLat: 25, interpLon: 55, sog: 20, cog: 90, quality: { sigmaAlongM: 30, sigmaCrossM: 30 } }]; const d0 = [{ lat: 25, lon: 55.003 }], d1 = [{ lat: 25, lon: 55.003, dtSec: 15 }]; const a = matchDetections(d0, tr, { buffer: 500 }).matches[0].distM, b = matchDetections(d1, tr, { buffer: 500 }).matches[0].distM; return { pass: b < a, detail: `${a.toFixed(0)} m → ${b.toFixed(0)} m` }; });
    t('Data QC catches linear σ⁰, missing AIS coverage and swapped lat/lon', () => { const sar = [{ lon: '55', lat: '25', time_utc: '2026-01-01T00:00:00Z', vv_db: '0.02', area_m2: '900' }, { lon: '55.1', lat: '25.1', time_utc: '2026-01-01T00:00:00Z', vv_db: '0.5', area_m2: '900' }], ais = [{ mmsi: '470000001', time_utc: '2026-02-01T00:00:00Z', lon: '55', lat: '25' }], r = qc(sar, ais, {}), has = id => r.checks.some(c => c.id === id && c.level === 'fail'); const sw = qc([{ lon: '25', lat: '120', time_utc: '2026-01-01T00:00:00Z', vv_db: '3', area_m2: '10' }], [], {}); return has('sar.units') && (has('ais.overlap') || has('ais.coverage')) && sw.checks.some(c => c.id === 'sar.latlon'); });
    t('Scene clustering merges per-detection times within 2 minutes', () => { const c = clusterScenes([{ time_utc: '2026-01-01T00:00:00Z' }, { time_utc: '2026-01-01T00:00:20Z' }, { time_utc: '2026-01-02T00:00:00Z' }]); return c.scenes.length === 2 && c.merged >= 1; });
    t('Benchmark generator is deterministic for a given seed', () => { const a = JSON.stringify(genScenes({ seed: 3, nScenes: 2, nShips: 10, darkFrac: .2, spoofFrac: .05, faBase: 4, gapProb: .2 })), b = JSON.stringify(genScenes({ seed: 3, nScenes: 2, nShips: 10, darkFrac: .2, spoofFrac: .05, faBase: 4, gapProb: .2 })); return a === b; });
    return T;
  }

  return { rng, gauss, haversine, enu, fromEnu, bearing, angDiff, hungarian, interpolateTrack, aisQuality, azimuthShiftM, slantRange, passHeadingFor, cov2, addCov, mahal2, ellipsePoly, matchDetections,
    DEFAULT_ENV, douglas, beaufort, seaStateOf, clutterDb, rcsDbsm, NESZ_DB, detectProb, minDetectableLength, envConfFactor, falseAlarmIndex, spoofAnalysis, buildDensity, associate, typeSizeMismatch, riskScore,
    simulateRaster, preprocess, cfar, components, wakeDetect, dropWakeFragments, landMask, invNorm, metrics, auc, genScenes, evaluate, runBenchmark, windSweep, confusionFromLabels, CHI2_95, CHI2_99, clamp, sig, qc, clusterScenes, sceneMeta, explainAlert, multiSeed, ablation, stress, prCurve, selfTests, VARIANTS, summ };
})();
if (typeof module !== 'undefined') module.exports = INTEL;
