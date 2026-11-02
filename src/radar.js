/* ===== Radar scope: PPI geometry, range rings, bearing ring, sweep, phosphor decay, cursor / EBL-VRM readouts ===== */
(function () {
  'use strict';
  if (typeof map === 'undefined' || !map) { window.addEventListener('load', () => setTimeout(boot, 50)); } else boot();
  const NM = 1852, REF = { lat: 25.75, lon: 55.72 }, RANGES = [3, 6, 12, 24, 48, 75, 120];
  const st = { internal: false, range: 75, sweep: true, phos: true, rings: true, ebl: null, cur: null, S: 0 };
  let stage, cv, ctx, sweepEl, ringSvg, hudInfo, hudCur, hudCtl;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  function brg(a, b) { const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat)), x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng)); return (deg(Math.atan2(y, x)) + 360) % 360; }
  const pad3 = v => String(Math.round(v)).padStart(3, '0');
  const dm = (v, ax) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60, h = ax === 'lat' ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W'); return `${String(d).padStart(ax === 'lat' ? 2 : 3, '0')}°${m.toFixed(3).padStart(6, '0')}'${h}`; };

  function boot() {
    const mapEl = document.getElementById('map'); if (!mapEl || !window.map || mapEl.dataset.radar) return; mapEl.dataset.radar = 1;
    stage = mapEl.parentElement; stage.classList.add('scope-stage');
    map.options.zoomSnap = 0; map.options.zoomDelta = 0.5; map.dragging.disable(); map.doubleClickZoom.disable(); map.scrollWheelZoom.disable(); map.touchZoom.disable(); map.boxZoom.disable(); map.keyboard.disable();
    ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); ringSvg.setAttribute('class', 'scope-ring'); stage.appendChild(ringSvg);
    sweepEl = document.createElement('div'); sweepEl.id = 'scopeSweep'; stage.appendChild(sweepEl);
    cv = document.createElement('canvas'); cv.id = 'scopeCv'; stage.appendChild(cv); ctx = cv.getContext('2d');
    hudInfo = hud('top:8px;left:8px'); hudCur = hud('bottom:8px;left:8px;min-width:210px'); hudCtl = hud('top:8px;left:8px;margin-top:92px', 'ctl');
    hudCtl.innerHTML = `<div class="cap">RANGE (NM)</div><div class="rrow" id="rngRow">${RANGES.map(r => `<button class="rbtn" data-r="${r}">${r}</button>`).join('')}</div>
      <div class="cap" style="margin-top:3px">DISPLAY</div>
      <div class="rrow"><button class="rbtn on" id="btnSweep" title="Rotating sweep line">SWEEP</button><button class="rbtn on" id="btnPhos" title="Echoes brighten as the sweep passes and fade afterwards">PERSIST</button></div>
      <div class="rrow"><button class="rbtn on" id="btnRings" title="Fixed range rings">RINGS</button><button class="rbtn" id="btnEbl" title="Clear the electronic bearing line / variable range marker">CLR EBL</button></div>
      <div class="cap" style="margin-top:3px;max-width:150px;white-space:normal;line-height:1.3">Click the scope to place EBL / VRM.</div>`;
    hudCtl.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.r) setRange(+b.dataset.r);
      else if (b.id === 'btnSweep') { st.sweep = !st.sweep; stage.classList.toggle('nosweep', !st.sweep); b.classList.toggle('on', st.sweep); }
      else if (b.id === 'btnPhos') { st.phos = !st.phos; b.classList.toggle('on', st.phos); if (!st.phos) tgt().forEach(t => t.el.style.opacity = ''); }
      else if (b.id === 'btnRings') { st.rings = !st.rings; b.classList.toggle('on', st.rings); draw(); }
      else if (b.id === 'btnEbl') { st.ebl = null; draw(); readouts(); }
    });
    const btnR = document.getElementById('btnResetBounds'); if (btnR) btnR.addEventListener('click', e => { e.stopImmediatePropagation(); autoFit(); }, true);
    map.on('mousemove', e => { st.cur = e.latlng; readouts(); });
    map.on('mouseout', () => { st.cur = null; readouts(); });
    map.on('click', e => { st.ebl = { ll: e.latlng }; draw(); readouts(); });
    map.on('zoomend moveend', () => { sync(); draw(); readouts(); });
    window.addEventListener('resize', () => { layout(); });
    const btnV = document.getElementById('btnBaseVector'), btnO = document.getElementById('btnBaseOsmDark'), btnE = document.getElementById('btnBaseEsriSat');
    if (btnV) btnV.textContent = 'Radar chart'; if (btnO) btnO.textContent = 'Dark chart'; if (btnE) btnE.textContent = 'Satellite';
    const o = { setView: map.setView, flyTo: map.flyTo, panTo: map.panTo, fitBounds: map.fitBounds }, refLL = () => L.latLng(REF.lat, REF.lon);
    const need = d => RANGES.find(r => r >= d * 1.25) || RANGES[RANGES.length - 1];
    map.setView = function (ll) { if (st.internal) return o.setView.apply(map, arguments); setRange(need(refLL().distanceTo(L.latLng(ll)) / NM)); return map; };
    map.flyTo = function (ll) { if (st.internal) return o.flyTo.apply(map, arguments); setRange(need(refLL().distanceTo(L.latLng(ll)) / NM)); return map; };
    map.panTo = function (ll) { if (st.internal) return o.panTo.apply(map, arguments); setRange(need(refLL().distanceTo(L.latLng(ll)) / NM)); return map; };
    map.fitBounds = function (b) { if (st.internal) return o.fitBounds.apply(map, arguments); const bb = L.latLngBounds(b), d = Math.max(...[bb.getNorthEast(), bb.getSouthWest(), bb.getNorthWest(), bb.getSouthEast()].map(c => refLL().distanceTo(c))) / NM; setRange(need(d)); return map; };
    st.orig = o; st.autoFit = autoFit;
    const _ld = window.loadDatasetIntoApp; if (_ld) window.loadDatasetIntoApp = function () { const r = _ld.apply(this, arguments); setTimeout(autoFit, 30); return r; };
    layout(); autoFit(); if (typeof setBasemapMode === 'function') setBasemapMode('VECTOR_ONLY');
    setTimeout(layout, 300); setTimeout(layout, 1200);
    requestAnimationFrame(loop);
  }
  function hud(css, cls) { const d = document.createElement('div'); d.className = 'hud ' + (cls || ''); d.style.cssText += css; stage.appendChild(d); return d; }

  function layout() {
    if (!stage) return; const W = stage.clientWidth, H = stage.clientHeight, M = 34, S = Math.max(220, Math.floor(Math.min(W, H) - 2 * M - 4)), L = Math.round((W - S) / 2), T = Math.round((H - S) / 2);
    st.S = S; const m = document.getElementById('map'); m.style.cssText += `;left:${L}px;top:${T}px;width:${S}px;height:${S}px;right:auto;bottom:auto`;
    [cv, sweepEl].forEach(e => { e.style.left = L + 'px'; e.style.top = T + 'px'; e.style.width = S + 'px'; e.style.height = S + 'px'; });
    const dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = S * dpr; cv.height = S * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = S / 2 + M; ringSvg.style.cssText = `left:${L - M}px;top:${T - M}px;width:${S + 2 * M}px;height:${S + 2 * M}px`; ringSvg.setAttribute('viewBox', `0 0 ${S + 2 * M} ${S + 2 * M}`); drawRing(S, M);
    map.invalidateSize(false); setRange(st.range, true);
  }
  function drawRing(S, M) {
    const c = S / 2 + M, r0 = S / 2 + 3, r1 = r0 + 26; let g = `<circle cx="${c}" cy="${c}" r="${r1 + 1}" fill="#071b30" stroke="#04101f" stroke-width="2"/><circle cx="${c}" cy="${c}" r="${r0}" fill="none" stroke="#3a638f" stroke-width="1.5"/><circle cx="${c}" cy="${c}" r="${r1}" fill="none" stroke="#3a638f" stroke-width="1"/>`;
    for (let a = 0; a < 360; a += 1) { const big = a % 10 === 0, mid = a % 5 === 0, l = big ? 11 : mid ? 7 : 4; g += `<line x1="${c}" y1="${c - r0}" x2="${c}" y2="${c - r0 - l}" stroke="${big ? '#cfe3ff' : '#6f93bd'}" stroke-width="${big ? 1.4 : 0.8}" transform="rotate(${a} ${c} ${c})"/>`; }
    for (let a = 0; a < 360; a += 10) { const lab = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : pad3(a); g += `<text x="${c}" y="${c - r0 - 14}" text-anchor="middle" font-family="Consolas,monospace" font-size="${a % 90 === 0 ? 12 : 9.5}" font-weight="${a % 90 === 0 ? 700 : 400}" fill="${a === 0 ? '#f2c935' : '#cfe3ff'}" transform="rotate(${a} ${c} ${c})">${lab}</text>`; }
    ringSvg.innerHTML = g;
  }
  function autoFit() {
    const pts = []; try { (appState.sarData || []).forEach(r => pts.push([+r.lat, +r.lon])); } catch (e) { }
    const v = pts.filter(p => isFinite(p[0]) && isFinite(p[1])); if (!v.length) return;
    const la = v.map(p => p[0]), lo = v.map(p => p[1]); REF.lat = (Math.min(...la) + Math.max(...la)) / 2; REF.lon = (Math.min(...lo) + Math.max(...lo)) / 2;
    const c = L.latLng(REF.lat, REF.lon), d = Math.max(...v.map(p => c.distanceTo(L.latLng(p[0], p[1])))) / NM; setRange(RANGES.find(r => r >= d * 1.25) || 120);
  }
  function setRange(nm, quiet) {
    st.range = nm; const S = st.S || map.getSize().x, c = L.latLng(REF.lat, REF.lon), dLat = nm * NM / 111320, dLon = dLat / Math.cos(rad(REF.lat));
    st.internal = true; try { st.orig.fitBounds.call(map, [[REF.lat - dLat, REF.lon - dLon], [REF.lat + dLat, REF.lon + dLon]], { animate: false, padding: [0, 0] }); } finally { st.internal = false; } void c; void S;
    document.querySelectorAll('#rngRow .rbtn').forEach(b => b.classList.toggle('on', +b.dataset.r === nm)); sync(); draw(); readouts();
  }
  function mpp() { const S = st.S, a = map.containerPointToLatLng([S / 2, S / 2]), b = map.containerPointToLatLng([S / 2 + 100, S / 2]); return map.distance(a, b) / 100; }
  function sync() { if (!st.S) return; const r = mpp() * st.S / 2 / NM; st.rangeNm = r; }
  function niceStep(r) { const c = [0.25, 0.5, 1, 2, 3, 4, 6, 12, 15, 20, 25]; for (const s of c) if (r / s <= 6) return s; return 25; }
  function draw() {
    if (!ctx || !st.S) return; const S = st.S, c = S / 2; ctx.clearRect(0, 0, S, S); const m = mpp(), rNm = m * c / NM, step = niceStep(rNm);
    ctx.lineWidth = 1; ctx.font = '11px Consolas,monospace'; ctx.textAlign = 'left';
    if (st.rings) { for (let k = step; k < rNm; k += step) { const r = k * NM / m; ctx.strokeStyle = 'rgba(120,255,170,.38)'; ctx.beginPath(); ctx.arc(c, c, r, 0, 7); ctx.stroke(); ctx.fillStyle = 'rgba(160,255,190,.9)'; ctx.fillText(k + ' NM', c + r * 0.7071 + 3, c - r * 0.7071 - 2); }
      ctx.strokeStyle = 'rgba(120,255,170,.22)'; ctx.beginPath(); for (let a = 0; a < 360; a += 30) { const x = Math.sin(rad(a)), y = -Math.cos(rad(a)); ctx.moveTo(c, c); ctx.lineTo(c + x * c, c + y * c); } ctx.stroke(); }
    ctx.strokeStyle = '#46e07a'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(c, c, 4, 0, 7); ctx.moveTo(c, c - 4); ctx.lineTo(c, c - 18); ctx.stroke(); ctx.fillStyle = '#46e07a'; ctx.fillRect(c - 1, c - 1, 2, 2);
    if (st.ebl) { const p = map.latLngToContainerPoint(st.ebl.ll), d = Math.hypot(p.x - c, p.y - c); ctx.strokeStyle = '#f2c935'; ctx.lineWidth = 1.3; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + (p.x - c) / d * c * 1.42, c + (p.y - c) / d * c * 1.42); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(c, c, d, 0, 7); ctx.stroke(); }
    ctx.fillStyle = 'rgba(0,0,0,0)';
  }
  function tgt() {
    const base = stage.getBoundingClientRect(), mb = document.getElementById('map').getBoundingClientRect(), cx = mb.left + mb.width / 2, cy = mb.top + mb.height / 2;
    return [...stage.querySelectorAll('.matched-vessel-icon,.platform-marker-icon')].map(el => { const r = el.getBoundingClientRect(), x = r.left + r.width / 2 - cx, y = r.top + r.height / 2 - cy; return { el, a: (deg(Math.atan2(x, -y)) + 360) % 360 }; });
  }
  let cache = [], tCache = 0;
  function loop(t) {
    if (st.sweep && st.phos && document.getElementById('viewOpsMap') && !document.getElementById('viewOpsMap').classList.contains('hidden')) {
      if (t - tCache > 400) { cache = tgt(); tCache = t; }
      const an = sweepEl.getAnimations && sweepEl.getAnimations()[0], ph = an ? (an.currentTime % 4500) / 4500 : (t % 4500) / 4500, th = ph * 360;
      for (const o of cache) { const age = (th - o.a + 360) % 360; o.el.style.opacity = (0.22 + 0.78 * Math.exp(-age / 95)).toFixed(2); }
    }
    requestAnimationFrame(loop);
  }
  function readouts() {
    if (!hudInfo) return; const r = st.rangeNm || st.range, step = niceStep(r);
    hudInfo.innerHTML = `<span class="cap">RANGE</span> <b class="v">${r.toFixed(r < 10 ? 1 : 0)} NM</b> &nbsp;<span class="cap">RINGS</span> <b class="v">${step} NM</b><br><span class="cap">NORTH UP · STABILISED</span><br><span class="cap">REF</span> ${dm(REF.lat, 'lat')} ${dm(REF.lon, 'lon')}`;
    const refLL = L.latLng(REF.lat, REF.lon), row = (lbl, ll, cls) => { if (!ll) return `<span class="cap">${lbl}</span> <span class="v">---</span><br>`; const d = refLL.distanceTo(ll) / NM; return `<span class="cap">${lbl}</span> RNG <b class="${cls}">${d.toFixed(2)}</b> NM &nbsp;BRG <b class="${cls}">${pad3(brg(refLL, ll))}</b>°<br><span class="cap">&nbsp;&nbsp;&nbsp;&nbsp;</span>${dm(ll.lat, 'lat')} ${dm(ll.lng, 'lon')}<br>`; };
    hudCur.innerHTML = row('CURSOR', st.cur, 'v') + row('EBL/VRM', st.ebl && st.ebl.ll, 'a');
  }
  window.radarScope = { setRange, layout, autoFit, state: st };
})();
