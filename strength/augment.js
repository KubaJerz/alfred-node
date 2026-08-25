#!/usr/bin/env node
// A one-off, localhost-only tool to review and hand-correct workout
// interpretations. It shows every lifting workout's *raw* sets (reps + weight
// straight from the Garmin FIT) next to the model's interpretation, lets you set
// the exercise per set (and the session style), and writes lift_set + set_muscle
// back to the live strength.db — applying the same misfire rule and muscle factor
// map the digest uses, so the numbers stay consistent.
//
// It also appends every saved workout to agent/var/strength-corrections.jsonl
// (gitignored) — a growing set of human-labelled examples we can later fold into
// the interpreter prompt.
//
//   node strength/augment.js         # then open the printed http://127.0.0.1 URL
//
// Bound to loopback only; single-user machine. Stop with Ctrl-C.

import http from "node:http";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { openDb, defaultDbPath, getExerciseMap, getTemplates, rawSetsForWorkout } from "./db.js";
import { kgToLb } from "./config.js";

const PORT = Number(process.env.AUGMENT_PORT || 7867);
const HOST = process.env.AUGMENT_HOST || "127.0.0.1";  // set 0.0.0.0 to reach over the LAN
const DB_PATH = process.env.STRENGTH_DB || defaultDbPath();
const CORRECTIONS = path.join(path.dirname(DB_PATH), "strength-corrections.jsonl");
const db = openDb(DB_PATH);

const catGuess = (wc) => {
  try {
    const c = JSON.parse(wc)?.category || [];
    return [...new Set(c.filter((x) => x && x !== "unknown"))];
  } catch { return []; }
};

const json = (res, obj, code = 200) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

function listWorkouts() {
  const ws = db.prepare("SELECT id, date, type, style, interpreted_at FROM workout WHERE is_lifting = 1 ORDER BY date DESC").all();
  return ws.map((w) => {
    const active = db.prepare("SELECT COUNT(*) c FROM raw_set WHERE activity_id = ? AND set_type = 'active'").get(w.id).c;
    const lifted = db.prepare("SELECT COUNT(*) c FROM lift_set WHERE activity_id = ?").get(w.id).c;
    return { ...w, active, lifted, done: lifted > 0 };
  });
}

function workoutDetail(id) {
  const w = db.prepare("SELECT * FROM workout WHERE id = ?").get(id);
  if (!w) return null;
  const raw = rawSetsForWorkout(db, id).slice().sort((a, b) => a.set_idx - b.set_idx);
  const cur = new Map(
    db.prepare("SELECT set_idx, exercise FROM lift_set WHERE activity_id = ?").all(id).map((r) => [r.set_idx, r.exercise])
  );
  const note = db.prepare("SELECT text FROM workout_note WHERE note_date = ? ORDER BY received_at").all(w.date).map((n) => n.text);
  // Every raw set in order — active (a working set) and rest (the gap after it).
  const rows = raw.map((r) => r.set_type === "active"
    ? {
        type: "active", set_idx: r.set_idx,
        reps: r.reps, weight_lb: r.weight_kg > 0 ? kgToLb(r.weight_kg) : 0,
        guess: catGuess(r.watch_category),
        misfire: !(r.reps > 0) || !(r.weight_kg > 0),
        exercise: cur.get(r.set_idx) || "",
      }
    : {
        type: "rest", set_idx: r.set_idx,
        secs: r.duration_sec != null ? Math.round(r.duration_sec)
            : (r.rest_sec != null ? Math.round(r.rest_sec) : null),
      }
  );
  return { id, date: w.date, style: w.style || "", note, templates: getTemplates(db), rows };
}

function save({ id, style, sets }) {
  const w = db.prepare("SELECT * FROM workout WHERE id = ?").get(id);
  if (!w) throw new Error("no such workout");
  const map = getExerciseMap(db);
  const raw = new Map(rawSetsForWorkout(db, id).map((r) => [r.set_idx, r]));

  db.prepare("DELETE FROM lift_set WHERE activity_id = ?").run(id);
  db.prepare("DELETE FROM set_muscle WHERE activity_id = ?").run(id);
  const insL = db.prepare("INSERT INTO lift_set (activity_id, set_idx, exercise, reps, weight_lb, source, confidence) VALUES (?,?,?,?,?,'human',1.0)");
  const insM = db.prepare("INSERT INTO set_muscle (activity_id, set_idx, muscle, factor) VALUES (?,?,?,?)");

  let written = 0;
  const examples = [];
  for (const s of sets) {
    const r = raw.get(s.set_idx);
    if (!r) continue;
    const ex = (s.exercise || "").trim();
    if (!ex || ex === "skip") continue;
    if (!(r.reps > 0) || !(r.weight_kg > 0)) continue;   // misfire rule
    insL.run(id, s.set_idx, ex, r.reps, kgToLb(r.weight_kg));
    written++;
    for (const [muscle, factor] of (map[ex] || [])) insM.run(id, s.set_idx, muscle, factor);
    examples.push({ reps: r.reps, weight_lb: kgToLb(r.weight_kg), guess: catGuess(r.watch_category), exercise: ex });
  }
  db.prepare("UPDATE workout SET style = ?, interpreted_at = ? WHERE id = ?")
    .run(style || null, new Date().toISOString(), id);

  // append a labelled example row for later prompt tuning (best-effort)
  try {
    appendFileSync(CORRECTIONS, JSON.stringify({ activity_id: id, date: w.date, style: style || null, sets: examples }) + "\n");
  } catch { /* non-fatal */ }
  return { written };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && u.pathname === "/") { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return res.end(PAGE); }
    if (req.method === "GET" && u.pathname === "/api/workouts") return json(res, listWorkouts());
    if (req.method === "GET" && u.pathname === "/api/vocab") return json(res, Object.keys(getExerciseMap(db)).sort());
    if (req.method === "GET" && u.pathname.startsWith("/api/workout/")) {
      const d = workoutDetail(decodeURIComponent(u.pathname.split("/").pop()));
      return d ? json(res, d) : json(res, { error: "not found" }, 404);
    }
    if (req.method === "POST" && u.pathname === "/api/save") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { try { json(res, save(JSON.parse(body))); } catch (e) { json(res, { error: e.message }, 400); } });
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { json(res, { error: e.message }, 500); }
});

server.listen(PORT, HOST, () => {
  console.log(`strength augment tool → http://${HOST}:${PORT}`);
  console.log(`  db:          ${DB_PATH}`);
  console.log(`  corrections: ${CORRECTIONS}`);
  console.log("  Ctrl-C to stop.");
});

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Strength · augment</title>
<style>
  :root{--paper:#f9f6f3;--ink:#111;--body:#3d3b37;--muted:#8a8781;--rule:#d1cfcc;--over:#9c3a26;--safe:#4a6b47;--surface:#fff;--hover:#00000008;--sel:#00000012;--rest-bg:#00000005}
  :root[data-theme="dark"]{--paper:#1a1917;--ink:#f2efe9;--body:#cfccc4;--muted:#928d84;--rule:#3d3a32;--over:#e08063;--safe:#8cb37f;--surface:#232019;--hover:#ffffff10;--sel:#ffffff1e;--rest-bg:#ffffff08}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#1a1917;--ink:#f2efe9;--body:#cfccc4;--muted:#928d84;--rule:#3d3a32;--over:#e08063;--safe:#8cb37f;--surface:#232019;--hover:#ffffff10;--sel:#ffffff1e;--rest-bg:#ffffff08}}
  *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--body);font:15px/1.5 'Lora',Georgia,serif;display:flex;height:100vh}
  aside{width:280px;flex:none;border-right:1px solid var(--rule);overflow:auto;padding:16px}
  main{flex:1;overflow:auto;padding:24px 32px}
  h1{font-size:13px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink);margin:0 0 16px}
  .side-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
  .side-head h1{margin:0}
  .themebtn{border:1px solid var(--rule);background:var(--surface);color:var(--body);cursor:pointer;font-size:15px;line-height:1;padding:5px 9px;border-radius:5px}
  .themebtn:hover{background:var(--hover)}
  .wk{display:block;width:100%;text-align:left;border:0;background:none;font:inherit;color:var(--body);padding:10px 8px;border-bottom:1px solid var(--rule);cursor:pointer}
  .wk:hover{background:var(--hover)} .wk.sel{background:var(--sel)}
  .wk .d{font-size:16px;color:var(--ink)} .wk .m{font-size:12px;color:var(--muted);letter-spacing:.04em}
  .badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:0;margin-left:6px;letter-spacing:.06em}
  .badge.done{color:var(--safe);border:1px solid var(--safe)} .badge.todo{color:var(--over);border:1px solid var(--over)}
  h2{font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:34px;color:var(--ink);margin:0 0 4px}
  .sub{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:18px}
  table{border-collapse:collapse;width:auto} th{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);text-align:left;padding:5px 7px;border-bottom:1px solid var(--rule)}
  td{padding:5px 7px;border-bottom:1px solid var(--rule);vertical-align:middle}
  /* doubled gaps for weight|guess and guess|exercise (7→14 each side);
     reps|weight is tripled again on top of that (28→84) per request */
  th:nth-child(2),td:nth-child(2){padding-right:42px}
  th:nth-child(3),td:nth-child(3){padding-left:42px;padding-right:14px}
  th:nth-child(4),td:nth-child(4){padding-left:14px;padding-right:14px}
  th:nth-child(5),td:nth-child(5){padding-left:14px}
  tr.mis td{color:var(--muted);opacity:.55}
  tr.rest td{padding:2px 10px;font-size:12px;color:var(--muted);letter-spacing:.06em;background:var(--rest-bg);border-bottom:1px solid var(--rule)}
  table:not(.show-rest) tr.rest{display:none}
  .toggle{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer}
  .toggle input{cursor:pointer}
  .num{font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;color:var(--ink)}
  select{font:inherit;padding:5px 8px;border:1px solid var(--rule);background:var(--surface);color:var(--body);min-width:150px}
  select option{background:var(--surface);color:var(--body)}
  .combo{position:relative;width:164px}
  .combo-btn{display:flex;align-items:center;gap:6px;width:100%;font:inherit;text-align:left;padding:5px 8px;border:1px solid var(--rule);background:var(--surface);cursor:pointer;color:var(--body)}
  .combo-btn .ph{color:var(--muted)}
  .combo-btn span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .combo-btn .emo,.opt .emo{flex:none;display:inline-flex;align-items:center;width:40px;overflow:hidden;font-size:18px;line-height:1;letter-spacing:1px;white-space:nowrap}
  .combo-menu{display:none;position:absolute;z-index:9;top:calc(100% + 2px);left:0;min-width:250px;max-height:340px;overflow:auto;background:var(--surface);border:1px solid var(--rule);box-shadow:0 10px 30px #00000022;white-space:nowrap}
  .combo-menu.open{display:block}
  .opt{display:flex;align-items:center;gap:8px;padding:6px 9px;cursor:pointer}
  .opt:hover{background:var(--hover)} .opt.sel{background:var(--sel)}
  .grp{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);padding:9px 9px 3px;border-top:1px solid var(--rule)}
  .grp:first-child{border-top:0}
  .fill{border:1px solid var(--rule);background:none;cursor:pointer;padding:4px 8px;font:inherit;color:var(--muted)}
  .fill:hover{color:var(--ink)}
  .bar{position:sticky;top:0;background:var(--paper);padding:12px 0;display:flex;gap:14px;align-items:center;border-bottom:1px solid var(--rule);z-index:2}
  .styles select{min-width:150px}
  button.save{background:var(--ink);color:var(--paper);border:0;padding:10px 22px;font:inherit;cursor:pointer;letter-spacing:.04em}
  button.save:disabled{opacity:.5;cursor:default}
  .msg{color:var(--safe);font-size:13px} .err{color:var(--over)}
  .guess{font-size:12px;color:var(--muted)}
</style></head><body>
<aside><div class="side-head"><h1>Workouts</h1><button id="theme" class="themebtn" title="toggle light / dark">🌙</button></div><div id="list"></div></aside>
<main id="pane"><p style="color:var(--muted)">Select a workout on the left.</p></main>
<script>
let VOCAB=[], CUR=null, SHOWREST=true;
const el=(t,a={},...c)=>{const e=document.createElement(t);Object.assign(e,a);for(const x of c)e.append(x);return e};
let THEME=''; try{THEME=localStorage.getItem('strengthTheme')||'';}catch(e){}
function isDark(){ const t=document.documentElement.dataset.theme; return t==='dark' || (!t && matchMedia('(prefers-color-scheme:dark)').matches); }
function applyTheme(){ const r=document.documentElement; if(THEME) r.dataset.theme=THEME; else delete r.dataset.theme; const b=document.getElementById('theme'); if(b) b.textContent=isDark()?'☀️':'🌙'; }
async function boot(){
  applyTheme();
  const tb=document.getElementById('theme'); if(tb) tb.onclick=()=>{ THEME=isDark()?'light':'dark'; try{localStorage.setItem('strengthTheme',THEME);}catch(e){} applyTheme(); };
  VOCAB=await (await fetch('/api/vocab')).json(); renderList();
}
async function renderList(){
  const ws=await (await fetch('/api/workouts')).json();
  const list=document.getElementById('list'); list.innerHTML='';
  for(const w of ws){
    const b=el('button',{className:'wk'+(CUR===w.id?' sel':'')});
    b.append(el('div',{className:'d'},w.date));
    const m=el('div',{className:'m'},(w.style||'—')+' · '+w.active+' sets ');
    m.append(el('span',{className:'badge '+(w.done?'done':'todo')},w.done?('labelled '+w.lifted):'needs review'));
    b.append(m); b.onclick=()=>open(w.id); list.append(b);
  }
}
async function open(id){ CUR=id; renderList(); const d=await (await fetch('/api/workout/'+encodeURIComponent(id)).then(r=>r)).json(); render(d); }
// ── icons: one emoji for the obvious lifts, a distinct colored box for the
// ambiguous ones (no misleading picture). Ordering/menu logic below is unchanged.
const EX_ICON={
  back_squat:'🏋️',            // just the lifter (single)
  barbell_rdl:'🟩',            // colored box
  bulgarian_split_squat:'🟧',  // colored box
  db_incline_press:'🫸🔔',
  hammer_curl:'🟪',            // colored box
  lat_pulldown_supinated:'🟥', // colored box (distinct from wide)
  lat_pulldown_wide:'🟨',      // colored box (distinct from supinated)
  machine_chest_press:'🫸⚙️',
  machine_row_wide:'🚣',       // single rowing
  machine_triceps_pushdown:'👇⚙️',
  preacher_curl:'🟦',          // colored box
  rope_curl:'💪🔗',
  rope_overhead_extension:'🙆🔗',
  rope_triceps_pushdown:'👇🔗',
  seated_ohp:'⬆️🏋️',
  side_delt_raise:'↔️',
};
const icons=(k)=>{ const e=EX_ICON[k]; return e?'<span class="emo">'+e+'</span>':''; };
const label=(k)=>k?k.replace(/_/g,' ').replace(/\\b\\w/g,c=>c.toUpperCase()):'';
function opt(v,sel){ return el('option',{value:v,selected:v===sel},v||'—'); }  // still used by the Style <select>

// MRU: last-picked exercises float to the top of every dropdown; persists.
let RECENT=[]; try{RECENT=JSON.parse(localStorage.getItem('strengthMRU')||'[]');}catch(e){RECENT=[];}
function bumpRecent(ex){ if(!VOCAB.includes(ex))return; RECENT=[ex,...RECENT.filter(x=>x!==ex)].slice(0,8); try{localStorage.setItem('strengthMRU',JSON.stringify(RECENT));}catch(e){} }

function closeMenus(){ for(const m of document.querySelectorAll('.combo-menu.open')) m.classList.remove('open'); }
document.addEventListener('click',closeMenus);
function makeCombo(idx,current){
  const c=el('div',{className:'combo'}); c.dataset.idx=idx; c.dataset.value=current||'';
  const btn=el('button',{type:'button',className:'combo-btn'});
  const menu=el('div',{className:'combo-menu'});
  const paint=()=>{ const v=c.dataset.value; btn.innerHTML = v ? icons(v)+'<span>'+(label(v)||v)+'</span>' : '<span class="ph">— choose —</span>'; btn.title = v ? (label(v)||v) : ''; };
  const set=(v)=>{ c.dataset.value=v||''; paint(); bumpRecent(v); menu.classList.remove('open'); };
  c._set=set;
  const buildMenu=()=>{
    menu.innerHTML='';
    const add=(v,txt,ic)=>{ const o=el('div',{className:'opt'+(v===c.dataset.value?' sel':'')}); o.innerHTML=(ic||'')+'<span>'+txt+'</span>'; o.onclick=(e)=>{e.stopPropagation();set(v);}; menu.append(o); };
    add('','— clear —','');
    const rec=RECENT.filter(x=>VOCAB.includes(x));
    if(rec.length){ menu.append(el('div',{className:'grp'},'recent')); for(const v of rec) add(v,label(v),icons(v)); }
    add('unknown','unknown',''); add('skip','skip','');
    menu.append(el('div',{className:'grp'},'all exercises'));
    for(const v of VOCAB.filter(x=>!rec.includes(x))) add(v,label(v),icons(v));
  };
  btn.onclick=(e)=>{ e.stopPropagation(); const openNow=!menu.classList.contains('open'); closeMenus(); if(openNow){ buildMenu(); menu.classList.add('open'); } };
  c.append(btn,menu); paint();
  return c;
}
function render(d){
  const pane=document.getElementById('pane'); pane.innerHTML='';
  const tbl=el('table',{className:SHOWREST?'show-rest':''});
  const bar=el('div',{className:'bar'});
  const styles=el('div',{className:'styles'}); styles.append(el('span',{className:'sub',style:'margin:0 8px 0 0'},'Style'));
  const ssel=el('select',{id:'style'}); for(const s of ['','leg','arms','chest_back','other']) ssel.append(opt(s,d.style)); styles.append(ssel);
  const tog=el('label',{className:'toggle'});
  const cb=el('input',{type:'checkbox',checked:SHOWREST});
  cb.onchange=()=>{SHOWREST=cb.checked; tbl.classList.toggle('show-rest',SHOWREST);};
  tog.append(cb, el('span',{},'show rest periods'));
  const save=el('button',{className:'save',textContent:'Save workout'}); save.onclick=()=>doSave(d.id,ssel);
  const msg=el('span',{className:'msg',id:'msg'});
  bar.append(styles,tog,save,msg); pane.append(bar);
  pane.append(el('h2',{},d.date));
  pane.append(el('div',{className:'sub'},'raw Garmin sets · pick the exercise for each'));
  if(d.note&&d.note.length) pane.append(el('div',{className:'sub'},'note: '+d.note.join(' / ')));
  const head=el('tr');
  for(const h of ['Set number','Reps','Weight','Watch guess','Exercise','']) head.append(el('th',{},h)); tbl.append(head);
  for(const s of d.rows){
    if(s.type==='rest'){
      const tr=el('tr',{className:'rest'});
      tr.append(el('td',{},String(s.set_idx)));
      tr.append(el('td',{colSpan:5},'rest'+(s.secs!=null?' · '+s.secs+' s':'')));
      tbl.append(tr); continue;
    }
    const tr=el('tr',{className:s.misfire?'mis':''});
    tr.append(el('td',{className:'num'},String(s.set_idx)));
    tr.append(el('td',{className:'num'},String(s.reps)));
    tr.append(el('td',{className:'num'},s.weight_lb+' lb'));
    tr.append(el('td',{className:'guess'},s.guess.join(', ')||'—'));
    if(s.misfire){
      tr.append(el('td',{},el('span',{className:'guess'},'misfire — skipped')));
      tr.append(el('td',{}));
    } else {
      const combo=makeCombo(s.set_idx,s.exercise);
      tr.append(el('td',{},combo));
      const fill=el('button',{className:'fill',textContent:'↓ fill',title:'copy to following blanks'});
      fill.onclick=()=>{const v=combo.dataset.value;let go=false;for(const c of tbl.querySelectorAll('.combo')){if(c===combo){go=true;continue}if(go)c._set(v);}};
      tr.append(el('td',{},fill));
    }
    tbl.append(tr);
  }
  pane.append(tbl);
}
async function doSave(id,ssel){
  const sets=[...document.querySelectorAll('.combo')].map(c=>({set_idx:Number(c.dataset.idx),exercise:c.dataset.value}));
  const msg=document.getElementById('msg'); msg.className='msg'; msg.textContent='saving…';
  const r=await (await fetch('/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,style:ssel.value,sets})})).json();
  if(r.error){msg.className='msg err';msg.textContent='error: '+r.error;} else {msg.textContent='saved — '+r.written+' sets written';renderList();}
}
boot();
</script></body></html>`;
