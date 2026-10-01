// The host dashboard — "the small button". A single self-contained HTML page
// served by the coordinator, no build step and no dependencies, in keeping
// with the rest of alpha-tunnel. It logs in with the same /auth/login the API
// uses, keeps the token in localStorage, and polls the endpoints the CrowPanel
// and the admin CLI already expose. It renders the same pages the panel
// cycles, so "show me the live CrowPanel" and the web view are one thing.
//
// Dark control-room / HUD styling. Everything degrades to what the signed-in
// credential's scopes allow: a viewer sees the overview and topology; users
// and messages fill in when the token can read them.

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Alpha · Control Room</title>
<style>
  :root{
    --bg:#030914; --panel:#06142b; --panel2:#0a1e3d; --edge:#123a63;
    --ink:#cfe9ff; --dim:#6f97c4; --cyan:#35e4ff; --good:#36f5a6;
    --warn:#ffcf5c; --bad:#ff5c7a; --font:'SF Mono',ui-monospace,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:
      radial-gradient(1200px 600px at 80% -10%, #0b2446 0%, transparent 60%),
      var(--bg);
    color:var(--ink);font-family:var(--font);-webkit-font-smoothing:antialiased}
  a{color:var(--cyan)}
  header{display:flex;align-items:center;gap:14px;padding:12px 18px;
    border-bottom:1px solid var(--edge);background:linear-gradient(180deg,#06152e,#030914)}
  .logo{font-weight:700;letter-spacing:3px;color:var(--cyan);text-shadow:0 0 12px #35e4ff66}
  .pill{font-size:11px;padding:3px 9px;border:1px solid var(--edge);border-radius:999px;color:var(--dim)}
  .pill.live{color:var(--good);border-color:#1e6b4d;box-shadow:0 0 10px #36f5a633}
  .spacer{flex:1}
  nav{display:flex;gap:6px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--edge)}
  nav button{font-family:var(--font);font-size:12px;letter-spacing:1px;color:var(--dim);
    background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:7px 12px;cursor:pointer}
  nav button.on{color:#021018;background:var(--cyan);border-color:var(--cyan);box-shadow:0 0 14px #35e4ff55}
  main{padding:18px;display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
  .card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--edge);
    border-radius:12px;padding:14px;min-height:92px}
  .card h3{margin:0 0 8px;font-size:11px;letter-spacing:2px;color:var(--dim);text-transform:uppercase}
  .big{font-size:30px;color:#fff;text-shadow:0 0 16px #35e4ff44}
  .row{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed #123a6355}
  .row:last-child{border-bottom:0}
  .k{color:var(--dim)} .v{color:var(--ink)}
  .good{color:var(--good)} .warn{color:var(--warn)} .bad{color:var(--bad)}
  .span2{grid-column:span 2} .span3{grid-column:span 3}
  .term{background:#010610;border:1px solid var(--edge);border-radius:10px;padding:10px;
    font-size:12px;line-height:1.5;max-height:260px;overflow:auto;color:#9fe7ff;white-space:pre-wrap}
  .msg{border-left:3px solid var(--cyan);padding:6px 10px;margin:8px 0;background:#061a33}
  .msg .from{color:var(--dim);font-size:11px}
  .unread{box-shadow:-3px 0 0 0 var(--good) inset}
  .muted{color:var(--dim)}
  form.login{max-width:360px;margin:12vh auto;padding:22px;background:var(--panel);
    border:1px solid var(--edge);border-radius:14px}
  form.login input{width:100%;margin:8px 0;padding:10px;background:#02101f;border:1px solid var(--edge);
    border-radius:8px;color:var(--ink);font-family:var(--font)}
  form.login button{width:100%;padding:11px;margin-top:8px;background:var(--cyan);color:#021018;
    border:0;border-radius:8px;font-weight:700;cursor:pointer}
  .err{color:var(--bad);min-height:18px;font-size:12px;margin-top:8px}
  .barwrap{background:#02101f;border:1px solid var(--edge);border-radius:6px;height:10px;overflow:hidden}
  .bar{height:100%;background:linear-gradient(90deg,var(--good),var(--cyan))}
  footer{padding:10px 18px;color:var(--dim);font-size:11px;border-top:1px solid var(--edge)}
</style>
</head>
<body>
<div id="app"></div>
<script>
const PAGES = ['overview','topology','users','activity','crowpanel','cloudflare','messages'];
const PAGE_TITLE = {overview:'Overview',topology:'Topology',users:'Connected users',
  activity:'Activity · terminal',crowpanel:'CrowPanel (live)',cloudflare:'Cloudflare · daily',messages:'Messages'};
let token = localStorage.getItem('alpha.token') || '';
let page = location.hash.replace('#','') || 'overview';
let rotate = true, timer = null;
const state = {};

function h(tag, attrs={}, ...kids){
  const el = document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(k==='class') el.className=v; else if(k==='html') el.innerHTML=v;
    else if(k.startsWith('on')) el.addEventListener(k.slice(2),v); else el.setAttribute(k,v);
  }
  for(const kid of kids) el.append(kid?.nodeType?kid:document.createTextNode(kid??''));
  return el;
}
async function api(path){
  const r = await fetch(path,{headers:{authorization:'Bearer '+token}});
  if(r.status===401){ token=''; localStorage.removeItem('alpha.token'); render(); throw new Error('unauthorized'); }
  if(r.status===403) return {__forbidden:true};
  if(!r.ok) throw new Error(path+' → '+r.status);
  return r.json();
}
async function refresh(){
  if(!token) return;
  const safe = (p)=>api(p).catch((e)=>({__error:String(e.message||e)}));
  const [me,stats,agents,users,tasks,messages,cf] = await Promise.all([
    safe('/me'),safe('/stats'),safe('/agents'),safe('/users'),safe('/tasks?limit=40'),safe('/messages'),safe('/cloudflare/report')
  ]);
  Object.assign(state,{me,stats,agents,users,tasks,messages,cf,at:new Date()});
  draw();
}
function tile(title,body,cls=''){ const c=h('section',{class:'card '+cls}); c.append(h('h3',{},title)); c.append(body); return c; }
function kv(k,v,cls=''){ return h('div',{class:'row'},h('span',{class:'k'},k),h('span',{class:'v '+cls},v)); }

function viewOverview(){
  const s = state.stats||{}; const q = s.queue||{};
  const grid = h('div',{});
  const cards = [
    tile('Agents attached', h('div',{class:'big'}, String(s.agents ?? '—'))),
    tile('Queue depth', h('div',{class:'big'}, String(q.pending ?? q.queued ?? '—'))),
    tile('Running', h('div',{class:'big'}, String(q.running ?? q.leased ?? '—'))),
    tile('Host version', h('div',{class:'big'}, String(s.version ?? '—'))),
  ];
  if(s.__error) cards.push(tile('Stats', h('div',{class:'muted'}, s.__error),'span2'));
  return cards;
}
function viewTopology(){
  const a = state.agents;
  if(a?.__forbidden) return [tile('Topology',h('div',{class:'muted'},'needs agents:read'),'span2')];
  const list = (a?.agents)||[];
  const body = h('div',{});
  if(!list.length) body.append(h('div',{class:'muted'},'no agents attached'));
  for(const ag of list){
    const load = Number(ag.load ?? ag.cpu ?? 0);
    const pct = Math.min(100, Math.round((load>1?load:load*100)));
    const bar = h('div',{class:'barwrap'}, h('div',{class:'bar',style:'width:'+pct+'%'}));
    const cls = pct>90?'bad':pct>60?'warn':'good';
    body.append(kv(ag.id||ag.name||'agent', (ag.status||'online'), cls));
    body.append(bar);
  }
  return [tile('Topology · load',body,'span3'),
    tile('Host',h('div',{},kv('version',(a?.hostVersion)||'—'),kv('capabilities',(state.stats?.capabilities||[]).join(', ')||'—')))];
}
function viewUsers(){
  const u = state.users;
  if(u?.__forbidden) return [tile('Connected users',h('div',{class:'muted'},'needs users:read'),'span2')];
  const list = (u?.users)||[]; const body=h('div',{});
  if(!list.length) body.append(h('div',{class:'muted'},'no users'));
  for(const usr of list){
    const cls = usr.status==='active'?'good':'warn';
    body.append(kv(usr.name||usr.email||usr.id, usr.status||'—', cls));
  }
  return [tile('Connected users ('+list.length+')',body,'span3')];
}
function viewActivity(){
  const t = state.tasks;
  if(t?.__forbidden) return [tile('Activity',h('div',{class:'muted'},'needs tasks:read'),'span2')];
  const list = (t?.tasks)||[]; const lines = list.map((task)=>{
    const when = task.createdAt?new Date(task.createdAt).toLocaleTimeString():'';
    return '['+when+'] '+(task.type||'task')+'  '+(task.state||task.status||'')+(task.agentId?('  @'+task.agentId):'');
  }).join('\\n') || 'no recent tasks';
  return [tile('Activity · terminal', h('div',{class:'term'}, lines),'span3')];
}
function viewCrowpanel(){
  // Mirrors exactly what the panel draws off /stats, so the web view and the
  // device agree. "14s ago" style freshness, since the panel has no clock.
  const s = state.stats||{}; const q=s.queue||{};
  const ago = state.at?Math.round((Date.now()-state.at.getTime())/1000):'?';
  const body = h('div',{});
  body.append(kv('coordinator', s.__error?'unreachable':'online', s.__error?'bad':'good'));
  body.append(kv('agents', String(s.agents ?? '—')));
  body.append(kv('queued', String(q.pending ?? q.queued ?? '—')));
  body.append(kv('running', String(q.running ?? q.leased ?? '—')));
  body.append(kv('blocked (mem)', String(s.memory?.blockedTasks ?? '—')));
  body.append(h('div',{class:'muted',style:'margin-top:8px'}, 'read '+ago+'s ago'));
  return [tile('CrowPanel · live mirror',body,'span2')];
}
function viewCloudflare(){
  const cf = state.cf||{};
  if(cf.__forbidden) return [tile('Cloudflare',h('div',{class:'muted'},'needs agents:read'),'span2')];
  const body=h('div',{});
  if(cf.configured===false || cf.__error){
    body.append(h('div',{class:'muted'}, cf.note || cf.__error || 'no report configured'));
    body.append(h('div',{class:'muted',style:'margin-top:6px'},'set ALPHA_CLOUDFLARE_REPORT on the host to a daily report JSON'));
  } else {
    const r = cf.report||cf;
    for(const [k,v] of Object.entries(r)) body.append(kv(k, typeof v==='object'?JSON.stringify(v):String(v)));
    if(cf.generatedAt) body.append(h('div',{class:'muted',style:'margin-top:6px'},'generated '+new Date(cf.generatedAt).toLocaleString()));
  }
  return [tile('Cloudflare · daily report',body,'span3')];
}
function viewMessages(){
  const m = state.messages||{}; const list=(m.messages)||[];
  const wrap=h('div',{});
  if(m.__error) wrap.append(h('div',{class:'muted'},m.__error));
  if(!list.length) wrap.append(h('div',{class:'muted'},'no messages'));
  for(const msg of list){
    const box=h('div',{class:'msg'+(msg.read?'':' unread')});
    box.append(h('div',{class:'from'},(msg.from||'alpha')+' · '+(msg.createdAt?new Date(msg.createdAt).toLocaleString():'')));
    if(msg.subject) box.append(h('div',{html:'<b>'+esc(msg.subject)+'</b>'}));
    box.append(h('div',{}, msg.body||''));
    wrap.append(box);
  }
  return [tile('Messages'+(m.unread?(' · '+m.unread+' unread'):''),wrap,'span3')];
}
function esc(s){return String(s).replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

const VIEWS={overview:viewOverview,topology:viewTopology,users:viewUsers,activity:viewActivity,
  crowpanel:viewCrowpanel,cloudflare:viewCloudflare,messages:viewMessages};

function draw(){
  const main=document.getElementById('main'); if(!main) return;
  main.innerHTML='';
  for(const card of (VIEWS[page]||viewOverview)()) main.append(card);
  for(const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.p===page);
  const who=document.getElementById('who');
  if(who) who.textContent = state.me?.label ? ('● '+state.me.label) : '';
}
function setPage(p){ page=p; location.hash=p; draw(); }
function render(){
  const app=document.getElementById('app'); app.innerHTML='';
  if(!token){
    const err=h('div',{class:'err'});
    const form=h('form',{class:'login',onsubmit:async(e)=>{
      e.preventDefault(); err.textContent='';
      try{
        const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({email:form.email.value,password:form.password.value})});
        if(!r.ok){ err.textContent='Login failed ('+r.status+')'; return; }
        const data=await r.json(); token=data.token||data.key||'';
        if(!token){ err.textContent='No token returned'; return; }
        localStorage.setItem('alpha.token',token); start();
      }catch(ex){ err.textContent=String(ex.message||ex); }
    }});
    form.append(h('div',{class:'logo'},'ALPHA CONTROL ROOM'));
    form.append(h('input',{name:'email',type:'email',placeholder:'email',autocomplete:'username'}));
    form.append(h('input',{name:'password',type:'password',placeholder:'password',autocomplete:'current-password'}));
    form.append(h('button',{type:'submit'},'Enter'));
    form.append(err);
    app.append(form);
    return;
  }
  const header=h('header',{},
    h('span',{class:'logo'},'ALPHA'),
    h('span',{class:'pill live'},'CONTROL ROOM'),
    h('span',{class:'spacer'}),
    h('span',{id:'who',class:'pill'},''),
    h('button',{class:'pill',style:'cursor:pointer;background:none',onclick:()=>{rotate=!rotate;schedule();}},'⟳ auto'),
    h('button',{class:'pill',style:'cursor:pointer;background:none',onclick:()=>{token='';localStorage.removeItem('alpha.token');render();}},'sign out'));
  const nav=h('nav',{});
  for(const p of PAGES) nav.append(h('button',{'data-p':p,onclick:()=>setPage(p)},PAGE_TITLE[p]));
  const main=h('main',{id:'main'});
  const foot=h('footer',{id:'foot'},'live every 5s · host dashboard');
  app.append(header,nav,main,foot);
  draw(); refresh();
}
function schedule(){ if(timer) clearInterval(timer); timer=setInterval(()=>{ if(rotate){ const i=PAGES.indexOf(page); setPage(PAGES[(i+1)%PAGES.length]); } refresh(); },5000); }
function start(){ render(); schedule(); }
window.addEventListener('hashchange',()=>{ const p=location.hash.replace('#',''); if(PAGES.includes(p)){page=p;draw();}});
start();
</script>
</body>
</html>`;
