import re,subprocess
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R=lambda f:open(f if os.path.isabs(f) else os.path.join(ROOT,'src',f),encoding='utf-8').read()
base=R('base.html'); ui=R('intel-ui.js'); eng=R('engine.js')
# 1 strip FX layer (comment + style + boot markup + script)
i=base.index('<!-- =====================  VISUAL FX LAYER'); j=base.index('</script>',base.index('<script id="fx">'))+len('</script>')
base=base[:i]+base[j:]
# 2 palette / class mapping (base + ui only)
P={'#0a0d1a':'#0f1216','#080b1a':'#0f1216','#0c1024':'#12161c','#0d1229':'#12161c','#0e1329':'#12161c','#0e142b':'#12161c','#131936':'#171c24','#121730':'#171c24','#11152c':'#171c24','#111630':'#171c24','#101631':'#171c24','#141b38':'#171c24','#151c3b':'#171c24','#161d3a':'#171c24','#161f42':'#1c222b','#1b244a':'#222a35','#222c54':'#222a35','#15122b':'#0f1216','#0f1530':'#0f1216','#1a1240':'#0f1216','#0d1836':'#0d1620','#0f172a':'#12161c','#1e293b':'#262e3a','#332457':'#2d3643','#2a1f05':'#2a2008',
 '#4f8cff':'#3d7eff','#6d4aff':'#3d7eff','#00f2fe':'#2dd4bf','#ff4d4f':'#ef4444','#ff6b6d':'#f87171','#ffb800':'#f59e0b','#f5b301':'#f59e0b','#a855f7':'#64748b','#6366f1':'#52627a','#7fb0ff':'#7aa7ff','#7c8aae':'#8b95a5','#1e2748':'#262e3a','#fbcfe8':'#cbd5e1'}
def remap(t):
    for a,b in P.items(): t=t.replace(a,b)
    t=t.replace('slate-','zinc-').replace('cyan-','teal-').replace('bg-purple-950/90','bg-zinc-800')
    t=re.sub(r'border-blue-500/\d+','border-zinc-700',t)
    return t
base=remap(base); ui=remap(ui)
# 3 structure
hdr=R('header.html'); base=re.sub(r'<header .*?</header>',lambda m:hdr,base,count=1,flags=re.S)
mod='''<section id="moduleBar" class="modbar" aria-label="Analysis modules"><div class="modbar-head"><div><b>Analysis modules</b><span>Switch a method on or off, or open its tool. Cards show the live result for the selected pass.</span></div><button id="modToggle" type="button">Hide</button></div><div id="moduleGrid" class="modgrid"></div></section>

  '''
k=base.index('<!-- ==================== MAIN WORKSPACE: TAB 1'); base=base[:k]+mod+base[k:]
base,n=re.subn(r'<section id="viewMethodLimits".*?\n  </section>\n',lambda m:R('method.html'),base,count=1,flags=re.S); assert n==1
base=re.sub(r'<title>.*?</title>','<title>Seas of Data — Dark-vessel detection (Team Maya)</title>',base,count=1)
base=base.replace('family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;700','family=Inter:wght@400;500;600;700')
for a,b in [('SYNTHETIC DEMO DATA — NOT REAL INCIDENTS','Synthetic demo data — not real incidents'),('TEAM MAYA // CUSTOM CSV (','Custom data ('),('DEMO DATA // TEAM MAYA','Demo data')]:
    base=base.replace(a,b)
# 4 skin + scripts
base=base.replace('</head>','<style id="skin">\n'+R('skin.css')+'\n'+R('radar.css')+'\n</style>\n</head>',1)
ft=R('features-ui.js')
scripts_r='\n<script id="radar">\n'+R('radar.js')+'\n</script>\n'
scripts='\n<script id="intel-engine">\n'+eng.replace('</script','<\\/script')+'\n</script>\n<script id="intel-ui">\n'+ui.replace('</script','<\\/script')+'\n</script>\n<script id="features">\n'+ft.replace('</script','<\\/script')+'\n</script>\n'+scripts_r
base=base.replace('</body>',scripts+'</body>',1)
tw=os.path.join(ROOT,'tools'); open(tw+'/in.html','w',encoding='utf-8').write(base)
subprocess.check_call(["npx","tailwindcss","-i","in.css","-o","out.css","--minify"],cwd=tw,stderr=subprocess.DEVNULL)
css=R(tw+'/out.css'); base=base.replace('<!--TW_INLINE-->','<style id="tw-inline">'+css+'</style>')
out=os.path.join(ROOT,'dist','seas_of_data_radar.html'); open(out,'w',encoding='utf-8').write(base); print(out,len(base)//1024,'KB')
