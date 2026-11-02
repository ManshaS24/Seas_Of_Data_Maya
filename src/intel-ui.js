/* =====================================================================================
 *  INTEL UI LAYER  - overrides the baseline pipeline with the INTEL engine and adds
 *  Intelligence / Environment / SAR Lab / Validation views.  Loaded AFTER the main script.
 * ===================================================================================== */
(function () {
  'use strict';
  const I = INTEL, $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f1 = (x, d = 1) => (x == null || isNaN(x)) ? '–' : Number(x).toFixed(d);
  const pct = x => (x == null || isNaN(x)) ? '–' : (100 * x).toFixed(1) + '%';
  const RISK_COL = { LOW: '#64748b', MEDIUM: '#f5b301', HIGH: '#fb8a3c', CRITICAL: '#ff4d4f' };

  /* ---------------- state ---------------- */
  const S = window.intelState = {
    assignment: 'hungarian', interp: 'linear', azComp: false, envConf: true, passOverride: 'auto',
    env: { ...I.DEFAULT_ENV }, envSource: 'manual defaults',
    subs: [], assoc: null, spoof: new Map(), density: null, dataKey: null, lastDiff: [],
    lab: null, bench: null, sweep: null, labels: null
  };

  /* ---------------- helpers ---------------- */
  function lanePolys() { return (typeof SHIPPING_LANES !== 'undefined') ? SHIPPING_LANES.map(l => l.coords) : []; }
  function ensureDataCaches() {
    if (S.dataKey === appState.aisData) return;
    S.dataKey = appState.aisData;
    const by = new Map(), all = [];
    appState.aisData.forEach(r => {
      const tMs = Date.parse(r.time_utc); if (isNaN(tMs)) return;
      const p = { tMs, lat: +r.lat, lon: +r.lon, sog: +r.sog || 0, cog: +r.cog || 0, name: r.name };
      all.push(p); const k = String(r.mmsi); if (!by.has(k)) by.set(k, []); by.get(k).push(p);
    });
    by.forEach(a => a.sort((x, y) => x.tMs - y.tMs));
    S.spoof = I.spoofAnalysis(by);
    S.pingsByMmsi = by;
    S.density = I.buildDensity(all, { west: AOI_BOUNDS.minLon, east: AOI_BOUNDS.maxLon, south: AOI_BOUNDS.minLat, north: AOI_BOUNDS.maxLat }, 0.02, lanePolys(), all.length / 40);
  }
  const sceneMeta = iso => I.sceneMeta(appState.sarData || [], iso, S.passOverride);
  const passHeading = iso => sceneMeta(iso).heading;
  const lookAz = iso => (passHeading(iso) + 90) % 360;

  /* ---------------- 1. AIS interpolation (with uncertainty) ---------------- */
  window.interpolateAisToSarTime = function (aisRows, sceneTimeIso) {
    const tSar = Date.parse(sceneTimeIso), by = new Map();
    aisRows.forEach(r => {
      const tMs = Date.parse(r.time_utc); if (isNaN(tMs) || Math.abs(tMs - tSar) > 6 * 3600e3) return;
      const m = String(r.mmsi); if (!by.has(m)) by.set(m, []);
      by.get(m).push({ mmsi: m, time_utc: r.time_utc, tMs, lon: +r.lon, lat: +r.lat, sog: +r.sog || 0, cog: +r.cog || 0, name: r.name || `VESSEL-${m}`, ship_type: r.ship_type || 'Unspecified' });
    });
    const out = [];
    by.forEach((pings, mmsi) => {
      pings.sort((a, b) => a.tMs - b.tMs);
      const iv = I.interpolateTrack(pings, tSar, { method: S.interp }); if (!iv) return;
      out.push({ mmsi, sceneTimeIso, name: iv.ref.name, ship_type: iv.ref.ship_type, sog: iv.ref.sog, cog: iv.ref.cog,
        interpLat: +iv.lat.toFixed(5), interpLon: +iv.lon.toFixed(5), minDeltaMin: +(iv.minDeltaSec / 60).toFixed(1), mode: iv.mode,
        quality: iv.quality, rawPings: pings });
    });
    return out;
  };

  /* ---------------- 2. single-scene pipeline (Hungarian / greedy, Mahalanobis, env-aware) ---------------- */
  window.runSingleScenePipeline = function (sarRows, aisRows, sceneTimeIso, params) {
    const { matchBufferMeters, minConfidence, platformBufferMeters } = params, env = S.env;
    const la = lookAz(sceneTimeIso), raw = sarRows.filter(r => r.time_utc === sceneTimeIso).map((r, idx) => {
      const lon = +r.lon, lat = +r.lat, vv_db = +r.vv_db, area_m2 = +r.area_m2, { estLengthM, confidence } = computeSarSignatureMetrics(vv_db, area_m2);
      let np = null, md = Infinity; KNOWN_OFFSHORE_PLATFORMS.forEach(p => { const d = haversineMeters(lat, lon, p.lat, p.lon); if (d < md) { md = d; np = p; } });
      const fac = S.envConf ? I.envConfFactor(vv_db, env, la) : 1, conf = +Math.min(Math.max(confidence * fac, 0.05), 0.99).toFixed(2);
      const lenIn = parseFloat(r.length_m), acq = r.acq_time_utc ? (Date.parse(r.acq_time_utc) - Date.parse(sceneTimeIso)) / 1000 : 0;
      return { det_id: r.det_id || `S1-DET-${idx + 1}`, lon, lat, time_utc: r.time_utc, vv_db, area_m2, estLengthM: isFinite(lenIn) ? Math.round(lenIn) : estLengthM, lengthM: isFinite(lenIn) ? lenIn : estLengthM, dtSec: isFinite(acq) && Math.abs(acq) < 600 ? acq : 0, confidence: conf, confidenceRaw: confidence, envFactor: fac,
        nearestPlatform: np, nearestPlatformDistM: Math.round(md) };
    });
    const lowConf = [], conf = []; raw.forEach(d => (d.confidence < minConfidence ? lowConf.push({ ...d, status: 'LOW_CONFIDENCE' }) : conf.push(d)));
    const plat = [], cand = []; conf.forEach(d => (d.nearestPlatformDistM <= platformBufferMeters ? plat.push({ ...d, status: 'PLATFORM_MASKED' }) : cand.push(d)));
    const ais = interpolateAisToSarTime(aisRows, sceneTimeIso);
    cand.forEach(d => { let b = null, bd = Infinity; ais.forEach(a => { const x = haversineMeters(d.lat, d.lon, a.interpLat, a.interpLon); if (x < bd) { bd = x; b = a; } }); d.nearestAis = b; d.nearestAisDistM = b ? Math.round(bd) : null; });
    const sm = sceneMeta(sceneTimeIso), mp = { buffer: matchBufferMeters, azComp: S.azComp, passHeading: sm.heading, inc: sm.inc != null ? sm.inc : env.incidence, sizeAware: S.sizeAware !== false };
    const res = I.matchDetections(cand, ais, { ...mp, assignment: S.assignment });
    const gre = I.matchDetections(cand, ais, { ...mp, assignment: 'greedy' });
    const mDet = new Set(), matched = [];
    res.matches.forEach(m => {
      const d = cand[m.di], a = ais[m.ti]; mDet.add(d.det_id);
      matched.push({ ...d, status: 'AIS_MATCHED', mmsi: a.mmsi, matchedAis: a, matchDistM: Math.round(m.distM), match: { d2: m.d2, S: m.S, predLat: m.predLat, predLon: m.predLon, shiftM: m.shiftM } });
    });
    const diff = []; const gm = new Map(gre.matches.map(m => [cand[m.di].det_id, ais[m.ti].mmsi])), hm = new Map(res.matches.map(m => [cand[m.di].det_id, ais[m.ti].mmsi]));
    new Set([...gm.keys(), ...hm.keys()]).forEach(k => { if (gm.get(k) !== hm.get(k)) diff.push({ det_id: k, greedy: gm.get(k) || null, hung: hm.get(k) || null }); });
    const matchedMmsi = new Set(matched.map(m => m.mmsi));
    const dark = cand.filter(d => !mDet.has(d.det_id)).map(d => ({ ...d, status: 'DARK_VESSEL', lostTo: d.nearestAis && matchedMmsi.has(d.nearestAis.mmsi) && d.nearestAisDistM < 4 * matchBufferMeters }));
    return { sceneTimeIso, totalValidSar: conf.length, lowConfCount: lowConf.length, platformRejections: plat, matchedVessels: matched, darkVessels: dark, aisInterpolated: ais,
      allSceneDetections: [...dark, ...matched, ...plat], assignInfo: { greedy: gre.matches.length, chosen: res.matches.length, algo: S.assignment, diff } };
  };

  /* ---------------- 3. enrichment: risk, multi-temporal, traffic, spoofing ---------------- */
  function enrich(subs, assoc) {
    subs.forEach(sub => {
      sub.darkVessels.forEach(d => {
        const trk = assoc.byDet.get(d.det_id), na = d.nearestAis, sp = nearestSpoof(d);
        d.track = trk || null; d.persistPasses = trk && trk.kind === 'DARK' ? trk.members.length : 1;
        d.trafficAnomaly = S.density.anomaly(d.lat, d.lon);
        d.risk = I.riskScore('dark', { nearestDistM: d.nearestAisDistM, buffer: appState.matchBufferMeters, nearestGapMin: na ? na.quality.gapMin : null, lengthM: d.estLengthM, confidence: d.confidence,
          envFalseAlarm: I.falseAlarmIndex(S.env), persistPasses: d.persistPasses, platDistM: d.nearestPlatformDistM, trafficAnomaly: d.trafficAnomaly, spoofNear: sp ? sp.score : 0, spoofNearName: sp ? sp.name : '', lostTo: d.lostTo, wake: d.wake });
        d.spoofNear = sp;
      });
      sub.darkVessels.sort((a, b) => b.risk.score - a.risk.score || b.confidence - a.confidence);
      sub.matchedVessels.forEach(m => {
        const sp = S.spoof.get(m.mmsi) || { score: 0, flags: [] }, trk = assoc.byDet.get(m.det_id);
        m.track = trk && trk.members.length > 1 ? trk : null; m.trafficAnomaly = S.density.anomaly(m.lat, m.lon);
        m.spoof = sp;
        m.risk = I.riskScore('matched', { spoofScore: sp.score, spoofFlags: sp.flags.map(f => f.code), d2: m.match.d2, typeMismatch: I.typeSizeMismatch(m.matchedAis.ship_type, m.estLengthM), shipType: m.matchedAis.ship_type, lengthM: m.estLengthM,
          aisQuality: m.matchedAis.quality.quality, aisGrade: m.matchedAis.quality.grade, trafficAnomaly: m.trafficAnomaly });
      });
    });
  }
  function nearestSpoof(d) {
    let best = null;
    S.spoof.forEach((v, mmsi) => { if (v.score < 0.5) return; const pings = S.pingsByMmsi.get(mmsi) || []; for (const p of pings) { const x = haversineMeters(d.lat, d.lon, p.lat, p.lon); if (x < 3000 && (!best || v.score > best.score)) best = { mmsi, score: v.score, name: (pings[0] && pings[0].name) || mmsi, distM: x, flags: v.flags }; } });
    return best;
  }

  window.runSarAisFusionPipeline = function (sarRows, aisRows, sel, allTs, params) {
    ensureDataCaches();
    const subs = allTs.map(ts => runSingleScenePipeline(sarRows, aisRows, ts, params));
    const assoc = I.associate(subs.map((s, i) => ({ tMs: Date.parse(allTs[i]), dets: s.allSceneDetections.filter(d => d.status !== 'PLATFORM_MASKED') })), { stationaryRadiusM: 2500, vmaxKn: 18 });
    enrich(subs, assoc); S.subs = subs; S.assoc = assoc;
    if (sel !== 'ALL_SCENES') return subs[allTs.indexOf(sel)];
    const cat = k => subs.flatMap(s => s[k]);
    const dark = cat('darkVessels').sort((a, b) => b.risk.score - a.risk.score);
    const info = { greedy: subs.reduce((a, s) => a + s.assignInfo.greedy, 0), chosen: subs.reduce((a, s) => a + s.assignInfo.chosen, 0), algo: S.assignment, diff: subs.flatMap(s => s.assignInfo.diff) };
    return { sceneTimeIso: 'ALL_SCENES', totalValidSar: subs.reduce((a, s) => a + s.totalValidSar, 0), lowConfCount: subs.reduce((a, s) => a + s.lowConfCount, 0), platformRejections: cat('platformRejections'),
      matchedVessels: cat('matchedVessels'), darkVessels: dark, aisInterpolated: cat('aisInterpolated'), allSceneDetections: [...dark, ...cat('matchedVessels'), ...cat('platformRejections')], assignInfo: info };
  };

  /* ---------------- 4. map layers (ellipses, density, multi-temporal, raster/CFAR) ---------------- */
  const _initMap = window.initMap;
  window.initMap = function () {
    _initMap();
    ['density', 'ellipse', 'mtrack', 'cfar'].forEach(k => { layerGroups[k] = L.layerGroup().addTo(map); });
    layerGroups.density.setZIndex && 0;
  };
  const _renderMapLayers = window.renderMapLayers;
  window.renderMapLayers = function (result) {
    _renderMapLayers(result);
    const on = id => $(id) && $(id).checked;
    if (on('chkLayerDensity') && S.density) {
      const D = S.density, c = document.createElement('canvas'); c.width = D.nx; c.height = D.ny; const ctx = c.getContext('2d'), im = ctx.createImageData(D.nx, D.ny);
      for (let y = 0; y < D.ny; y++) for (let x = 0; x < D.nx; x++) { const v = Math.sqrt(D.g[y * D.nx + x] / (D.max || 1)), o = ((D.ny - 1 - y) * D.nx + x) * 4; im.data[o] = 79 + 170 * v; im.data[o + 1] = 140 + 60 * v; im.data[o + 2] = 255 - 160 * v; im.data[o + 3] = Math.min(255, 255 * v * 0.9); }
      ctx.putImageData(im, 0, 0);
      L.imageOverlay(c.toDataURL(), [[D.b.south, D.b.west], [D.b.south + D.ny * D.cellDeg, D.b.west + D.nx * D.cellDeg]], { opacity: 0.55, interactive: false }).addTo(layerGroups.density);
    }
    if (on('chkLayerEllipse')) {
      result.matchedVessels.forEach(m => { const e = I.ellipsePoly(m.match.predLat, m.match.predLon, m.match.S); L.polygon(e.poly, { color: '#4f8cff', weight: 1, fillColor: '#4f8cff', fillOpacity: 0.12, interactive: false }).addTo(layerGroups.ellipse); });
      result.darkVessels.forEach(d => { const a = d.nearestAis; if (!a || d.nearestAisDistM > 8000) return; const q = a.quality, e = I.ellipsePoly(a.interpLat, a.interpLon, I.cov2(q.sigmaAlongM, q.sigmaCrossM, a.cog));
        L.polygon(e.poly, { color: '#f5b301', weight: 1, dashArray: '3,4', fillOpacity: 0.05, interactive: false }).bindTooltip(`AIS ${esc(a.name)} 95% ellipse ${Math.round(e.semiMajorM)}×${Math.round(e.semiMinorM)} m — hull is outside it`, { className: 'maya-tooltip', sticky: true }).addTo(layerGroups.ellipse); });
    }
    if (on('chkLayerMtrack') && S.assoc) {
      const ids = new Set(result.allSceneDetections.map(d => d.det_id));
      S.assoc.tracks.filter(t => t.members.length > 1 && t.members.some(m => ids.has(m.det_id))).forEach(t => {
        const col = t.kind === 'DARK' ? '#ff4d4f' : '#4f8cff'; L.polyline(t.members.map(m => [m.lat, m.lon]), { color: col, weight: 2, opacity: 0.8, dashArray: t.kind === 'DARK' ? '6,4' : null }).bindTooltip(`${t.id} · ${t.members.length} passes · drift ≤ ${Math.round(t.maxDriftM)} m${t.kind === 'DARK' ? ' · PERSISTENT DARK HULL' : ''}`, { className: 'maya-tooltip', sticky: true }).addTo(layerGroups.mtrack);
        t.members.forEach((m, i) => L.circleMarker([m.lat, m.lon], { radius: 4, color: col, fillColor: '#0a0d1a', fillOpacity: 1, weight: 2 }).bindTooltip(`pass ${i + 1}: ${m.det_id}`, { className: 'maya-tooltip' }).addTo(layerGroups.mtrack)); });
    }
    if (on('chkLayerCfar') && S.lab && S.lab.overlay) {
      const o = S.lab.overlay; L.imageOverlay(o.url, o.bounds, { opacity: 0.8, interactive: false }).addTo(layerGroups.cfar);
      S.lab.comps.forEach(c => L.circleMarker([c.lat, c.lon], { radius: 7, color: '#38bdf8', weight: 1.5, fillOpacity: 0.1 }).bindTooltip(`CFAR hit · ~${Math.round(c.lengthM)} m · ${f1(c.vv_db)} dB`, { className: 'maya-tooltip' }).addTo(layerGroups.cfar));
    }
  };

  /* ---------------- 5. alert feed chips, inspector explainability ---------------- */
  const _renderSidebars = window.renderSidebars;
  window.renderSidebars = function (result) {
    _renderSidebars(result);
    const cont = $('darkAlertList'); const cards = [...cont.children];
    result.darkVessels.forEach((d, i) => {
      const c = cards[i]; if (!c || !d.risk) return; const row = c.firstElementChild; if (!row) return;
      const chip = document.createElement('span'); chip.className = 'font-mono-tech text-[10px] px-1.5 py-0.5 rounded font-bold ml-1'; chip.style.cssText = `background:${RISK_COL[d.risk.level]}22;color:${RISK_COL[d.risk.level]};border:1px solid ${RISK_COL[d.risk.level]}66`;
      chip.textContent = `RISK ${d.risk.score}`; row.lastElementChild.before(chip); row.lastElementChild.previousElementSibling.style.marginLeft = 'auto';
      if (d.persistPasses > 1) { const p = document.createElement('div'); p.className = 'mt-1.5 font-mono-tech text-[10px] text-red-300'; p.textContent = `↻ seen in ${d.persistPasses} passes (${d.track.id})`; c.appendChild(p); }
    });
    const ai = result.assignInfo, el = $('fusionLive');
    if (el && ai) el.innerHTML = `Matches: <b class="text-white">${ai.chosen}</b> (${ai.algo}) · greedy baseline would give <b class="text-white">${ai.greedy}</b>${ai.algo === 'hungarian' ? ` · <span class="${ai.chosen > ai.greedy || ai.diff.length ? 'text-emerald-300' : 'text-slate-400'}">${ai.diff.length} assignment${ai.diff.length === 1 ? '' : 's'} changed</span>` : ''}`;
  };
  function factorBars(r) {
    const mx = Math.max(1, ...r.factors.map(f => Math.abs(f.c)));
    return r.factors.filter(f => f.x > 0.001 || Math.abs(f.w) > 0).map(f => {
      const pos = f.c >= 0, w = Math.min(100, Math.abs(f.c) / mx * 100);
      return `<div class="py-0.5"><div class="flex justify-between text-[10px]"><span class="text-slate-300">${esc(f.label)}</span><span class="font-mono-tech ${pos ? 'text-red-300' : 'text-emerald-300'}">${f.c >= 0 ? '+' : ''}${f.c.toFixed(2)}</span></div>
      <div class="h-1.5 rounded bg-slate-800 overflow-hidden"><div class="h-full rounded" style="width:${w}%;background:${pos ? '#ff6b6d' : '#34d399'}"></div></div><div class="text-[9px] text-slate-500 truncate">${esc(f.detail || '')}</div></div>`;
    }).join('');
  }
  function riskBlock(d) {
    if (!d.risk) return '';
    const r = d.risk; let html = `<div class="flex items-center justify-between"><span class="font-mono-tech text-[10px] uppercase text-slate-400">Explainable risk score</span><span class="font-mono-tech text-xs font-bold px-1.5 py-0.5 rounded" style="color:${RISK_COL[r.level]};background:${RISK_COL[r.level]}22;border:1px solid ${RISK_COL[r.level]}66">${r.score}/100 · ${r.level}</span></div>
      <div class="text-[9px] text-slate-500 mb-1">logit = baseline ${r.baseline} + Σ weight×evidence → sigmoid. Bars show each factor's contribution.</div>${factorBars(r)}`;
    if (d.status === 'AIS_MATCHED') {
      const q = d.matchedAis.quality, m = d.match; html += `<div class="mt-2 pt-2 border-t border-slate-800 grid grid-cols-2 gap-x-3 text-[10px] font-mono-tech"><span class="text-slate-400">AIS quality</span><span class="text-sky-300">${q.grade} · σ≈${Math.round(q.sigmaM)} m · gap ${f1(q.gapMin, 0)} min</span><span class="text-slate-400">Mahalanobis d²</span><span class="text-sky-300">${f1(m.d2, 2)} (95% gate ${I.CHI2_95})</span>${m.shiftM ? `<span class="text-slate-400">Azimuth shift applied</span><span class="text-sky-300">${Math.round(m.shiftM)} m</span>` : ''}</div>`;
      if (d.spoof && d.spoof.flags.length) html += `<div class="mt-1 text-[10px] text-amber-300">⚠ ${d.spoof.flags.map(f => esc(f.detail)).join('; ')}</div>`;
    } else if (d.nearestAis) {
      const q = d.nearestAis.quality; html += `<div class="mt-2 pt-2 border-t border-slate-800 text-[10px] font-mono-tech text-slate-400">Nearest AIS ${esc(d.nearestAis.name)}: quality ${q.grade}, 95% ellipse ≈ ${Math.round(Math.sqrt(I.CHI2_95) * q.sigmaAlongM)} m — hull sits ${d.nearestAisDistM} m away.${d.lostTo ? ' That AIS vessel is already assigned to a different hull.' : ''}</div>`;
    }
    if (d.track && d.track.members.length > 1) html += `<div class="mt-1 text-[10px] text-red-300">↻ ${d.track.id}: ${d.track.members.length} passes, max drift ${Math.round(d.track.maxDriftM)} m</div>`;
    if (d.spoofNear) html += `<div class="mt-1 text-[10px] text-amber-300">⚠ ${esc(d.spoofNear.name)} (MMSI ${d.spoofNear.mmsi}) shows spoofing: ${d.spoofNear.flags.map(f => f.code).join(', ')} — reported track passes ${Math.round(d.spoofNear.distM)} m from this hull.</div>`;
    return html;
  }
  const _openInspector = window.openInspectorCard;
  window.openInspectorCard = function (det, pan) {
    _openInspector(det, pan);
    const card = $('inspectorCard'); card.style.maxHeight = 'calc(100% - 2rem)'; card.style.overflowY = 'auto';
    let box = $('inspRisk'); if (!box) { box = document.createElement('div'); box.id = 'inspRisk'; box.className = 'mt-3 pt-3 border-t border-slate-800'; card.appendChild(box); }
    box.innerHTML = riskBlock(det);
  };

  /* ---------------- 6. injected controls ---------------- */
  function injectSidebar() {
    const layersPanel = $('chkLayerDark').closest('.space-y-2');
    const tog = (id, label, cls, chk, tip) => `<label class="flex items-center justify-between text-xs cursor-pointer py-0.5" title="${esc(tip || '')}"><span class="flex items-center gap-2 text-slate-200">${label}</span><input type="checkbox" id="${id}" ${chk ? 'checked' : ''} class="${cls} w-4 h-4 rounded cursor-pointer" /></label>`;
    layersPanel.insertAdjacentHTML('beforeend', `<div class="pt-1.5 mt-1 border-t border-slate-800 font-mono-tech text-[9px] uppercase text-slate-500">Analytical layers</div>` +
      tog('chkLayerEllipse', '<span class="w-3 h-2 rounded-full border border-[#4f8cff] bg-[#4f8cff]/20 inline-block"></span>95% uncertainty ellipses', 'accent-[#4f8cff]', true, 'Match covariance: AIS interpolation + SAR geolocation + azimuth ambiguity') +
      tog('chkLayerMtrack', '<span class="w-3 h-0.5 bg-[#ff4d4f] inline-block"></span>Multi-temporal tracks', 'accent-[#ff4d4f]', true) +
      tog('chkLayerDensity', '<span class="w-3 h-3 rounded-sm bg-gradient-to-br from-[#4f8cff] to-[#ffd35c] inline-block"></span>Traffic density (AIS KDE)', 'accent-[#4f8cff]', false) +
      tog('chkLayerCfar', '<span class="w-3 h-3 rounded-sm border border-sky-400 inline-block"></span>SAR Lab raster + CFAR', 'accent-sky-400', true));
    const panel = document.createElement('div'); panel.className = 'bg-[#131936] border border-[#4f8cff]/40 rounded-xl p-3 space-y-2.5';
    const sel = (id, opts, val) => `<select id="${id}" class="w-full bg-[#0a0d1a] border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 font-mono-tech">${opts.map(([v, t]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    panel.innerHTML = `<div class="flex items-center justify-between border-b border-slate-800 pb-1.5"><span class="font-mono-tech text-[11px] uppercase font-bold text-slate-300">Fusion Engine</span><span class="font-mono-tech text-[9px] text-sky-300">v2 · INTEL</span></div>
      <div><div class="text-[10px] text-slate-400 mb-0.5">SAR↔AIS assignment</div>${sel('selAssign', [['hungarian', 'Hungarian (global min-cost)'], ['greedy', 'Greedy nearest-first (baseline)']], S.assignment)}</div>
      <div><div class="text-[10px] text-slate-400 mb-0.5">AIS interpolation</div>${sel('selInterp', [['linear', 'Linear bracket'], ['hermite', 'Cubic Hermite (uses SOG/COG)']], S.interp)}</div>
      <div><div class="text-[10px] text-slate-400 mb-0.5">SAR pass geometry</div>${sel('selPass', [['auto', 'Auto from UTC (02h=desc, 14h=asc)'], ['ascending', 'Ascending (heading 349°)'], ['descending', 'Descending (heading 191°)']], S.passOverride)}</div>
      <label class="flex items-center justify-between text-xs cursor-pointer" title="Moving ships appear displaced along-track in SAR (Doppler). Turn ON only for real Sentinel-1 data; the bundled synthetic data has no shift."><span class="text-slate-200">Azimuth-shift compensation</span><input type="checkbox" id="chkAz" class="accent-[#4f8cff] w-4 h-4" /></label>
      <label class="flex items-center justify-between text-xs cursor-pointer" title="Scale detection confidence by signal-to-clutter ratio for the current wind/waves"><span class="text-slate-200">Environment-aware confidence</span><input type="checkbox" id="chkEnvConf" checked class="accent-[#4f8cff] w-4 h-4" /></label>
      <div id="fusionLive" class="text-[10px] leading-snug text-slate-400 font-mono-tech border-t border-slate-800 pt-1.5"></div>`;
    layersPanel.before(panel);
    const re = () => { updateDashboard(); refreshActiveView(); };
    $('selAssign').onchange = e => { S.assignment = e.target.value; re(); }; $('selInterp').onchange = e => { S.interp = e.target.value; re(); }; $('selPass').onchange = e => { S.passOverride = e.target.value; re(); };
    $('chkAz').onchange = e => { S.azComp = e.target.checked; re(); }; $('chkEnvConf').onchange = e => { S.envConf = e.target.checked; re(); };
    ['chkLayerEllipse', 'chkLayerMtrack', 'chkLayerDensity', 'chkLayerCfar'].forEach(id => $(id).addEventListener('change', () => appState.lastPipelineResult && renderMapLayers(appState.lastPipelineResult)));
  }

  /* ---------------- 7. tiny SVG charts ---------------- */
  function chart({ w = 460, h = 220, series, xmin, xmax, ymin, ymax, xl = '', yl = '', fmtY = v => v, xticks = 5, yticks = 4, marks = [] }) {
    const m = { l: 40, r: 10, t: 10, b: 30 }, X = x => m.l + (x - xmin) / (xmax - xmin) * (w - m.l - m.r), Y = y => h - m.b - (y - ymin) / (ymax - ymin) * (h - m.t - m.b);
    let s = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" style="font-family:ui-monospace,monospace">`;
    for (let i = 0; i <= yticks; i++) { const v = ymin + (ymax - ymin) * i / yticks; s += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#1e2748"/><text x="${m.l - 5}" y="${Y(v) + 3}" fill="#7c8aae" font-size="9" text-anchor="end">${fmtY(v)}</text>`; }
    for (let i = 0; i <= xticks; i++) { const v = xmin + (xmax - xmin) * i / xticks; s += `<text x="${X(v)}" y="${h - m.b + 13}" fill="#7c8aae" font-size="9" text-anchor="middle">${+v.toFixed(2)}</text>`; }
    marks.forEach(mk => { s += `<line x1="${X(mk.x)}" x2="${X(mk.x)}" y1="${m.t}" y2="${h - m.b}" stroke="${mk.color || '#f5b301'}" stroke-dasharray="3,3"/><text x="${X(mk.x) + 3}" y="${m.t + 9}" fill="${mk.color || '#f5b301'}" font-size="9">${mk.label}</text>`; });
    series.forEach(se => { const d = se.pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' '); s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2" ${se.dash ? 'stroke-dasharray="4,3"' : ''}/>`; if (se.dots) se.pts.forEach(p => s += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="2.5" fill="${se.color}"/>`); });
    s += `<text x="${(w + m.l) / 2}" y="${h - 3}" fill="#7c8aae" font-size="9" text-anchor="middle">${xl}</text><text x="10" y="${h / 2}" fill="#7c8aae" font-size="9" transform="rotate(-90 10 ${h / 2})" text-anchor="middle">${yl}</text></svg>`;
    return s + `<div class="flex flex-wrap gap-3 mt-1 text-[10px] text-slate-400">${series.map(se => `<span><i class="inline-block w-3 h-0.5 align-middle mr-1" style="background:${se.color}"></i>${se.name}</span>`).join('')}</div>`;
  }
  const card = (title, body, extra = '') => `<div data-sec="${title.toLowerCase().replace(/[^a-z]+/g, '-')}" class="bg-[#131936] border border-slate-700/80 rounded-xl p-4 ${extra}"><div class="font-mono-tech text-[11px] uppercase font-bold text-slate-300 border-b border-slate-800 pb-1.5 mb-3">${title}</div>${body}</div>`;
  const th = 'text-left font-mono-tech text-[10px] uppercase text-slate-400 py-1 pr-3 font-normal', td = 'py-1 pr-3 font-mono-tech text-[11px] text-slate-200';
  const note = t => `<p class="text-[11px] text-slate-400 leading-relaxed mt-2">${t}</p>`;

  /* ---------------- 8. views ---------------- */
  function renderIntel() {
    const el = $('viewIntel'); if (!el) return; const r = appState.lastPipelineResult; if (!r) return;
    const ai = r.assignInfo, sel = appState.sceneDates[appState.activeSceneIndex];
    const names = new Map(); r.aisInterpolated.forEach(a => names.set(a.mmsi, a.name));
    const diffRows = ai.diff.length ? ai.diff.map(d => `<tr><td class="${td}">${d.det_id}</td><td class="${td} text-amber-300">${d.greedy ? esc(names.get(d.greedy) || d.greedy) : '— (left dark)'}</td><td class="${td} text-emerald-300">${d.hung ? esc(names.get(d.hung) || d.hung) : '— (left dark)'}</td></tr>`).join('') : `<tr><td colspan="3" class="${td} text-slate-500">Greedy and Hungarian agree on every detection in this selection. Select the pass at <b>2026-10-24 02:15</b> to see the contested pair (SYN ANCHORAGE ALPHA/BRAVO).</td></tr>`;
    const tracks = (S.assoc ? S.assoc.tracks : []).filter(t => t.members.length > 1);
    const trRows = tracks.map(t => `<tr><td class="${td}"><span style="color:${t.kind === 'DARK' ? '#ff6b6d' : '#7fb0ff'}">${t.id}</span></td><td class="${td}">${t.kind === 'DARK' ? 'Persistent dark hull' : 'AIS identity'}</td><td class="${td}">${t.members.length}</td><td class="${td}">${Math.round(t.maxDriftM)} m</td><td class="${td} text-slate-400">${t.members.map(m => m.det_id).join(' → ')}</td></tr>`).join('') || `<tr><td colspan="5" class="${td} text-slate-500">No multi-pass tracks.</td></tr>`;
    const spo = [...S.spoof.entries()].filter(([, v]) => v.flags.length).sort((a, b) => b[1].score - a[1].score);
    const spRows = spo.map(([m, v]) => `<tr><td class="${td}">${m}</td><td class="${td}">${names.get(m) || (S.pingsByMmsi.get(m) || [{}])[0].name || ''}</td><td class="${td}"><span style="color:${v.score > .6 ? '#ff6b6d' : '#f5b301'}">${Math.round(v.score * 100)}</span></td><td class="${td} text-slate-400">${v.flags.map(f => esc(f.code + ': ' + f.detail)).join('<br/>')}</td></tr>`).join('') || `<tr><td colspan="4" class="${td} text-slate-500">No AIS integrity violations.</td></tr>`;
    const gr = { A: 0, B: 0, C: 0, D: 0 }; r.aisInterpolated.forEach(a => gr[a.quality.grade]++);
    const grTot = r.aisInterpolated.length || 1;
    const gradeBar = ['A', 'B', 'C', 'D'].map(g => `<div class="flex items-center gap-2 text-[11px] font-mono-tech"><span class="w-4 text-slate-300">${g}</span><div class="flex-1 h-2 rounded bg-slate-800"><div class="h-full rounded" style="width:${100 * gr[g] / grTot}%;background:${{ A: '#34d399', B: '#7fb0ff', C: '#f5b301', D: '#ff6b6d' }[g]}"></div></div><span class="w-8 text-right text-slate-300">${gr[g]}</span></div>`).join('');
    const top = r.darkVessels.slice(0, 6).map(d => `<div class="py-1.5 border-b border-slate-800 last:border-0"><div class="flex justify-between items-center cursor-pointer" data-det="${d.det_id}"><span class="font-mono-tech text-xs text-white">${d.det_id}</span><span class="font-mono-tech text-[11px] font-bold" style="color:${RISK_COL[d.risk.level]}">${d.risk.score} · ${d.risk.level}</span></div>${factorBars(d.risk)}</div>`).join('') || '<div class="text-xs text-slate-500">No dark vessels under current thresholds.</div>';
    const flagged = r.matchedVessels.filter(m => m.risk.score >= 40).sort((a, b) => b.risk.score - a.risk.score).slice(0, 5).map(m => `<tr><td class="${td}">${m.det_id}</td><td class="${td}">${esc(m.matchedAis.name)}</td><td class="${td}" style="color:${RISK_COL[m.risk.level]}">${m.risk.score}</td><td class="${td} text-slate-400">${m.risk.factors.filter(f => f.c > 0.3).map(f => esc(f.label)).join(', ')}</td></tr>`).join('') || `<tr><td colspan="4" class="${td} text-slate-500">No AIS-matched vessel looks suspicious (all risk &lt; 40).</td></tr>`;
    el.innerHTML = `<div class="max-w-7xl mx-auto space-y-5"><div class="border-b border-blue-500/30 pb-4"><h1 class="text-2xl font-extrabold text-white mt-1">Assignment, tracks, integrity &amp; risk</h1><p class="text-xs text-slate-400 mt-1">View: ${sel === 'ALL_SCENES' ? 'all passes' : sel} · algorithm <b class="text-white">${S.assignment}</b> · interpolation <b class="text-white">${S.interp}</b> · azimuth compensation <b class="text-white">${S.azComp ? 'on' : 'off'}</b></p></div>
    <div class="grid lg:grid-cols-2 gap-5">
    ${card('Global assignment · Hungarian vs greedy', `<div class="flex gap-6 mb-2"><div><div class="text-[10px] text-slate-400 font-mono-tech uppercase">Greedy matches</div><div class="text-2xl font-extrabold text-amber-300 font-mono-tech">${ai.greedy}</div></div><div><div class="text-[10px] text-slate-400 font-mono-tech uppercase">Selected (${ai.algo})</div><div class="text-2xl font-extrabold text-emerald-300 font-mono-tech">${ai.chosen}</div></div></div>
      <table class="w-full"><tr><th class="${th}">Detection</th><th class="${th}">Greedy chose</th><th class="${th}">Hungarian chose</th></tr>${diffRows}</table>${note('Cost = squared Mahalanobis distance using AIS interpolation covariance ⊕ SAR geolocation ⊕ azimuth ambiguity. Hungarian minimises the <i>total</i> cost over the whole scene, so one ship cannot "steal" a transponder that fits its neighbour better.')}`)}
    ${card('Multi-temporal association', `<table class="w-full"><tr><th class="${th}">Track</th><th class="${th}">Type</th><th class="${th}">Passes</th><th class="${th}">Drift</th><th class="${th}">Members</th></tr>${trRows}</table>${note('Dark hulls are linked pass-to-pass by Hungarian assignment (position gate + length + backscatter). Linking is only dependable for slow/stationary vessels — a moving dark ship will usually be re-detected too far away to link.')}`)}
    ${card('AIS spoofing &amp; integrity checks', `<table class="w-full"><tr><th class="${th}">MMSI</th><th class="${th}">Name</th><th class="${th}">Score</th><th class="${th}">Findings</th></tr>${spRows}</table>${note('Checks: teleport (implied speed &gt; 45 kn), duplicate timestamps, reported SOG vs implied speed, COG vs track bearing, frozen position while reporting speed.')}`)}
    ${card('AIS interpolation quality', `<div class="space-y-1.5">${gradeBar}</div>${note('Brownian-bridge error between bracketing pings (variance q·Δt₁Δt₂/(Δt₁+Δt₂)), dead-reckoning growth when extrapolating. Grade A ≈ σ below 55 m, D ≈ above 230 m (1σ). Long reporting gaps are the main source of D grades — and of false "dark" alerts.')}`)}
    ${card('Highest-risk dark vessels (explainable)', top)}
    ${card('AIS-matched vessels worth a second look', `<table class="w-full"><tr><th class="${th}">Det</th><th class="${th}">Vessel</th><th class="${th}">Risk</th><th class="${th}">Drivers</th></tr>${flagged}</table>`)}
    </div></div>`;
    el.querySelectorAll('[data-det]').forEach(n => n.onclick = () => { const d = r.darkVessels.find(x => x.det_id === n.dataset.det); if (d) { showTab('map'); setTimeout(() => openInspectorCard(d, true), 80); } });
  }

  /* ---- Environment ---- */
  function renderEnv() {
    const el = $('viewEnv'); if (!el) return; const e = S.env, ss = I.seaStateOf(e);
    const inp = (id, label, min, max, step, val, unit) => `<div><div class="flex justify-between text-xs mb-0.5"><span class="text-slate-300">${label}</span><span class="font-mono-tech text-sky-300" id="${id}V">${val} ${unit}</span></div><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" class="w-full"/></div>`;
    el.innerHTML = `<div class="max-w-7xl mx-auto space-y-5"><div class="border-b border-blue-500/30 pb-4"><h1 class="text-2xl font-extrabold text-white mt-1">Sea state &amp; detectability</h1><p class="text-xs text-slate-400 mt-1">Source: <b id="envSrc" class="text-white">${esc(S.envSource)}</b>. Wind roughens the sea (clutter ↑), hiding small ships and creating false alarms.</p></div>
    <div class="grid lg:grid-cols-3 gap-5"><div class="space-y-3">${card('Inputs', `<div class="space-y-3">${inp('envWind', 'Wind speed (10 m)', 0, 30, 0.5, e.windSpeed, 'm/s')}${inp('envDir', 'Wind direction (from)', 0, 359, 1, e.windDir, '°')}${inp('envHs', 'Significant wave height', 0, 8, 0.1, e.hs, 'm')}${inp('envInc', 'Radar incidence angle', 20, 46, 0.5, e.incidence, '°')}
      <div><div class="text-xs text-slate-300 mb-0.5">Sea state (Douglas)</div><select id="envSS" class="w-full bg-[#0a0d1a] border border-slate-700 rounded px-2 py-1 text-xs font-mono-tech text-slate-200"><option value="">Auto from Hs (${I.douglas(e.hs)})</option>${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<option value="${i}" ${String(e.seaState) === String(i) ? 'selected' : ''}>${i}</option>`).join('')}</select></div>
      <div class="flex gap-2 pt-1"><button id="envFetch" class="flex-1 px-2 py-1.5 rounded bg-[#4f8cff] text-white text-xs font-bold font-mono-tech">Fetch Open-Meteo for selected pass</button><button id="envReset" class="px-2 py-1.5 rounded bg-slate-800 text-slate-300 text-xs font-mono-tech">Reset</button></div><div id="envMsg" class="text-[10px] text-slate-400 font-mono-tech"></div></div>`)}</div>
    <div class="space-y-3">${card('Derived', `<div class="grid grid-cols-2 gap-3" id="envDerived"></div>`)}${card('Effect on current scene', `<div id="envEffect" class="text-xs text-slate-300 space-y-1"></div>`)}</div>
    <div class="space-y-3">${card('Detection probability vs ship length', `<div id="envPd"></div>${note('Peak-pixel contrast of a 10 m GRD pixel vs CFAR threshold (logistic). Simplified empirical model: <b>not</b> CMOD5 / GMF-calibrated — treat as relative guidance.')}`)}</div></div>
    <div class="grid lg:grid-cols-2 gap-5">${card('Performance vs wind (synthetic Monte-Carlo)', `<button id="envSweepBtn" class="px-3 py-1.5 rounded bg-slate-800 text-sky-300 text-xs font-mono-tech mb-2">Run wind sweep (3 → 18 m/s)</button><div id="envSweep" class="text-xs text-slate-500">Press to simulate how recall of dark ships and alert precision change as the sea roughens.</div>`)}
    ${card('How the environment is used', `<ul class="text-xs text-slate-300 space-y-1.5 list-disc pl-4"><li><b>Confidence</b>: each detection's confidence is scaled by signal-to-clutter ratio (optional toggle).</li><li><b>Risk</b>: a high false-alarm index lowers dark-vessel risk (rough sea ⇒ more clutter lookalikes).</li><li><b>Azimuth shift</b>: incidence angle sets slant range and therefore the Doppler displacement of moving ships.</li><li><b>SAR Lab</b>: the same wind / Hs / incidence drive the simulated sea clutter the CFAR must work in.</li></ul>`)}</div></div>`;
    const upd = () => { const e = S.env, ss = I.seaStateOf(e), la = 79, mn = I.minDetectableLength(e, la), fa = I.falseAlarmIndex(e);
      $('envDerived').innerHTML = [['Beaufort', I.beaufort(e.windSpeed)], ['Douglas sea state', ss], ['Sea clutter σ⁰ (VV)', f1(I.clutterDb(e, la)) + ' dB'], ['Noise floor (NESZ)', I.NESZ_DB + ' dB'], ['Min detectable length (50%)', Math.round(mn) + ' m'], ['False-alarm index', Math.round(fa * 100) + '%']].map(([a, b]) => `<div><div class="text-[10px] text-slate-400 font-mono-tech uppercase">${a}</div><div class="text-lg font-extrabold font-mono-tech text-white">${b}</div></div>`).join('');
      const r = appState.lastPipelineResult, dn = r ? [...r.allSceneDetections].filter(d => d.envFactor != null && d.envFactor < 0.9).length : 0;
      $('envEffect').innerHTML = r ? `<div>Detections with confidence reduced &gt; 10 %: <b class="text-white">${dn}</b> of ${r.allSceneDetections.length + r.lowConfCount}.</div><div>Dark vessels in view: <b class="text-white">${r.darkVessels.length}</b>.</div><div class="text-slate-500">Toggle “Environment-aware confidence” in the Fusion Engine panel to compare.</div>` : '';
      const pts = (env, c) => ({ name: c.n, color: c.c, dash: c.d, pts: Array.from({ length: 60 }, (_, i) => { const L = 8 + i * 4.5; return [L, I.detectProb(L, env, la)]; }) });
      $('envPd').innerHTML = chart({ series: [pts(e, { n: 'current', c: '#4f8cff' }), pts({ ...e, windSpeed: 3, hs: 0.3 }, { n: 'calm 3 m/s', c: '#34d399', d: 1 }), pts({ ...e, windSpeed: 15, hs: 3 }, { n: 'rough 15 m/s', c: '#ff6b6d', d: 1 })], xmin: 8, xmax: 275, ymin: 0, ymax: 1, xl: 'ship length (m)', yl: 'P(detect)', fmtY: v => v.toFixed(1), marks: [{ x: mn, label: Math.round(mn) + ' m', color: '#4f8cff' }] });
    };
    const chg = () => { S.envSource = 'manual'; $('envSrc').textContent = 'manual'; upd(); clearTimeout(chg.t); chg.t = setTimeout(() => { updateDashboard(); }, 120); };
    const bind = (id, key, fmt) => { $(id).oninput = ev => { S.env[key] = +ev.target.value; $(id + 'V').textContent = ev.target.value + ' ' + fmt; chg(); }; };
    bind('envWind', 'windSpeed', 'm/s'); bind('envDir', 'windDir', '°'); bind('envHs', 'hs', 'm'); bind('envInc', 'incidence', '°');
    $('envSS').onchange = ev => { S.env.seaState = ev.target.value === '' ? null : +ev.target.value; chg(); };
    $('envReset').onclick = () => { S.env = { ...I.DEFAULT_ENV }; S.envSource = 'manual defaults'; renderEnv(); updateDashboard(); };
    $('envFetch').onclick = fetchEnv;
    $('envSweepBtn').onclick = () => {
      $('envSweep').textContent = 'running…'; setTimeout(() => {
        const cfg = benchCfg(); S.sweep = I.windSweep({ ...cfg, nScenes: 6, nShips: 36 }, [3, 6, 9, 12, 15, 18]);
        const P = k => S.sweep.map(s => [s.wind, s[k]]);
        $('envSweep').innerHTML = chart({ series: [{ name: 'ship detection prob.', color: '#4f8cff', pts: P('pd') }, { name: 'dark recall', color: '#34d399', pts: P('darkRecall'), dots: 1 }, { name: 'alert precision', color: '#ff6b6d', pts: P('alertPrecision'), dots: 1 }], xmin: 3, xmax: 18, ymin: 0, ymax: 1, xl: 'wind speed (m/s)', yl: 'rate', fmtY: v => v.toFixed(1) }) + note('Min detectable length grows from ' + Math.round(S.sweep[0].minLen) + ' m to ' + Math.round(S.sweep[S.sweep.length - 1].minLen) + ' m; clutter alerts rise ' + S.sweep[0].clutter + ' → ' + S.sweep[S.sweep.length - 1].clutter + '. Synthetic scenes — shows the trend, not absolute numbers.');
      }, 30);
    };
    upd();
  }
  async function fetchEnv() {
    const m = $('envMsg'), iso = appState.rawSceneTimestamps[Math.min(appState.activeSceneIndex, appState.rawSceneTimestamps.length - 1)], d = iso.slice(0, 10), lat = (AOI_BOUNDS.minLat + AOI_BOUNDS.maxLat) / 2, lon = (AOI_BOUNDS.minLon + AOI_BOUNDS.maxLon) / 2, hr = +iso.slice(11, 13);
    m.textContent = 'fetching…';
    try {
      const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&start_date=${d}&end_date=${d}&timezone=UTC`)).json();
      let hs = null; try { const mar = await (await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height&start_date=${d}&end_date=${d}&timezone=UTC`)).json(); hs = mar.hourly.wave_height[hr]; } catch (_) { }
      S.env.windSpeed = w.hourly.wind_speed_10m[hr]; S.env.windDir = w.hourly.wind_direction_10m[hr]; if (hs != null) S.env.hs = hs; else S.env.hs = Math.min(0.0246 * S.env.windSpeed ** 2 * 0.5, 6);
      S.envSource = `Open-Meteo ${d} ${String(hr).padStart(2, '0')}:00 UTC${hs == null ? ' (Hs estimated from wind)' : ''}`; renderEnv(); updateDashboard(); $('envMsg').textContent = 'loaded';
    } catch (err) { m.textContent = 'Could not reach Open-Meteo (offline or date out of range): ' + err.message; }
  }

  /* ---- SAR Lab ---- */
  const LAB_BOUNDS = { west: 54.96, east: 55.08, south: 24.96, north: 25.08 };
  const LAB_SHIPS = [
    { id: 'LAB-A', lon: 54.985, lat: 25.060, L: 180, headingDeg: 70, sogKn: 12, wake: true, name: 'cargo, underway' },
    { id: 'LAB-B', lon: 55.020, lat: 25.040, L: 240, headingDeg: 20, sogKn: 0, name: 'tanker, anchored' },
    { id: 'LAB-C', lon: 55.050, lat: 25.068, L: 70, headingDeg: 250, sogKn: 9, wake: true, name: 'supply vessel' },
    { id: 'LAB-D', lon: 54.975, lat: 25.015, L: 38, headingDeg: 130, sogKn: 5, name: 'fishing boat' },
    { id: 'LAB-E', lon: 55.066, lat: 25.048, L: 95, headingDeg: 300, sogKn: 0, name: 'dark loiterer' }];
  const LAB_PLAT = [{ lon: 55.035, lat: 25.076 }];
  function renderLab() {
    const el = $('viewSar'); if (!el) return;
    if (!el.dataset.ready) {
      el.dataset.ready = 1;
      const o = (arr, v) => arr.map(([a, b]) => `<option value="${a}" ${a === v ? 'selected' : ''}>${b}</option>`).join('');
      const sl = 'w-full bg-[#0a0d1a] border border-slate-700 rounded px-2 py-1 text-xs font-mono-tech text-slate-200';
      el.innerHTML = `<div class="max-w-7xl mx-auto space-y-5"><div class="border-b border-blue-500/30 pb-4"><h1 class="text-2xl font-extrabold text-white mt-1">SAR Lab — calibration → speckle → CFAR → wake</h1><p class="text-xs text-slate-400 mt-1">Runs the <b>real algorithms</b> on a raster. Default raster is a <b class="text-amber-300">physics-inspired simulation</b> (gamma speckle, wind-dependent sea clutter, land, ships, wakes, rig) so the answer is known; load a GeoTIFF to run the identical code on real Sentinel-1 data.</p></div>
      <div class="grid lg:grid-cols-4 gap-5"><div class="space-y-3 lg:col-span-1">${card('Raster source', `<div class="space-y-2"><button id="labSim" class="w-full px-2 py-1.5 rounded bg-[#4f8cff] text-white text-xs font-bold font-mono-tech">Simulate scene (uses Environment tab)</button><label class="text-[10px] text-slate-400 block">Seed <input id="labSeed" type="number" value="3" class="${sl} mt-0.5"/></label>
        <label class="flex items-center justify-between text-xs"><span class="text-slate-300">Apply azimuth displacement</span><input id="labAz" type="checkbox" class="accent-[#4f8cff]"/></label>
        <div class="border-t border-slate-800 pt-2"><div class="text-[10px] text-slate-400 mb-0.5">Load GeoTIFF (EPSG:4326, single band)</div><input id="labFile" type="file" accept=".tif,.tiff" class="text-[10px] text-slate-400 w-full"/><select id="labType" class="${sl} mt-1">${o([['dn', 'Values are DN (amplitude)'], ['sigma0_lin', 'Values are σ⁰ linear'], ['sigma0_db', 'Values are σ⁰ in dB']], 'sigma0_db')}</select><div id="labFileMsg" class="text-[10px] text-slate-500 mt-1">Untested against a real S1 file in this build — see Method tab.</div></div></div>`)}
        ${card('Preprocessing', `<div class="space-y-2"><label class="text-[10px] text-slate-400 block">Speckle filter<select id="labSpk" class="${sl} mt-0.5">${o([['none', 'None'], ['boxcar', 'Boxcar mean'], ['median', 'Median'], ['lee', 'Lee (adaptive)']], 'lee')}</select></label><label class="text-[10px] text-slate-400 block">Window<select id="labWin" class="${sl} mt-0.5">${o([['3', '3×3'], ['5', '5×5'], ['7', '7×7']], '5')}</select></label>
        <label class="flex items-center justify-between text-xs"><span class="text-slate-300">Thermal-noise subtraction</span><input id="labNz" type="checkbox" checked class="accent-[#4f8cff]"/></label><label class="flex items-center justify-between text-xs"><span class="text-slate-300">Incidence-angle normalisation</span><input id="labInc" type="checkbox" class="accent-[#4f8cff]"/></label></div>`)}
        ${card('CFAR &amp; wake', `<div class="space-y-2"><label class="text-[10px] text-slate-400 block">Probability of false alarm<select id="labPfa" class="${sl} mt-0.5">${o([['1e-4', '1e-4'], ['1e-5', '1e-5'], ['1e-6', '1e-6'], ['1e-7', '1e-7']], '1e-6')}</select></label><label class="text-[10px] text-slate-400 block">Detector<select id="labMode" class="${sl} mt-0.5">${o([['CA', 'Two-parameter CA-CFAR'], ['OS', 'CA + robust (median/MAD) re-test']], 'OS')}</select></label><label class="text-[10px] text-slate-400 block">Guard ring (px)<input id="labGuard" type="number" value="6" min="2" max="30" class="${sl} mt-0.5"/></label><label class="text-[10px] text-slate-400 block">Background ring (px)<input id="labBg" type="number" value="16" min="8" max="60" class="${sl} mt-0.5"/></label>
        <label class="flex items-center justify-between text-xs"><span class="text-slate-300">Mask land</span><input id="labMask" type="checkbox" checked class="accent-[#4f8cff]"/></label><label class="flex items-center justify-between text-xs"><span class="text-slate-300">Wake detection</span><input id="labWake" type="checkbox" checked class="accent-[#4f8cff]"/></label>
        <button id="labRun" class="w-full px-2 py-1.5 rounded bg-emerald-600 text-white text-xs font-bold font-mono-tech">Run CFAR</button><button id="labCmp" class="w-full px-2 py-1.5 rounded bg-slate-800 text-sky-300 text-xs font-mono-tech">Compare speckle filters</button><button id="labMap" class="w-full px-2 py-1.5 rounded bg-slate-800 text-sky-300 text-xs font-mono-tech">Show on Live Ops map</button></div>`)}</div>
      <div class="lg:col-span-3 space-y-5"><div class="grid md:grid-cols-3 gap-3">${['Raw DN / σ⁰', 'Calibrated + despeckled (dB)', 'CFAR detections'].map((t, i) => `<div class="bg-[#131936] border border-slate-700/80 rounded-xl p-2"><div class="font-mono-tech text-[10px] uppercase text-slate-400 mb-1">${t}</div><canvas id="labC${i}" class="w-full rounded bg-black" style="image-rendering:pixelated"></canvas></div>`).join('')}</div>
      <div id="labStats"></div></div></div></div>`;
      $('labSim').onclick = labSimulate; $('labRun').onclick = labRun; $('labCmp').onclick = labCompare; $('labMap').onclick = labToMap; $('labFile').onchange = labLoadTiff;
      ['labSpk', 'labWin', 'labPfa', 'labMode', 'labGuard', 'labBg', 'labMask', 'labWake', 'labNz', 'labInc'].forEach(id => $(id).onchange = () => S.lab && labRun());
    }
    if (!S.lab) labSimulate();
  }
  const landPolys = () => OFFLINE_COASTLINE_POLYGONS.map(p => p.coords);
  function labSimulate() {
    $('labStats').innerHTML = '<div class="text-xs text-slate-400 font-mono-tech p-3">simulating…</div>';
    setTimeout(() => {
      const hd = I.passHeadingFor(Date.parse(appState.rawSceneTimestamps[0] || '2026-10-24T02:15:00Z'), S.passOverride);
      const R = I.simulateRaster({ bounds: LAB_BOUNDS, pixM: 25, env: S.env, seed: +$('labSeed').value || 3, passHeading: hd, ships: LAB_SHIPS, platforms: LAB_PLAT, landPolys: landPolys(), applyAzShift: $('labAz').checked });
      S.lab = { R, source: 'simulated' }; labRun();
    }, 20);
  }
  function drawGray(cv, img, w, h, lo, hi, mask) {
    cv.width = w; cv.height = h; const ctx = cv.getContext('2d'), im = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { const v = Math.max(0, Math.min(1, (img[i] - lo) / (hi - lo))), g = Math.round(255 * Math.pow(v, 0.85)), o = i * 4; im.data[o] = g; im.data[o + 1] = g; im.data[o + 2] = Math.min(255, g + 12); im.data[o + 3] = 255; if (mask && mask[i]) { im.data[o] = 38; im.data[o + 1] = 44; im.data[o + 2] = 58; } }
    ctx.putImageData(im, 0, 0); return ctx;
  }
  function labParams() { return { speckle: $('labSpk').value, win: +$('labWin').value, noiseSub: $('labNz').checked, incNorm: $('labInc').checked, inputType: S.lab.inputType || 'dn' }; }
  function labRun() {
    const L = S.lab; if (!L) return; const R = L.R, t0 = performance.now();
    const P = I.preprocess(R, labParams()), C = I.cfar(P, R, { pfa: +$('labPfa').value, mode: $('labMode').value, guard: +$('labGuard').value, bg: +$('labBg').value, useMask: $('labMask').checked });
    let comps = I.components(C.det, P, R, { mergePx: 2, minPx: 3 });
    const wakeOn = $('labWake').checked; const sm = I.preprocess(R, { ...labParams(), speckle: 'boxcar', win: 5 });
    comps.forEach(c => { c.wake = null; if (wakeOn && c.lengthM >= 40) c.wake = I.wakeDetect(sm.db, R.w, R.h, $('labMask').checked ? R.mask : null, c.x, c.y, R.pixM, c.lengthM); });
    comps = I.dropWakeFragments(comps);
    if (L.source === 'simulated') comps.forEach(c => { c.rig = LAB_PLAT.some(p => I.haversine(p.lat, p.lon, c.lat, c.lon) < 400); });
    comps.sort((a, b) => b.nPx - a.nPx);
    const mt = R.mask, db = P.db, lo = -26, hi = -4;
    const raw = new Float32Array(R.w * R.h); for (let i = 0; i < raw.length; i++) raw[i] = L.source === 'simulated' || L.inputType === 'dn' ? 10 * Math.log10((R.dn[i] ** 2) / (R.calA ** 2) + 1e-6) : (L.inputType === 'sigma0_db' ? R.dn[i] : 10 * Math.log10(Math.max(R.dn[i], 1e-6)));
    drawGray($('labC0'), raw, R.w, R.h, lo, hi, null); const c1 = drawGray($('labC1'), db, R.w, R.h, lo, hi, $('labMask').checked ? mt : null);
    const c2 = drawGray($('labC2'), db, R.w, R.h, lo, hi, $('labMask').checked ? mt : null);
    c2.lineWidth = 1.5;
    (R.truth || []).filter(t => t.inChip).forEach(t => { c2.strokeStyle = '#34d399'; c2.beginPath(); c2.arc(t.x, t.y, 9, 0, 7); c2.stroke(); });
    comps.forEach(c => { const r = Math.max(8, c.lengthM / R.pixM / 2 + 4); c2.strokeStyle = '#ff6b6d'; c2.strokeRect(c.x - r, c.y - r, 2 * r, 2 * r); if (c.wake && c.wake.detected) { c2.strokeStyle = '#f5b301'; c2.beginPath(); c2.moveTo(c.x, c.y); const a = c.wake.wakeDirDeg * Math.PI / 180; c2.lineTo(c.x + Math.sin(a) * 60, c.y - Math.cos(a) * 60); c2.stroke(); } });
    // overlay for map: dB image with alpha (transparent over very dark sea)
    const oc = document.createElement('canvas'); oc.width = R.w; oc.height = R.h; const octx = oc.getContext('2d'), oi = octx.createImageData(R.w, R.h);
    for (let i = 0; i < R.w * R.h; i++) { const v = Math.max(0, Math.min(1, (db[i] - lo) / (hi - lo))), g = Math.round(255 * v), o = i * 4; oi.data[o] = g; oi.data[o + 1] = g; oi.data[o + 2] = Math.min(255, g + 20); oi.data[o + 3] = 230; }
    octx.putImageData(oi, 0, 0);
    L.P = P; L.C = C; L.comps = comps; L.overlay = { url: oc.toDataURL(), bounds: [[R.geo.north - R.h * R.geo.dLat, R.geo.west], [R.geo.north, R.geo.west + R.w * R.geo.dLon]] };
    // scoring vs truth
    const truth = (R.truth || []).filter(t => t.inChip), used = new Set(); let tp = 0; const rows = [];
    truth.forEach(t => { let best = null, bd = 1e9; comps.forEach((c, i) => { if (used.has(i)) return; const d = I.haversine(t.lat, t.lon, c.lat, c.lon); if (d < bd) { bd = d; best = i; } }); const ok = best != null && bd < Math.max(250, t.L); if (ok) { used.add(best); tp++; } rows.push({ t, c: ok ? comps[best] : null, d: bd }); });
    const fp = comps.filter((c, i) => !used.has(i) && !c.rig).length, fn = truth.length - tp;
    L.score = { tp, fp, fn };
    const wakeNote = c => c && c.wake ? (c.wake.detected ? `<span class="text-amber-300">wake ✓ → ${Math.round(c.wake.headingDeg)}°</span>` : '<span class="text-slate-500">no wake</span>') : '–';
    const tr = rows.map(({ t, c, d }) => `<tr><td class="${td}">${t.id}</td><td class="${td} text-slate-400">${(LAB_SHIPS.find(s => s.id === t.id) || {}).name || ''}</td><td class="${td}">${t.L} m @ ${t.sogKn} kn</td><td class="${td}">${c ? '<span class="text-emerald-300">detected</span>' : '<span class="text-red-300">missed</span>'}</td><td class="${td}">${c ? Math.round(c.lengthM) + ' m' : '–'}</td><td class="${td}">${c ? Math.round(d) + ' m' : '–'}</td><td class="${td}">${wakeNote(c)}${c && c.wake && c.wake.detected && t.sogKn > 3 ? ` <span class="text-slate-500">(true ${t.headingDeg}°)</span>` : ''}</td></tr>`).join('');
    const extra = comps.filter((c, i) => !used.has(i) && !c.rig).map(c => `<span class="font-mono-tech text-[10px] text-red-300">(${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}) ${Math.round(c.lengthM)} m</span>`).join(' · ') || '<span class="text-emerald-300">none</span>';
    const dt = performance.now() - t0;
    $('labStats').innerHTML = card('Results', `<div class="flex flex-wrap gap-6 mb-3">${[['Raster', `${R.w}×${R.h} @ ${R.pixM} m`], ['Hits', comps.length + (comps.some(c => c.rig) ? ' (incl. rig)' : '')], ['True positives', tp + '/' + truth.length], ['False alarms', fp], ['CFAR k', f1(C.k, 2) + 'σ'], ['Runtime', Math.round(dt) + ' ms']].map(([a, b]) => `<div><div class="text-[10px] text-slate-400 font-mono-tech uppercase">${a}</div><div class="text-lg font-extrabold font-mono-tech text-white">${b}</div></div>`).join('')}</div>
      ${truth.length ? `<table class="w-full"><tr><th class="${th}">Truth</th><th class="${th}">Type</th><th class="${th}">Size / speed</th><th class="${th}">Result</th><th class="${th}">SAR length</th><th class="${th}">Position err.</th><th class="${th}">Wake</th></tr>${tr}</table>` : ''}
      <div class="mt-2 text-[11px] text-slate-400">Unmatched hits (false alarms / fragments): ${extra}</div>
      ${note('Green rings = ground truth, red boxes = CFAR hits, amber lines = detected wake direction (heading is resolved from the wake side, removing the 180° ambiguity). The rig is a very bright static target: it appears as a hit (not counted as a false alarm) and is handled downstream by the platform mask. Wake fragments along a confirmed wake are merged into their ship. Simulated SAR is only as realistic as the simulator — absolute detection rates will differ on real imagery.')}`);
    if (appState.lastPipelineResult) renderMapLayers(appState.lastPipelineResult);
    renderModules();
  }
  function labCompare() {
    if (!S.lab) return; const R = S.lab.R; $('labStats').insertAdjacentHTML('beforeend', '<div id="labCmpBox" class="mt-4 text-xs text-slate-400 font-mono-tech">comparing filters…</div>');
    setTimeout(() => {
      const truth = (R.truth || []).filter(t => t.inChip), rows = ['none', 'boxcar', 'median', 'lee'].map(f => {
        const P = I.preprocess(R, { ...labParams(), speckle: f, win: 5 }), C = I.cfar(P, R, { pfa: +$('labPfa').value, mode: $('labMode').value, guard: +$('labGuard').value, bg: +$('labBg').value, useMask: true }), comps = I.components(C.det, P, R, { mergePx: 2, minPx: 3 }).filter(c => !(S.lab.source === 'simulated' && LAB_PLAT.some(p => I.haversine(p.lat, p.lon, c.lat, c.lon) < 400))), used = new Set(); let tp = 0;
        truth.forEach(t => { let b = null, bd = 1e9; comps.forEach((c, i) => { if (used.has(i)) return; const d = I.haversine(t.lat, t.lon, c.lat, c.lon); if (d < bd) { bd = d; b = i; } }); if (b != null && bd < Math.max(250, t.L)) { used.add(b); tp++; } });
        return { f, hits: comps.length, tp, fp: comps.length - used.size };
      });
      $('labCmpBox').outerHTML = card('Speckle filter comparison (same CFAR, same raster, 5×5)', `<table class="w-full"><tr><th class="${th}">Filter</th><th class="${th}">Hits</th><th class="${th}">True positives</th><th class="${th}">False alarms</th></tr>${rows.map(r => `<tr><td class="${td}">${r.f}</td><td class="${td}">${r.hits}</td><td class="${td}">${r.tp}/${truth.length}</td><td class="${td}" style="color:${r.fp > 2 ? '#ff6b6d' : '#34d399'}">${r.fp}</td></tr>`).join('')}</table><p class="text-[11px] text-slate-400 mt-2">One scene only (change the seed and repeat). “False alarms” here include fragments of ship wakes and exclude the rig. Without despeckling the CFAR threshold is so high that it also misses ships; Lee keeps ship peaks while shrinking the sea variance.</p>`, 'mt-4');
    }, 30);
  }
  function labToMap() { if (!S.lab) return; showTab('map'); setTimeout(() => { $('chkLayerCfar').checked = true; renderMapLayers(appState.lastPipelineResult); map.fitBounds(S.lab.overlay.bounds); }, 120); }
  async function labLoadTiff(ev) {
    const f = ev.target.files[0], m = $('labFileMsg'); if (!f) return; m.textContent = 'loading geotiff.js…';
    try {
      if (!window.GeoTIFF) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js'; s.onload = res; s.onerror = () => rej(new Error('geotiff.js could not be downloaded (offline?)')); document.head.appendChild(s); });
      const tiff = await GeoTIFF.fromArrayBuffer(await f.arrayBuffer()), img = await tiff.getImage(), bb = img.getBoundingBox(), W0 = img.getWidth(), H0 = img.getHeight(), sc = Math.min(1, 1600 / Math.max(W0, H0)), W = Math.round(W0 * sc), H = Math.round(H0 * sc);
      if (Math.abs(bb[0]) > 180 || Math.abs(bb[1]) > 90) throw new Error('GeoTIFF is not in lat/lon (EPSG:4326). Reproject first, e.g. gdalwarp -t_srs EPSG:4326.');
      const ras = await img.readRasters({ width: W, height: H, interleave: false }), band = ras[0], type = $('labType').value, latc = (bb[1] + bb[3]) / 2;
      const pixM = (bb[2] - bb[0]) / W * 111320 * Math.cos(latc * Math.PI / 180);
      const store = type === 'sigma0_db' ? Float32Array : type === 'sigma0_lin' ? Float32Array : Uint16Array, dn = new store(W * H);
      for (let i = 0; i < dn.length; i++) { const v = band[i]; dn[i] = Number.isFinite(v) ? v : (type === 'sigma0_db' ? -40 : 0); }
      const geo = { west: bb[0], north: bb[3], dLon: (bb[2] - bb[0]) / W, dLat: (bb[3] - bb[1]) / H };
      const mask = I.landMask(W, H, geo, landPolys());
      S.lab = { R: { w: W, h: H, pixM, geo, dn, calA: 1, noiseDb: -25, mask, truth: [], incAt: null, passHeading: 349 }, source: 'geotiff', inputType: type };
      m.textContent = `${f.name}: ${W}×${H} px, ${pixM.toFixed(1)} m/px. Land mask uses the coarse built-in coastline only.`; labRun();
    } catch (err) { m.textContent = 'Failed: ' + err.message; }
  }

  /* ---- Validation ---- */
  function benchCfg() {
    const g = (id, d) => ($(id) ? +$(id).value : d);
    return { seed: g('bvSeed', 11), nScenes: g('bvScenes', 10), nShips: g('bvShips', 40), darkFrac: g('bvDark', 20) / 100, spoofFrac: g('bvSpoof', 5) / 100, faBase: g('bvFa', 8), gapProb: g('bvGap', 25) / 100, cluster: g('bvCl', 60) / 100, clusterM: 1200,
      buffer: appState.matchBufferMeters, assignment: S.assignment, azComp: S.azComp, envConf: S.envConf, interp: S.interp, env: S.env };
  }
  function cmGrid(rows, cols, data, cls) {
    const mx = Math.max(1, ...data.flat());
    return `<table class="font-mono-tech text-[11px]"><tr><td></td>${cols.map(c => `<th class="px-3 py-1 text-slate-400 font-normal text-center">${c}</th>`).join('')}</tr>${rows.map((r, i) => `<tr><th class="pr-3 text-right text-slate-400 font-normal">${r}</th>${data[i].map((v, j) => `<td class="w-24 h-14 text-center border border-slate-800 text-sm font-bold text-white" style="background:rgba(${(cls[i][j] === 'good') ? '52,211,153' : '255,107,109'},${(0.08 + 0.7 * v / mx).toFixed(2)})">${v}</td>`).join('')}</tr>`).join('')}</table>`;
  }
  function renderVal() {
    const el = $('viewVal'); if (!el) return;
    if (!el.dataset.ready) {
      el.dataset.ready = 1;
      const nf = (id, l, v, mn, mx) => `<label class="text-[10px] text-slate-400 block">${l}<input id="${id}" type="number" value="${v}" min="${mn}" max="${mx}" class="w-full bg-[#0a0d1a] border border-slate-700 rounded px-2 py-1 text-xs font-mono-tech text-slate-200 mt-0.5"/></label>`;
      el.innerHTML = `<div class="max-w-7xl mx-auto space-y-5"><div class="border-b border-blue-500/30 pb-4"><h1 class="text-2xl font-extrabold text-white mt-1">Validation &amp; benchmarking</h1><p class="text-xs text-slate-400 mt-1">Synthetic scenes with <b class="text-white">known truth</b> (AIS-on, dark, spoofed, clutter) are pushed through the <b>same matching code</b> the dashboard uses. Results measure the algorithm on synthetic physics — not real-world accuracy. Bring your own labels below for real data.</p></div>
      <div class="grid lg:grid-cols-4 gap-5"><div>${card('Benchmark setup', `<div class="grid grid-cols-2 gap-2">${nf('bvSeed', 'Seed', 11, 1, 9999)}${nf('bvScenes', 'Scenes', 10, 2, 40)}${nf('bvShips', 'Ships / scene', 40, 10, 120)}${nf('bvDark', 'Dark %', 20, 0, 90)}${nf('bvSpoof', 'Spoofed %', 5, 0, 50)}${nf('bvFa', 'Clutter base', 8, 0, 60)}${nf('bvGap', 'AIS gap %', 25, 0, 90)}${nf('bvCl', 'Clustered %', 60, 0, 100)}</div><button id="bvRun" class="w-full mt-3 px-2 py-1.5 rounded bg-[#4f8cff] text-white text-xs font-bold font-mono-tech">Run benchmark</button>${note('Uses current buffer, environment and Fusion-Engine toggles for the “current config” matrix; the comparison table always runs all four variants.')}`)}</div>
      <div class="lg:col-span-3 space-y-5" id="bvOut"><div class="text-xs text-slate-500">running…</div></div></div>
      ${card('Validate on your own data', `<div class="grid md:grid-cols-2 gap-4"><div class="text-xs text-slate-300">Upload <span class="font-mono-tech text-sky-300">det_id,label</span> (label = dark | matched | platform | clutter). The current pipeline output for ALL passes is compared with your labels and the same metrics are produced.<input id="bvLab" type="file" accept=".csv" class="block mt-2 text-[10px] text-slate-400"/><button id="bvTpl" class="mt-2 px-2 py-1 rounded bg-slate-800 text-sky-300 text-[11px] font-mono-tech">Download template pre-filled with current predictions (edit it)</button></div><div id="bvLabOut" class="text-xs text-slate-500">No labels loaded.</div></div>`)}</div>`;
      $('bvRun').onclick = runBench; $('bvLab').onchange = async e => { const f = e.target.files[0]; if (f) { S.labels = parseCsvString(await f.text()); labelEval(); } };
      $('bvTpl').onclick = labelTemplate;
      runBench(); if (window.renderValExtra) window.renderValExtra();
    }
  }
  function labelTemplate() {
    const rows = [['det_id', 'label']]; S.subs.forEach(s => s.allSceneDetections.forEach(d => rows.push([d.det_id, d.status === 'DARK_VESSEL' ? 'dark' : d.status === 'AIS_MATCHED' ? 'matched' : 'platform'])));
    triggerDownload(rows.map(r => r.join(',')).join('\n'), 'labels_template.csv', 'text/csv');
  }
  function labelEval() {
    const pred = new Map(); S.subs.forEach(s => s.allSceneDetections.forEach(d => pred.set(d.det_id, d.status === 'DARK_VESSEL' ? 'dark' : d.status === 'AIS_MATCHED' ? 'matched' : 'platform')));
    const r = I.confusionFromLabels(pred, S.labels), cls = ['dark', 'matched', 'platform', 'clutter'], cols = ['dark', 'matched', 'platform', 'filtered'];
    $('bvLabOut').innerHTML = `<div class="text-[10px] text-slate-400 mb-1">${r.n} labelled detections · rows = your label, columns = pipeline output</div>` + cmGrid(cls, cols, cls.map(a => cols.map(b => r.M[a][b])), cls.map((a, i) => cols.map((b, j) => (a === b || (a === 'clutter' && b === 'filtered')) ? 'good' : 'bad'))) + `<div class="mt-2 font-mono-tech text-[11px] text-slate-300">Dark-vessel precision <b class="text-white">${pct(r.precision)}</b> · recall <b class="text-white">${pct(r.recall)}</b> · F1 <b class="text-white">${f1(r.f1, 3)}</b> · MCC <b class="text-white">${f1(r.mcc, 3)}</b></div>`;
  }
  function runBench() {
    $('bvOut').innerHTML = '<div class="text-xs text-slate-400 font-mono-tech p-3">simulating scenes…</div>';
    setTimeout(() => {
      const cfg = benchCfg(), B = I.runBenchmark(cfg), c = B.current; S.bench = B;
      const best = B.table.reduce((a, b) => (b.assoc.f1 > a.assoc.f1 ? b : a));
      const vt = B.table.map(t => `<tr class="${t === best ? 'bg-emerald-500/10' : ''}"><td class="${td}">${t.name}</td><td class="${td}">${pct(t.assoc.precision)}</td><td class="${td}">${pct(t.assoc.recall)}</td><td class="${td}">${f1(t.assoc.f1, 3)}</td><td class="${td}">${f1(t.assoc.mcc, 3)}</td><td class="${td}">${t.wrongId}</td><td class="${td}">${t.clutterFlag}</td></tr>`).join('');
      const m = c.matrix, mat = [[m.AIS.M, m.AIS.D, m.AIS.F, m.AIS.N], [m.DARK.M, m.DARK.D, m.DARK.F, m.DARK.N], [m.CLUTTER.M, m.CLUTTER.D, m.CLUTTER.F, 0]];
      const a = c.assoc, ci = a.tp + a.fp ? '' : '';
      const sweep = B.bufSweep, bs = chart({ series: [{ name: 'precision', color: '#ff6b6d', pts: sweep.map(s => [s.buffer, s.precision]), dots: 1 }, { name: 'recall', color: '#34d399', pts: sweep.map(s => [s.buffer, s.recall]), dots: 1 }, { name: 'F1 (association)', color: '#4f8cff', pts: sweep.map(s => [s.buffer, s.f1]), dots: 1 }], xmin: 100, xmax: 2000, ymin: 0.4, ymax: 1, xl: 'match buffer (m)', yl: 'score', fmtY: v => v.toFixed(2), marks: [{ x: appState.matchBufferMeters, label: 'current', color: '#f5b301' }] });
      $('bvOut').innerHTML = `<div class="grid md:grid-cols-4 gap-3">${[['Precision', pct(c.endToEnd.precision), 'of dark alerts that are truly dark'], ['Recall', pct(c.endToEnd.recall), 'of all dark ships found'], ['F1 (assoc.)', f1(a.f1, 3), 'dark vs AIS association'], ['MCC', f1(a.mcc, 3), 'balanced correlation']].map(([t, v, s]) => `<div class="bg-[#131936] border border-slate-700/80 rounded-xl p-3"><div class="text-[10px] font-mono-tech uppercase text-slate-400">${t}</div><div class="text-2xl font-extrabold font-mono-tech text-white">${v}</div><div class="text-[10px] text-slate-500">${s}</div></div>`).join('')}</div>
      <div class="grid lg:grid-cols-2 gap-5">${card('Confusion matrix · association (positive = dark ship)', cmGrid(['Truly dark', 'Truly AIS-on'], ['Flagged dark', 'Matched to AIS'], [[a.tp, a.fn], [a.fp, a.tn]], [['good', 'bad'], ['bad', 'good']]) + note(`TP ${a.tp} · FN ${a.fn} · FP ${a.fp} · TN ${a.tn} · specificity ${pct(a.specificity)} · false-positive rate ${pct(a.fpr)}. ${c.wrongId} AIS-on ships were matched to the <i>wrong</i> transponder.`))}
      ${card('Where each truth class ended up', cmGrid(['AIS-on ships', 'Dark / spoofed', 'Sea clutter'], ['Matched', 'Flagged dark', 'Filtered (conf.)', 'Not detected'], mat, [['good', 'bad', 'good', 'bad'], ['bad', 'good', 'bad', 'bad'], ['bad', 'bad', 'good', 'good']]) + note(`${c.clutterFlag} clutter blobs became false dark alerts. Ships below the detectability floor (${Math.round(I.minDetectableLength(S.env))} m at the current sea state) are never seen by SAR, so they cap achievable recall.`))}</div>
      ${card('Algorithm comparison (same scenes)', `<table class="w-full"><tr><th class="${th}">Pipeline</th><th class="${th}">Precision</th><th class="${th}">Recall</th><th class="${th}">F1</th><th class="${th}">MCC</th><th class="${th}">Wrong ID</th><th class="${th}">Clutter alerts</th></tr>${vt}</table>${note(`${B.scenes} scenes, ${B.detections} detections. Azimuth compensation dominates here because the generator <i>does</i> displace moving ships (as real SAR does). Hungarian vs greedy differs only in dense clusters; on this seed the difference is small, which is itself an honest finding — see the explicit trap case in the Intelligence tab.`)}`)}
      ${card('Sensitivity to match buffer', bs)}`;
    }, 30);
  }

  /* ---------------- 9. tabs ---------------- */
  const TABS = [['map', 'tabBtnMap', 'viewOpsMap'], ['intel', 'tabBtnIntel', 'viewIntel'], ['env', 'tabBtnEnv', 'viewEnv'], ['sar', 'tabBtnSar', 'viewSar'], ['val', 'tabBtnVal', 'viewVal'], ['data', 'tabBtnData', 'viewData'], ['report', 'tabBtnReport', 'viewReport'], ['method', 'tabBtnMethod', 'viewMethodLimits']];
  let current = 'map';
  window.showTab = function (k) {
    current = k;
    TABS.forEach(([key, b, v]) => {
      const on = key === k; $(v).classList.toggle('hidden', !on);
      $(b).className = 'navtab' + (on ? ' is-active' : '');
    });
    if (k === 'map') setTimeout(() => map.invalidateSize(), 50); else if (k === 'intel') renderIntel(); else if (k === 'env') renderEnv(); else if (k === 'sar') renderLab(); else if (k === 'val') renderVal(); else if (k === 'data' && window.renderData) window.renderData(); else if (k === 'report' && window.renderReport) window.renderReport();
    $(TABS.find(t => t[0] === k)[2]).scrollTop = 0;
    document.querySelector('body > section.w-full').style.display = k === 'map' ? '' : 'none'; $('moduleBar').style.display = k === 'map' ? '' : 'none';
  };
  function refreshActiveView() { if (current === 'intel') renderIntel(); else if (current === 'val') { S.bench = null; runBench && runBench(); } }

  function injectViews() {
    const host = $('viewMethodLimits');
    ['viewIntel', 'viewEnv', 'viewSar', 'viewVal', 'viewData', 'viewReport'].forEach(id => { const s = document.createElement('section'); s.id = id; s.className = 'hidden flex-1 overflow-y-auto px-6 py-6 md:px-8'; host.before(s); });
    TABS.forEach(([k, b]) => $(b).addEventListener('click', () => showTab(k)));
  }


  /* ---------------- 10. analysis-module bar (every key feature as a visible, live control) ---------------- */
  const IC = {
    assign: '<path d="M5 6h4v4H5zM15 14h4v4h-4zM9 8h3a3 3 0 013 3v3"/>',
    unc: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><circle cx="12" cy="12" r="1.2"/>',
    mt: '<path d="M4 18l5-6 4 3 7-9"/><circle cx="4" cy="18" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="13" cy="15" r="1.3"/><circle cx="20" cy="6" r="1.3"/>',
    risk: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M12 8v5M12 16h.01"/>',
    spoof: '<path d="M12 9v4M12 17h.01M10.3 3.9L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>',
    dens: '<path d="M4 20V11M9 20V5M14 20v-7M19 20V8M2 20h20"/>',
    env: '<path d="M3 8h11a3 3 0 10-3-3M3 12h15a3 3 0 11-3 3M3 16h7"/>',
    cfar: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    val: '<path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>'
  };
  const flip = id => { const c = $(id); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); renderModules(); } };
  const MODS = [
    { id: 'assign', title: 'Hungarian matching', kind: 'toggle', tip: 'Match every SAR detection to AIS by solving the whole scene at once instead of nearest-first. Click to switch to greedy and compare.', on: () => S.assignment === 'hungarian', act: () => { S.assignment = S.assignment === 'hungarian' ? 'greedy' : 'hungarian'; $('selAssign').value = S.assignment; updateDashboard(); refreshActiveView(); },
      metric: r => { const a = r.assignInfo; if (!a) return '–'; const d = a.chosen - a.greedy; return a.algo === 'hungarian' ? `${a.chosen} matched · ${d > 0 ? '+' + d + ' vs greedy' : a.diff.length ? a.diff.length + ' re-assigned' : 'same as greedy here'}` : `${a.chosen} matched · greedy baseline`; } },
    { id: 'unc', title: 'AIS uncertainty', kind: 'toggle', tip: 'Draw 95% uncertainty ellipses for AIS positions at the SAR time. A hull outside its ellipse is not that ship.', on: () => $('chkLayerEllipse') && $('chkLayerEllipse').checked, act: () => flip('chkLayerEllipse'),
      metric: r => { const sg = r.aisInterpolated.map(a => a.quality.sigmaM).sort((a, b) => a - b), n = sg.length, bad = r.aisInterpolated.filter(a => a.quality.grade === 'C' || a.quality.grade === 'D').length; return n ? `median σ ${Math.round(sg[n >> 1])} m · ${bad} low-quality` : '–'; } },
    { id: 'mt', title: 'Multi-pass tracks', kind: 'toggle', tip: 'Link the same hull across satellite passes. Persistent dark hulls are drawn as red dashed tracks.', on: () => $('chkLayerMtrack') && $('chkLayerMtrack').checked, act: () => flip('chkLayerMtrack'),
      metric: () => { const t = S.assoc ? S.assoc.tracks.filter(x => x.kind === 'DARK' && x.members.length > 1).length : 0; return `${t} persistent dark hull${t === 1 ? '' : 's'}`; } },
    { id: 'risk', title: 'Risk scoring', kind: 'open', tip: 'Every alert gets an explainable 0–100 score. Click to open the highest-risk one with its factor breakdown.', on: () => false, act: () => { const r = appState.lastPipelineResult; if (r && r.darkVessels[0]) openInspectorCard(r.darkVessels[0], true); },
      metric: r => { const h = r.darkVessels.filter(d => d.risk && d.risk.score >= 55).length; return `${h} high / critical of ${r.darkVessels.length} alerts`; } },
    { id: 'spoof', title: 'Spoofing checks', kind: 'open', tip: 'AIS integrity: teleports, frozen positions, speed and course that do not fit the track.', on: () => false, act: () => { showTab('intel'); const n = document.querySelector('#viewIntel [data-sec^="ais-spoofing"]'); if (n) n.scrollIntoView({ block: 'center' }); },
      metric: () => { let n = 0; S.spoof.forEach(v => { if (v.score >= 0.5) n++; }); return `${n} identit${n === 1 ? 'y' : 'ies'} flagged`; } },
    { id: 'dens', title: 'Traffic density', kind: 'toggle', tip: 'Heat layer of normal traffic built from AIS history and shipping lanes. Hulls outside it score higher.', on: () => $('chkLayerDensity') && $('chkLayerDensity').checked, act: () => flip('chkLayerDensity'),
      metric: () => 'AIS history + lane prior' },
    { id: 'env', title: 'Sea state', kind: 'open', tip: 'Wind, waves and incidence angle: how clutter hides small ships and creates false alarms.', on: () => false, act: () => showTab('env'),
      metric: () => `${S.env.windSpeed} m/s wind · sea state ${I.seaStateOf(S.env)} · min ship ${Math.round(I.minDetectableLength(S.env))} m` },
    { id: 'cfar', title: 'SAR Lab · CFAR', kind: 'open', tip: 'Run calibration, speckle filtering, CFAR and wake detection on a raster.', on: () => false, act: () => showTab('sar'),
      metric: () => S.lab && S.lab.score ? `${S.lab.score.tp}/${S.lab.score.tp + S.lab.score.fn} ships found · ${S.lab.score.fp} false alarms` : 'Despeckle, detect, find wakes' },
    { id: 'val', title: 'Validation', kind: 'open', tip: 'Confusion matrix, precision, recall, F1 and MCC against synthetic ground truth.', on: () => false, act: () => showTab('val'),
      metric: () => S.bench ? `F1 ${f1(S.bench.current.assoc.f1, 2)} · MCC ${f1(S.bench.current.assoc.mcc, 2)} · ${pct(S.bench.current.endToEnd.recall)} recall` : 'Confusion matrix & metrics' }
  ];
  function renderModules() {
    const g = $('moduleGrid'); const r = appState.lastPipelineResult; if (!g || !r || !r.assignInfo) return;
    g.innerHTML = MODS.map(m => { const on = m.on(); return `<button class="mod ${on ? 'on' : ''} ${m.kind === 'open' ? 'open' : ''}" data-mod="${m.id}" title="${esc(m.tip)}" aria-pressed="${m.kind === 'toggle' ? on : 'false'}"><span class="mod-top"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${(IC[m.id] || m.icon || "")}</svg><span class="mod-title">${m.title}</span><span class="mod-tag">${m.kind === 'toggle' ? (on ? 'On' : 'Off') : 'Open ›'}</span></span><span class="mod-metric">${esc(m.metric(r))}</span></button>`; }).join('');
    g.querySelectorAll('.mod').forEach(b => b.onclick = () => MODS.find(m => m.id === b.dataset.mod).act());
  }
  function ensureBench() { if (S.bench || S.benching) return; S.benching = true; setTimeout(() => { try { S.bench = I.runBenchmark(benchCfg()); } catch (e) { } S.benching = false; renderModules(); }, 80); }
  const _upd = window.updateDashboard;
  window.updateDashboard = function () {
    _upd(); renderModules();
    S.bench = null; clearTimeout(S.bt); S.bt = setTimeout(ensureBench, 500);
  };
  window.renderModules = renderModules;
  window.__ui = { S, I, $, esc, f1, pct, card, chart, th, td, note, RISK_COL, LAB_SHIPS, LAB_PLAT, LAB_BOUNDS, benchCfg, MODS, renderModules, getCurrent: () => current };

  /* ---------------- boot ---------------- */
  const _bind = window.bindUiEvents;
  window.bindUiEvents = function () { _bind(); injectSidebar(); injectViews(); const tg = () => { const g = $('moduleGrid'), h = g.style.display === 'none'; g.style.display = h ? '' : 'none'; $('modToggle').textContent = h ? 'Hide' : 'Show modules'; setTimeout(() => map && map.invalidateSize(), 60); }; $('modToggle').onclick = tg; if (window.innerHeight < 820) setTimeout(tg, 0); };
})();
