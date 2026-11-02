/* =====================================================================================
 *  FEATURES UI: CFAR→fusion bridge, data provenance & QC, alert explanations,
 *  statistical validation suite, mission report.  Loaded after intel-ui.js.
 * ===================================================================================== */
(function () {
  'use strict';
  const U = window.__ui; if (!U) return;
  const { S, I, $, esc, f1, pct, card, chart, th, td, note } = U;
  const AOI = () => (typeof AOI_BOUNDS !== 'undefined' ? AOI_BOUNDS : null);
  const pill = (lv, t) => `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold font-mono-tech ${lv === 'pass' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40' : lv === 'warn' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40' : 'bg-red-500/15 text-red-300 border border-red-500/40'}">${t}</span>`;
  const head = (t, sub) => `<div class="border-b border-slate-700 pb-4"><h1 class="text-2xl font-extrabold text-white mt-1">${t}</h1><p class="text-xs text-slate-400 mt-1 max-w-4xl">${sub}</p></div>`;

  /* ---------- data capture: scene clustering at parse time, raw text for provenance ---------- */
  const _parse = window.parseCsvString;
  window.parseCsvString = function (t) { const rows = _parse(t); if (rows.length && 'vv_db' in rows[0]) { const c = I.clusterScenes(rows, 120); S.sceneMerged = c.merged; return c.rows; } return rows; };
  const _load = window.loadDatasetIntoApp;
  window.loadDatasetIntoApp = function (sarCsv, aisCsv, synth) { S.prov = { sarText: sarCsv, aisText: aisCsv, when: new Date().toISOString(), hash: null }; if (synth === true && !S.provKeep) S.source = ''; return _load(sarCsv, aisCsv, synth); };
  async function sha(t) { try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); } catch (e) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return 'fnv1a-' + (h >>> 0).toString(16).padStart(8, '0') + ' (SHA-256 unavailable here)'; } }
  const prov = () => S.prov || (appState.isSynthetic && typeof SYNTHETIC_SAR_CSV !== 'undefined' ? { sarText: SYNTHETIC_SAR_CSV, aisText: SYNTHETIC_AIS_CSV, when: null } : { sarText: '', aisText: '' });
  const runQC = () => I.qc(appState.sarData || [], appState.aisData || [], { aoi: AOI(), scenes: appState.rawSceneTimestamps, synthetic: appState.isSynthetic, source: S.source });

  /* ---------- Data tab ---------- */
  window.renderData = async function () {
    const el = $('viewData'); if (!el) return; const q = runQC(), P = prov(), n = q.summary;
    const sm = (appState.rawSceneTimestamps || []).map(t => ({ t, m: I.sceneMeta(appState.sarData, t, S.passOverride), n: appState.sarData.filter(r => r.time_utc === t).length, acq: appState.sarData.filter(r => r.time_utc === t && r.acq_time_utc).length }));
    const [h1, h2] = await Promise.all([sha(P.sarText || ''), sha(P.aisText || '')]);
    const order = { fail: 0, warn: 1, pass: 2 };
    const rows = q.checks.slice().sort((a, b) => order[a.level] - order[b.level]).map(c => `<tr class="border-t border-slate-800"><td class="py-1.5 pr-3 align-top">${pill(c.level, c.level.toUpperCase())}</td><td class="py-1.5 pr-3 text-xs text-slate-200 align-top">${esc(c.title)}</td><td class="py-1.5 text-[11px] text-slate-400">${esc(c.detail || '')}</td></tr>`).join('');
    el.innerHTML = `<div class="max-w-6xl mx-auto space-y-5">${head('Data provenance &amp; quality checks', 'Everything the pipeline is about to trust, checked first: schema, units, coordinates, time overlap, AIS coverage, and where the files came from.')}
      <div class="grid md:grid-cols-4 gap-3">${[['Checks passed', n.pass, 'text-emerald-300'], ['Warnings', n.warn, 'text-amber-300'], ['Failures', n.fail, n.fail ? 'text-red-300' : 'text-slate-300'], ['Data mode', appState.isSynthetic ? 'Synthetic' : 'Custom', appState.isSynthetic ? 'text-amber-300' : 'text-sky-300']].map(([a, b, c]) => `<div class="bg-[#131936] border border-slate-700/80 rounded-xl p-3"><div class="text-[10px] font-mono-tech text-slate-400">${a}</div><div class="text-2xl font-extrabold font-mono-tech ${c}">${b}</div></div>`).join('')}</div>
      ${card('Quality checks', `<table class="w-full"><tbody>${rows}</tbody></table>`)}
      <div class="grid lg:grid-cols-2 gap-5">${card('Provenance record', `<table class="w-full text-[11px] font-mono-tech"><tr><td class="${td} text-slate-400">SAR detections</td><td class="${td}">${q.nSar} rows · SHA-256 <span class="break-all text-sky-300">${h1}</span></td></tr><tr><td class="${td} text-slate-400">AIS pings</td><td class="${td}">${q.nAis} rows · SHA-256 <span class="break-all text-sky-300">${h2}</span></td></tr><tr><td class="${td} text-slate-400">Loaded</td><td class="${td}">${P.when || 'bundled with the page'}</td></tr><tr><td class="${td} text-slate-400">Scene merging</td><td class="${td}">${S.sceneMerged ? S.sceneMerged + ' detection timestamps merged into scenes (offset kept as acq_time_utc)' : 'none needed'}</td></tr></table>
        <label class="block text-[10px] text-slate-400 mt-3">Source note (stored in the mission report)<textarea id="provSrc" rows="3" class="w-full mt-1 bg-[#0a0d1a] border border-slate-700 rounded p-2 text-xs text-slate-200" placeholder="e.g. COPERNICUS/S1_GRD, IW GRDH VV, orbit 130; AIS from provider X, query 2026-10-18 06:00–22:00Z, bbox …">${esc(S.source || '')}</textarea></label>${note('Hashes let a reviewer confirm that the numbers in the report came from exactly these files.')}`)}
        ${card('Scene geometry', `<table class="w-full"><tr><th class="${th}">Scene</th><th class="${th}">Detections</th><th class="${th}">Pass</th><th class="${th}">Heading</th><th class="${th}">Incidence</th><th class="${th}">Source</th></tr>${sm.map(x => `<tr><td class="${td}">${x.t.slice(0, 16).replace('T', ' ')}Z</td><td class="${td}">${x.n}${x.acq ? ` <span class="text-slate-500">(${x.acq} time-offset)</span>` : ''}</td><td class="${td}">${x.m.pass}</td><td class="${td}">${f1(x.m.heading, 0)}°</td><td class="${td}">${x.m.inc != null ? f1(x.m.inc, 1) + '°' : 'model'}</td><td class="${td} text-slate-400">${esc(x.m.source)}</td></tr>`).join('')}</table>
        ${note('Optional SAR columns used when present: <code class="font-mono-tech text-sky-300">pass_direction, heading_deg, incidence_deg, relative_orbit, platform, instrument_mode, polarisation, length_m, acq_time_utc</code>. Without them the pass is guessed from the UTC hour. <code class="font-mono-tech text-sky-300">acq_time_utc</code> shifts the AIS prediction to the detection\'s own acquisition second.')}`)}</div></div>`;
    const ta = $('provSrc'); if (ta) ta.oninput = () => { S.source = ta.value; };
  };
  const _dash = window.updateDashboard; window.updateDashboard = function () { _dash(); if (U.getCurrent() === 'data') window.renderData(); };

  /* ---------- module cards ---------- */
  const IC = { data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>', rep: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M8 13h8M8 17h5"/>' };
  U.MODS.push({ id: 'data', title: 'Data checks', kind: 'open', tip: 'Schema, units, coordinates, AIS coverage and provenance of the loaded files.', on: () => false, act: () => showTab('data'),
    metric: () => { const n = runQC().summary; return `${n.pass} pass · ${n.warn} warn · ${n.fail} fail`; }, icon: IC.data });
  U.MODS.push({ id: 'rep', title: 'Mission report', kind: 'open', tip: 'One-page report: alerts with explanations, method, validation and caveats. Download or print.', on: () => false, act: () => showTab('report'),
    metric: () => 'Download / print', icon: IC.rep });

  /* ---------- alert explanation in the inspector ---------- */
  function explainHtml(d) {
    if (d.status === 'PLATFORM_MASKED') return ''; let x; try { x = I.explainAlert(d, { buffer: appState.matchBufferMeters }); } catch (e) { return ''; }
    const ul = (t, a, c) => a.length ? `<div class="mt-2"><div class="font-mono-tech text-[10px] uppercase ${c}">${t}</div><ul class="list-disc ml-4 text-[11px] text-slate-300 leading-snug">${a.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : '';
    return `<div class="font-mono-tech text-[10px] uppercase text-slate-400 mb-1">Why this alert</div><div class="text-xs text-white font-semibold leading-snug">${esc(x.headline)}</div>${ul('Evidence', x.why, 'text-red-300')}${ul('Could be innocent', x.innocent, 'text-amber-300')}${ul('What would settle it', x.settle, 'text-emerald-300')}${ul('What-if', x.counter, 'text-sky-300')}`;
  }
  const _oi = window.openInspectorCard;
  window.openInspectorCard = function (d, pan) { _oi(d, pan); const c = $('inspectorCard'); let b = $('inspWhy'); if (!b) { b = document.createElement('div'); b.id = 'inspWhy'; b.className = 'mt-3 pt-3 border-t border-slate-800'; c.appendChild(b); } b.innerHTML = explainHtml(d); };

  /* ---------- statistical validation suite ---------- */
  const bar = (v, c) => `<span class="inline-block h-1.5 rounded align-middle" style="width:${Math.max(2, 60 * v)}px;background:${c}"></span>`;
  const ci = s => `${f1(100 * s.mean, 1)}% <span class="text-slate-500">±${f1(100 * (s.hi - s.lo) / 2, 1)}</span>`;
  window.renderValExtra = function () {
    const host = $('viewVal').firstElementChild; if (!host || $('bvExtra')) return;
    const w = document.createElement('div'); w.id = 'bvExtra'; w.className = 'space-y-5'; w.innerHTML = `<div class="border-t border-slate-700 pt-5"><h2 class="text-lg font-extrabold text-white">Statistical validation suite</h2><p class="text-xs text-slate-400 mt-1 max-w-4xl">Single runs can flatter an algorithm. Here every comparison is repeated over many random seeds with 95% intervals, paired against the greedy baseline, with each component removed in turn, and stress-tested. All on <b>synthetic</b> ground truth, so these numbers show whether the method behaves sensibly, not how it would perform on real shipping.</p>
      <div class="flex items-center gap-3 mt-3"><label class="text-[10px] text-slate-400">Seeds <input id="msN" type="number" value="12" min="3" max="40" class="w-16 ml-1 bg-[#0a0d1a] border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200"/></label><button id="msRun" class="px-3 py-1.5 rounded bg-[#4f8cff] text-white text-xs font-bold font-mono-tech">Run full suite</button><span id="msStat" class="text-[11px] text-slate-500 font-mono-tech"></span></div></div><div id="msOut" class="space-y-5"></div><div id="stOut"></div>`;
    host.appendChild(w); $('msRun').onclick = runSuite; $('stOut').innerHTML = selfTestCard(); setTimeout(runSuite, 120);
  };
  function selfTestCard() {
    const T = I.selfTests(), ok = T.filter(t => t.pass).length;
    return card(`In-browser self-tests · ${ok}/${T.length} pass`, `<table class="w-full">${T.map(t => `<tr class="border-t border-slate-800"><td class="py-1 pr-3 w-14">${pill(t.pass ? 'pass' : 'fail', t.pass ? 'PASS' : 'FAIL')}</td><td class="py-1 pr-3 text-xs text-slate-200">${esc(t.name)}</td><td class="py-1 text-[11px] font-mono-tech text-slate-500">${esc(t.detail || '')}</td></tr>`).join('')}</table>${note('These run in your browser every time this tab opens: Hungarian optimality against brute force, interpolation, ellipse coverage, CFAR false-alarm rate on pure clutter, wake detector, spoof detector, data-quality checks, and more.')}`);
  }
  function runSuite() {
    const n = Math.max(3, Math.min(40, +($('msN') || { value: 12 }).value || 12)), cfg = { ...U.benchCfg(), azComp: true }, out = $('msOut'); $('msStat').textContent = 'running…'; out.innerHTML = '';
    setTimeout(() => {
      const t0 = performance.now(), M = I.multiSeed(cfg, n), A = I.ablation(cfg, Math.max(6, n >> 1)), PR = I.prCurve({ ...cfg, seed: 3 });
      const ST = [['cluster', [0, 0.2, 0.4, 0.6, 0.8, 1], 'Fraction of ships in dense clusters', 'dense clusters'], ['gap', [0, 0.15, 0.3, 0.45, 0.6], 'Probability of AIS reporting gap', 'AIS dropouts'], ['noise', [10, 30, 60, 100, 150], 'SAR position noise (m, 1σ)', 'SAR geolocation noise']].map(([k, vals, xl, nm]) => ({ nm, xl, vals, r: I.stress(cfg, k, vals, 5) }));
      const mrow = v => `<tr class="border-t border-slate-800"><td class="${td}">${esc(v.name)}</td><td class="${td}">${ci(v.f1)}</td><td class="${td}">${ci(v.precision)}</td><td class="${td}">${ci(v.recall)}</td><td class="${td}">${f1(v.wrongId.mean, 1)}</td><td class="${td}">${v.vsBase ? `${v.vsBase.mean >= 0 ? '+' : ''}${f1(100 * v.vsBase.mean, 1)} pts <span class="text-slate-500">[${f1(100 * v.vsBase.lo, 1)}, ${f1(100 * v.vsBase.hi, 1)}]</span> <span class="text-slate-400">${v.vsBase.wins}W/${v.vsBase.ties}T/${v.vsBase.losses}L</span>` : '<span class="text-slate-500">baseline</span>'}</td></tr>`;
      const full = M[M.length - 1], sig = full.vsBase && full.vsBase.lo > 0;
      const sc = ST.map(s => chart({ w: 330, h: 190, series: [{ name: 'F1 mean', color: '#34d399', pts: s.r.map(p => [p.x, p.f1.mean]), dots: 1 }, { name: '95% low', color: '#64748b', pts: s.r.map(p => [p.x, p.f1.lo]), dash: 1 }, { name: '95% high', color: '#64748b', pts: s.r.map(p => [p.x, p.f1.hi]), dash: 1 }], xmin: s.vals[0], xmax: s.vals[s.vals.length - 1], ymin: 0, ymax: 1, xl: s.xl, yl: 'F1', fmtY: v => v.toFixed(1) }));
      const pr = chart({ w: 330, h: 190, series: [{ name: `precision–recall (AP ${f1(PR.ap, 2)})`, color: '#ff6b6d', pts: PR.pts.slice().sort((a, b) => a.recall - b.recall).map(p => [p.recall, p.precision]), dots: 1 }], xmin: 0, xmax: 1, ymin: 0.4, ymax: 1, xl: 'recall', yl: 'precision', fmtY: v => v.toFixed(1) });
      out.innerHTML = `${card(`Multi-seed comparison · ${n} independent benchmark worlds`, `<table class="w-full"><tr><th class="${th}">Pipeline</th><th class="${th}">F1</th><th class="${th}">Precision</th><th class="${th}">Recall</th><th class="${th}">Wrong-ID /scene-set</th><th class="${th}">Paired gain over greedy (F1)</th></tr>${M.map(mrow).join('')}</table>${note(`Mean with 95% interval over seeds. “Paired gain” compares each variant with greedy on the <i>same</i> simulated world, so scene difficulty cancels out; W/T/L counts seeds where it was better / equal / worse. ${sig ? 'The full pipeline\'s interval excludes zero, so the improvement is not seed luck.' : 'The full pipeline\'s interval includes zero here, so do not claim an improvement.'}`)}`)}
        ${card('Ablation · what each component is worth', `<table class="w-full"><tr><th class="${th}">Configuration</th><th class="${th}">F1</th><th class="${th}">Recall</th><th class="${th}">Wrong-ID</th><th class="${th}"></th></tr>${A.map((v, i) => `<tr class="border-t border-slate-800"><td class="${td}">${esc(v.name)}</td><td class="${td}">${ci(v.f1)}</td><td class="${td}">${ci(v.recall)}</td><td class="${td}">${f1(v.wrongId.mean, 1)}</td><td class="${td}">${bar(v.f1.mean, i ? '#fb8a3c' : '#34d399')}</td></tr>`).join('')}</table>${note('Remove one piece at a time from the full pipeline. A component that changes nothing in this benchmark is simply not exercised by it (e.g. Hungarian only matters in dense clusters), which is itself worth knowing.')}`)}
        ${card('Stress tests · F1 vs difficulty (mean and 95% band, 5 seeds each)', `<div class="grid md:grid-cols-3 gap-4">${sc.map((c, i) => `<div><div class="text-[10px] font-mono-tech text-slate-400 mb-1">${ST[i].nm}</div>${c}</div>`).join('')}</div>`)}
        ${card('Precision–recall as the confidence cut-off moves', `<div class="grid md:grid-cols-2 gap-4"><div>${pr}</div><div><table class="w-full"><tr><th class="${th}">Min SAR confidence</th><th class="${th}">Alerts</th><th class="${th}">Precision</th><th class="${th}">Recall</th></tr>${PR.pts.map(p => `<tr><td class="${td}">${Math.round(p.t * 100)}%</td><td class="${td}">${p.alerts}</td><td class="${td}">${pct(p.precision)}</td><td class="${td}">${pct(p.recall)}</td></tr>`).join('')}</table></div></div>`)}`;
      $('msStat').textContent = `done in ${Math.round(performance.now() - t0)} ms`; S.suite = { M, A, PR, ST, n };
    }, 30);
  }

  /* ---------- CFAR → fusion bridge ---------- */
  const T0 = '2026-10-24T02:15:00Z';
  function bridge() {
    const L = S.lab; if (!L || !L.comps) return; const R = L.R, rows = [], ais = [];
    const pd = I.passHeadingFor(Date.parse(T0), S.passOverride) === 349 ? 'ascending' : 'descending', hd = I.passHeadingFor(Date.parse(T0), S.passOverride);
    const sample = []; for (let i = 0; i < L.P.db.length; i += 7) if (!(R.mask && R.mask[i])) sample.push(L.P.db[i]); sample.sort((x, y) => x - y); const bg = sample[sample.length >> 1] || -18;   // median sea level, dB
    L.comps.forEach((c, i) => rows.push([`LAB-DET-${i + 1}`, c.lon.toFixed(5), c.lat.toFixed(5), T0, ((c.peak_db != null ? c.peak_db : c.vv_db) - bg).toFixed(2), Math.round(c.area_m2), (c.wake && c.wake.detected) ? '' : Math.round(c.lengthM), pd, hd, 'SIM', 'IW', 'VV'].join(',')));
    const sar = 'det_id,lon,lat,time_utc,vv_db,area_m2,length_m,pass_direction,heading_deg,platform,instrument_mode,polarisation\n' + rows.join('\n');
    const rg = I.rng(77), t0 = Date.parse(T0), lines = ['mmsi,time_utc,lon,lat,sog,cog,name,ship_type'];
    const fleet = U.LAB_SHIPS.filter(s => s.id !== 'LAB-E').map((s, k) => ({ ...s, mmsi: '4701' + String(k + 1).padStart(5, '0'), name: s.name.toUpperCase(), type: { 'LAB-A': 'Container', 'LAB-B': 'Tanker', 'LAB-C': 'Supply', 'LAB-D': 'Fishing' }[s.id] || 'Cargo' }));
    fleet.push({ id: 'LAB-F', mmsi: '470100099', name: 'GULF COURIER', type: 'Cargo', L: 120, lon: 55.066 + 0.0256, lat: 25.048 + 0.0, headingDeg: 150, sogKn: 6 });
    fleet.forEach(s => { for (let m = -120; m <= 120; m += 20) { if (m === 0) continue; const dt = m * 60, d = s.sogKn * 0.514444 * dt, hr = s.headingDeg * Math.PI / 180, lat = s.lat + (d * Math.cos(hr) + 12 * I.gauss(rg)) / 111320, lon = s.lon + (d * Math.sin(hr) + 12 * I.gauss(rg)) / (111320 * Math.cos(s.lat * Math.PI / 180)); lines.push([s.mmsi, new Date(t0 + dt * 1000).toISOString().replace('.000Z', 'Z'), lon.toFixed(5), lat.toFixed(5), s.sogKn, s.headingDeg, s.name, s.type].join(',')); } });
    if (!KNOWN_OFFSHORE_PLATFORMS.some(p => p.id === 'LAB-RIG')) KNOWN_OFFSHORE_PLATFORMS.push({ id: 'LAB-RIG', name: 'Lab rig (simulated)', lon: U.LAB_PLAT[0].lon, lat: U.LAB_PLAT[0].lat, operator: 'SAR Lab' });
    if (U.$('labAz') && U.$('labAz').checked) S.azComp = true;
    S.provKeep = true; const r = loadDatasetIntoApp(sar, lines.join('\n'), true); S.provKeep = false; S.source = 'SAR Lab: simulated raster → calibration → speckle filter → CFAR → fusion with simulated AIS. Not real data.';
    appState.sceneDates.length && (U.$('sceneSelect').value = '0');
    document.getElementById('dataSourceBadgeText').textContent = 'Simulated raster → CFAR → fusion (synthetic)';
    showTab('map'); setTimeout(() => { if (window.radarScope) window.radarScope.autoFit(); }, 200); return r;
  }
  function bridgeCard() {
    const L = S.lab; if (!L || !L.comps) return ''; const nS = L.comps.length, sc = L.score || {};
    return card('Run fusion on these detections', `<div class="text-xs text-slate-300 leading-relaxed">Send the <b class="text-white">${nS} CFAR detections</b> above (position, peak contrast over the local sea level in dB, area, and length where no wake distorts it) to the live map, together with AIS for four of the simulated ships plus one unrelated courier. The pipeline then matches, scores risk and explains alerts exactly as it does for any other scene, so the output is end-to-end: <span class="text-sky-300">raster → CFAR → AIS fusion → alert</span>.</div>
      <div class="flex items-center gap-3 mt-3"><button id="labBridge" class="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold font-mono-tech">Fuse with AIS on the radar →</button><span class="text-[11px] text-slate-500">Expected: LAB-E (dark loiterer) becomes the dark alert; LAB-RIG is masked; the courier has no SAR hit. Truth score of this CFAR run: ${sc.tp != null ? sc.tp + ' found, ' + sc.fp + ' false alarms, ' + sc.fn + ' missed' : '–'}.</span></div>${note('If “Apply azimuth displacement” is on, moving ships are shifted in the raster; azimuth compensation is switched on for you so the fusion corrects for it.')}`, 'mt-5');
  }
  function mountBridge() {
    const ls = $('labStats'); if (!ls) return; let b = $('labBridgeBox'); if (!b) { b = document.createElement('div'); b.id = 'labBridgeBox'; ls.after(b); }
    const upd = () => { b.innerHTML = bridgeCard(); const bt = $('labBridge'); if (bt) bt.onclick = bridge; };
    if (!ls._obs) { ls._obs = new MutationObserver(upd); ls._obs.observe(ls, { childList: true }); } upd();
  }
  const _tab = window.showTab; window.showTab = function (k) { _tab(k); if (k === 'sar') setTimeout(mountBridge, 60); };

  /* ---------- Mission report ---------- */
  function svgPlot(r) {
    const pts = [...r.matchedVessels, ...r.darkVessels, ...r.platformRejections]; if (!pts.length) return '';
    let la0 = Math.min(...pts.map(p => p.lat)), la1 = Math.max(...pts.map(p => p.lat)), lo0 = Math.min(...pts.map(p => p.lon)), lo1 = Math.max(...pts.map(p => p.lon));
    const pl = Math.max((la1 - la0) * 0.15, 0.03), po = Math.max((lo1 - lo0) * 0.15, 0.03); la0 -= pl; la1 += pl; lo0 -= po; lo1 += po;
    const k = Math.cos((la0 + la1) / 2 * Math.PI / 180), W = 560, H = Math.max(260, Math.min(520, Math.round(W * (la1 - la0) / ((lo1 - lo0) * k)))), X = lon => (lon - lo0) / (lo1 - lo0) * W, Y = lat => H - (lat - la0) / (la1 - la0) * H;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:#04101f;border:1px solid #1d4268;overflow:hidden">`;
    (typeof OFFLINE_COASTLINE_POLYGONS !== 'undefined' ? OFFLINE_COASTLINE_POLYGONS : []).forEach(p => { s += `<polygon points="${p.coords.map(c => X(c[1]).toFixed(1) + ',' + Y(c[0]).toFixed(1)).join(' ')}" fill="#c9a22733" stroke="#c9a227" stroke-width="1"/>`; });
    r.matchedVessels.forEach(m => { s += `<circle cx="${X(m.lon)}" cy="${Y(m.lat)}" r="6" fill="none" stroke="#46e07a" stroke-width="1.6"/>`; });
    r.platformRejections.forEach(m => { s += `<rect x="${X(m.lon) - 5}" y="${Y(m.lat) - 5}" width="10" height="10" fill="none" stroke="#f2c935" stroke-width="1.6"/>`; });
    r.darkVessels.forEach((d, i) => { const x = X(d.lon), y = Y(d.lat); s += `<path d="M${x} ${y - 9}L${x + 9} ${y}L${x} ${y + 9}L${x - 9} ${y}Z" fill="#ff4a3d33" stroke="#ff4a3d" stroke-width="2"/><text x="${x + 12}" y="${y + 4}" fill="#fff" font-size="12" font-family="monospace">${i + 1}</text>`; });
    s += `<text x="8" y="${H - 8}" fill="#8fb0d4" font-size="10" font-family="monospace">${la0.toFixed(2)}–${la1.toFixed(2)}°N · ${lo0.toFixed(2)}–${lo1.toFixed(2)}°E</text>`;
    return s + '</svg>';
  }
  function reportHtml() {
    const r = appState.lastPipelineResult; if (!r) return '<p>No data loaded.</p>'; const q = runQC(), P = prov(), when = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', sc = r.sceneTimeIso === 'ALL_SCENES' ? 'all passes' : r.sceneTimeIso;
    const alerts = r.darkVessels.slice(0, 8).map((d, i) => { const x = I.explainAlert(d, { buffer: appState.matchBufferMeters }), li = a => a.map(t => `<li>${esc(t)}</li>`).join(''); return `<div class="al"><h3>${i + 1}. ${esc(d.det_id)} <span class="rk r${d.risk.level}">${d.risk.level} · ${d.risk.score}</span></h3><div class="meta">${d.lat.toFixed(4)}°N ${d.lon.toFixed(4)}°E · ~${d.estLengthM} m · confidence ${Math.round(d.confidence * 100)}% · seen in ${d.persistPasses} pass${d.persistPasses > 1 ? 'es' : ''}</div><p><b>${esc(x.headline)}</b></p><div class="cols"><div><h4>Evidence</h4><ul>${li(x.why)}</ul></div><div><h4>Could be innocent</h4><ul>${li(x.innocent)}</ul></div><div><h4>Next steps</h4><ul>${li(x.settle)}</ul></div></div></div>`; }).join('') || '<p>No dark-vessel alerts for this selection.</p>';
    const sr = S.suite, full = sr && sr.M[sr.M.length - 1], val = sr ? `<table><tr><th>Pipeline</th><th>F1</th><th>Recall</th></tr>${sr.M.map(v => `<tr><td>${esc(v.name)}</td><td>${f1(100 * v.f1.mean, 1)}% ±${f1(50 * (v.f1.hi - v.f1.lo), 1)}</td><td>${f1(100 * v.recall.mean, 1)}%</td></tr>`).join('')}</table><p class="small">${sr.n} seeds, 95% intervals. Full pipeline vs greedy: ${full.vsBase ? (full.vsBase.mean >= 0 ? '+' : '') + f1(100 * full.vsBase.mean, 1) + ' F1 points [' + f1(100 * full.vsBase.lo, 1) + ', ' + f1(100 * full.vsBase.hi, 1) + ']' : ''}. Synthetic ground truth only.</p>` : '<p class="small">Open the Validation tab to run the multi-seed suite; results are then included here.</p>';
    const fl = q.checks.filter(c => c.level !== 'pass').map(c => `<li><b>${c.level.toUpperCase()}</b> ${esc(c.title)}${c.detail ? ' — ' + esc(c.detail) : ''}</li>`).join('') || '<li>All checks passed.</li>';
    const css = 'body{font:13px/1.55 Tahoma,Segoe UI,Arial,sans-serif;color:#13202f;margin:0;padding:28px;max-width:900px;margin:auto}h1{font-size:22px;margin:0}h2{font-size:15px;border-bottom:2px solid #13202f;padding-bottom:3px;margin:22px 0 8px}h3{font-size:13.5px;margin:0}h4{font-size:11px;text-transform:uppercase;color:#555;margin:6px 0 2px}.sub{color:#555}.warn{background:#fff6dd;border:1px solid #d9a600;padding:8px 10px;margin:12px 0}.kpis{display:flex;gap:10px;margin:10px 0}.kpis div{flex:1;border:1px solid #bbb;padding:6px 8px}.kpis b{font-size:20px;display:block}.al{border:1px solid #bbb;padding:8px 10px;margin:8px 0;break-inside:avoid}.meta{font-family:Consolas,monospace;font-size:11px;color:#444}.cols{display:flex;gap:14px}.cols>div{flex:1}ul{margin:2px 0 2px 16px;padding:0}.rk{font-size:11px;padding:1px 6px;border-radius:2px;color:#fff;background:#666;margin-left:6px}.rCRITICAL{background:#c0201a}.rHIGH{background:#d9641c}.rMEDIUM{background:#b58900}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:3px 7px;text-align:left;font-size:12px}.small{font-size:11.5px;color:#555}@media print{body{padding:0}}';
    return `<!doctype html><html><head><meta charset="utf-8"><title>Seas of Data mission report</title><style>${css}</style></head><body><h1>Dark-vessel mission report</h1><div class="sub">Seas of Data · Team Maya (Mansha Saraswat, Diya Salecha, Daksh Gandhi) · generated ${when} · scene ${esc(sc)}</div>
      ${appState.isSynthetic ? '<div class="warn"><b>Synthetic data.</b> Every vessel, position and rig in this report is fictional. It demonstrates the method; it is not evidence about real ships.</div>' : ''}
      <div class="kpis"><div><b>${r.totalValidSar}</b>SAR detections used</div><div><b>${r.matchedVessels.length}</b>matched to AIS</div><div><b>${r.darkVessels.length}</b>dark-vessel alerts</div><div><b>${r.platformRejections.length}</b>masked as rigs</div></div>
      <h2>Situation</h2>${svgPlot(r)}<p class="small">Red diamonds = dark-vessel alerts (numbered as below), green circles = AIS-matched, yellow squares = rigs. Coastline is stylised.</p>
      <h2>Alerts</h2>${alerts}
      <h2>Method</h2><p>Detections (${esc(I.VARIANTS ? 'CFAR on calibrated, despeckled σ⁰ or supplied CSV' : '')}) are matched to AIS tracks interpolated to the SAR acquisition time. Assignment: <b>${S.assignment}</b> (Mahalanobis cost with AIS uncertainty, azimuth-shift and SAR position error); azimuth compensation ${S.azComp ? 'on' : 'off'}; size-aware cost ${S.sizeAware !== false ? 'on' : 'off'}. Unmatched hulls are scored by an additive-logit risk model (no AIS correlate, hull size, SAR confidence, sea-state false-alarm risk, persistence over passes, rig proximity, traffic anomaly, nearby spoofing, shadowing a transmitting ship). Match buffer ${appState.matchBufferMeters} m, min confidence ${Math.round(appState.minConfidence * 100)}%, sea state ${I.seaStateOf(S.env)} (${S.env.windSpeed} m/s wind; ${esc(S.envSource)}).</p>
      <h2>Data provenance</h2><p class="small">${q.nSar} SAR rows, ${q.nAis} AIS pings. Source: ${esc(S.source || (appState.isSynthetic ? 'bundled synthetic dataset' : 'not recorded'))}.<br>Hashes are on the Data tab.</p><ul>${fl}</ul>
      <h2>Validation</h2>${val}
      <h2>Limits</h2><ul><li>Dark means “no AIS match within the statistical gate”, not “illegal”. AIS gaps, small boats without transponders and position errors all produce false alerts.</li><li>SAR length is estimated from blob area and brightness; below ~40 m it is unreliable.</li><li>Risk scores are hand-set weights, not fitted to real incident data.</li><li>Benchmark numbers come from synthetic worlds generated by the same assumptions as the method.</li></ul></body></html>`;
  }
  window.renderReport = function () {
    const el = $('viewReport'); if (!el) return;
    if (!el.dataset.ready) { el.dataset.ready = 1; el.innerHTML = `<div class="max-w-5xl mx-auto space-y-4">${head('Mission report', 'A single page you can hand over: the alerts with evidence and next steps, how they were produced, data provenance and honest limits. It reflects the scene and settings currently on the radar.')}<div class="flex gap-3"><button id="repDl" class="px-3 py-1.5 rounded bg-[#4f8cff] text-white text-xs font-bold font-mono-tech">Download HTML</button><button id="repPr" class="px-3 py-1.5 rounded bg-slate-700 text-white text-xs font-bold font-mono-tech">Print / save PDF</button><button id="repRe" class="px-3 py-1.5 rounded bg-slate-800 text-sky-300 text-xs font-mono-tech">Refresh</button></div><iframe id="repFrame" class="w-full bg-white rounded" style="height:calc(100vh - 260px);min-height:480px;border:1px solid #1d4268"></iframe></div>`;
      $('repDl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([reportHtml()], { type: 'text/html' })); a.download = 'seas_of_data_mission_report.html'; a.click(); }; $('repPr').onclick = () => { const f = $('repFrame'); f.contentWindow.focus(); f.contentWindow.print(); }; $('repRe').onclick = window.renderReport; }
    $('repFrame').srcdoc = reportHtml();
  };
  U.renderModules();
})();
