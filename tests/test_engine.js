const E=require('../src/engine.js');let fails=0;const ok=(c,m)=>{if(!c){fails++;console.log('FAIL',m)}else console.log('ok  ',m)};
// Hungarian vs brute force
function brute(c){const n=c.length,m=c[0].length;let best=Infinity;const used=Array(m).fill(false);
 (function rec(i,s){if(s>=best)return;if(i===n){best=s;return}
  if(n>m&&false){}
  for(let j=0;j<m;j++)if(!used[j]){used[j]=true;rec(i+1,s+c[i][j]);used[j]=false}
 })(0,0);return best}
const r=E.rng(5);let bad=0;
for(let t=0;t<300;t++){const n=1+Math.floor(r()*6),m=n+Math.floor(r()*3);// n<=m
 const c=Array.from({length:n},()=>Array.from({length:m},()=>Math.floor(r()*50)));
 const a=E.hungarian(c);const s=a.reduce((q,j,i)=>q+c[i][j],0);if(Math.abs(s-brute(c))>1e-9)bad++;
 // transpose case
 const ct=c[0].map((_,j)=>c.map(row=>row[j]));const at=E.hungarian(ct);
 const st=at.reduce((q,j,i)=>j>=0?q+ct[i][j]:q,0);if(Math.abs(st-brute(c))>1e-9)bad++;}
ok(bad===0,'hungarian optimal vs brute force (600 cases, rect + transposed) bad='+bad);
// trap
const cost=[[1,2],[1.1,100]];const a=E.hungarian(cost);ok(a[0]===1&&a[1]===0,'hungarian trap '+a);
// azimuth
const sh=E.azimuthShiftM(10,90,191,39);console.log('az shift 10kn E',sh.toFixed(0),'m');ok(Math.abs(sh)>200&&Math.abs(sh)<3000,'azimuth shift plausible');
// interp
const p=[{tMs:0,lat:25,lon:55,sog:10,cog:90},{tMs:3600e3,lat:25,lon:55.1,sog:10,cog:90}];
const iv=E.interpolateTrack(p,1800e3);ok(Math.abs(iv.lon-55.05)<1e-6&&iv.quality.grade,'interp midpoint '+iv.quality.grade+' sigma '+iv.quality.sigmaM.toFixed(0));
const iv2=E.interpolateTrack(p,5400e3);ok(iv2.mode==='DEAD_RECKONED','dead reckon');
// env
const env=E.DEFAULT_ENV;console.log('clutter',E.clutterDb(env).toFixed(1),'minLen',E.minDetectableLength(env));
ok(E.minDetectableLength({...env,windSpeed:15,hs:2.5})>E.minDetectableLength({...env,windSpeed:3,hs:0.3}),'rough sea raises min length');
// raster+cfar
const b={west:55.0,east:55.08,south:25.9,north:25.97};
const R=E.simulateRaster({bounds:b,pixM:25,env,seed:3,passHeading:191,ships:[{id:'a',lon:55.02,lat:25.93,L:150,headingDeg:60,sogKn:12,wake:true},{id:'b',lon:55.06,lat:25.92,L:60,headingDeg:200,sogKn:0}],platforms:[]});
const P=E.preprocess(R,{speckle:'lee'});const C=E.cfar(P,R,{pfa:1e-6});const comps=E.components(C.det,P,R);
console.log('raster',R.w,R.h,'comps',comps.length,comps.map(c=>[c.lon.toFixed(3),c.lat.toFixed(3),Math.round(c.lengthM)]));
const nearA=comps.some(c=>E.haversine(25.93,55.02,c.lat,c.lon)<300),nearB=comps.some(c=>E.haversine(25.92,55.06,c.lat,c.lon)<300);ok(nearA&&nearB,'cfar finds both ships');
const big=comps.filter(c=>E.haversine(25.93,55.02,c.lat,c.lon)<300).reduce((m,c)=>c.nPx>m.nPx?c:m);const wk=E.wakeDetect(P.db,R.w,R.h,R.mask,big.x,big.y,R.pixM,big.lengthM);console.log('wake',wk);ok(wk.detected&&E.angDiff(wk.headingDeg,60)<15,'wake detected, heading within 15 deg');
// benchmark
const cfg={seed:7,nScenes:6,nShips:30,darkFrac:0.2,spoofFrac:0.05,faBase:8,gapProb:0.2,buffer:500,assignment:'hungarian',azComp:true,envConf:true,interp:'linear'};
const bm=E.runBenchmark(cfg);bm.table.forEach(t=>console.log(t.name.padEnd(55),'F1',t.assoc.f1.toFixed(3),'P',t.endToEnd.precision.toFixed(2),'R',t.endToEnd.recall.toFixed(2),'wrongId',t.wrongId));
// spoof, density, risk
const sp=E.spoofAnalysis(new Map([['1',[{tMs:0,lat:25,lon:55,sog:5,cog:0},{tMs:1200e3,lat:25.5,lon:56,sog:5,cog:0}]]]));ok(sp.get('1').score>0.5,'teleport flagged');
const rs=E.riskScore('dark',{nearestDistM:null,buffer:500,nearestGapMin:null,lengthM:120,confidence:.8,envFalseAlarm:.1,persistPasses:3,platDistM:2000,trafficAnomaly:.8,spoofNear:0});console.log('risk',rs.score,rs.level);
ok(rs.score>70,'persistent large dark = high');
const rl=E.riskScore('dark',{nearestDistM:600,buffer:500,nearestGapMin:120,lengthM:45,confidence:.5,envFalseAlarm:.6,persistPasses:1,platDistM:null,trafficAnomaly:.1,spoofNear:0});console.log('risk low',rl.score);ok(rl.score<rs.score-30,'low-risk lower');
console.log(fails?'FAILS '+fails:'ALL PASS');process.exit(fails?1:0)
