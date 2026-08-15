
// ============================================================
// 牛角门·忆 —— 自建记忆扩展（顺带记录 + 延迟入账 + 实体检索）
// ============================================================
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const MOD = 'niujiaomen_yi';
const INJ_KEY = 'niujiaomen_yi_inject';

const DEFAULT_INSTR =
`【记忆输出要求】在你回复的最末尾（所有组件之后）另起一行，输出本回合的记忆块，格式严格如下：
<记忆>
事#回合号[涉及的人物或物件|可多个]一句事实：谁做了什么，结果是什么
波#回合号[角色名]表面做了什么；水面下其实是什么（一次性事件，禁止"他是个……的人"式结论）
账[角色名]该角色自己视角新增的"我记得/我以为"（允许与事实不符）
卡[人物|关系|进行中|身体 四选一]该栏的最新完整内容（仅在发生变化时输出）
</记忆>
规则：只记本回合真实发生的；每类0到3行，没有就不写该行；完全无新内容则输出 <记忆>无</记忆>。
此块不属于正文，不算入字数。当前回合号：{{turn}}`;

function settings(){
  if(!extension_settings[MOD]) extension_settings[MOD] = {};
  const s = extension_settings[MOD];
  if(s.enabled===undefined) s.enabled = true;
  if(s.depth===undefined) s.depth = 3;
  if(s.budget===undefined) s.budget = 1800;
  if(s.instr===undefined) s.instr = DEFAULT_INSTR;
  return s;
}

// ---------------- 存储：单一权威副本（聊天元数据） ----------------
function meta(){
  const ctx = getContext();
  const m = ctx.chatMetadata ?? ctx.chat_metadata;
  if(!m) return null;
  if(!m[MOD]) m[MOD] = { v:1, seq:1, lastMark:0,
    hc:{人物:'',关系:'',进行中:'',身体:''},
    events:[], waves:[], minds:{}, early:'' };
  const st = m[MOD];
  if(!st.hc) st.hc = {人物:'',关系:'',进行中:'',身体:''};
  ['events','waves'].forEach(k=>{ if(!Array.isArray(st[k])) st[k]=[]; });
  if(!st.minds) st.minds = {};
  if(st.early===undefined) st.early='';
  return st;
}
function saveMeta(){
  const ctx = getContext();
  (ctx.saveMetadataDebounced ?? ctx.saveMetadata ?? (()=>{}))();
}

// ---------------- 解析与序列化（同一套行文法） ----------------
function parseLines(text, st, {replace=false}={}){
  const out = replace ? { hc:{人物:'',关系:'',进行中:'',身体:''}, events:[], waves:[], minds:{}, early:'' }
                      : st;
  let n = 0;
  for(let raw of String(text).split('\n')){
    const line = raw.trim();
    if(!line || line==='无') continue;
    let m;
    if((m = line.match(/^事\s*#?(\d+)\s*\[([^\]]*)\]\s*(.+)$/))){
      const t=+m[1], ents=m[2].split(/[|｜、,，]/).map(s=>s.trim()).filter(Boolean), tx=m[3].trim();
      if(!out.events.some(e=>e.text===tx)){ out.events.push({id:st.seq++, turn:t, ents, text:tx}); n++; }
    } else if((m = line.match(/^波\s*#?(\d+)\s*\[([^\]]*)\]\s*(.+)$/))){
      const t=+m[1], who=m[2].trim(), tx=m[3].trim();
      if(!out.waves.some(e=>e.text===tx&&e.who===who)){ out.waves.push({id:st.seq++, turn:t, who, text:tx}); n++; }
    } else if((m = line.match(/^账\s*\[([^\]]*)\]\s*(.+)$/))){
      const who=m[1].trim(), tx=m[2].trim();
      if(!out.minds[who]) out.minds[who]=[];
      if(!out.minds[who].some(e=>e.text===tx)){ out.minds[who].push({id:st.seq++, text:tx}); n++; }
    } else if((m = line.match(/^卡\s*\[(人物|关系|进行中|身体)\]\s*(.*)$/))){
      out.hc[m[1]] = m[2].trim(); n++;
    } else if((m = line.match(/^早\s*(.+)$/))){
      out.early = (replace? '' : out.early) + m[1].trim(); n++;
    }
  }
  if(replace){ st.hc=out.hc; st.events=out.events; st.waves=out.waves; st.minds=out.minds; st.early=out.early; }
  return n;
}
function prune(st){
  const MAXE=40, MAXW=24, MAXM=10, MAXEARLY=900;
  while(st.events.length>MAXE){ const e=st.events.shift(); st.early += `(#${e.turn})${e.text}；`; }
  while(st.waves.length>MAXW){ const w=st.waves.shift(); st.early += `(#${w.turn}${w.who})${w.text}；`; }
  for(const k of Object.keys(st.minds)) while(st.minds[k].length>MAXM) st.minds[k].shift();
  if(st.early.length>MAXEARLY) st.early = '…'+st.early.slice(st.early.length-MAXEARLY);
}
function serialize(st){
  const L=[];
  for(const k of ['人物','关系','进行中','身体']) if(st.hc[k]) L.push(`卡[${k}]${st.hc[k]}`);
  if(st.early) L.push(`早 ${st.early}`);
  for(const e of st.events) L.push(`事#${e.turn}[${e.ents.join('|')}]${e.text}`);
  for(const w of st.waves) L.push(`波#${w.turn}[${w.who}]${w.text}`);
  for(const [who,arr] of Object.entries(st.minds)) for(const e of arr) L.push(`账[${who}]${e.text}`);
  return L.join('\n');
}

// ---------------- 注入：硬卡常驻 + 实体检索 + 输出指令 ----------------
function recentText(chat, n=4){
  let t='';
  for(let i=chat.length-1, c=0; i>=0 && c<n; i--){
    const m=chat[i]; if(!m || m.is_system) continue;
    t += (m.mes||'')+'\n'; c++;
  }
  return t;
}
function buildInjection(){
  const s = settings();
  const ctx = getContext();
  const st = meta();
  const chat = ctx.chat || [];
  if(!st) return '';
  const lastId = chat.length-1;
  let out = '【既往档案·以下为既成事实，不得违背】\n';
  for(const k of ['人物','关系','进行中','身体']) if(st.hc[k]) out += `■${k}：${st.hc[k]}\n`;
  const recent = recentText(chat);
  const picked = [];
  for(const e of st.events){
    const fresh = (lastId - e.turn) <= 6;
    const hit = e.ents.some(x=> x && recent.includes(x));
    if(fresh || hit) picked.push(e);
  }
  const evShow = picked.slice(-14);
  if(evShow.length){ out += '■相关既往：\n' + evShow.map(e=>`- (#${e.turn}) ${e.text}`).join('\n') + '\n'; }
  const wvShow = st.waves.filter(w=> (lastId-w.turn)<=8 || recent.includes(w.who)).slice(-6);
  if(wvShow.length){ out += '■内心波澜（写作参考，角色互不知晓）：\n' + wvShow.map(w=>`- (#${w.turn} ${w.who}) ${w.text}`).join('\n') + '\n'; }
  const mindLines=[];
  for(const [who,arr] of Object.entries(st.minds)){
    if(!recent.includes(who)) continue;
    for(const e of arr.slice(-3)) mindLines.push(`- ${who}：${e.text}`);
  }
  if(mindLines.length){ out += '■各角色自己所相信的（可以与事实不符）：\n' + mindLines.join('\n') + '\n'; }
  if(out.length > s.budget) out = out.slice(0, s.budget) + '…';
  out += '\n' + s.instr.replace(/\{\{turn\}\}/g, String(lastId+1));
  return out;
}
function applyInjection(){
  const s = settings();
  const ctx = getContext();
  try{
    const val = s.enabled ? buildInjection() : '';
    // setExtensionPrompt(key, value, position(1=IN_CHAT), depth, scan, role(0=system))
    ctx.setExtensionPrompt(INJ_KEY, val, 1, s.depth, false, 0);
  }catch(e){ console.error('[忆] 注入失败', e); }
}

// ---------------- 顺带记录：收块（收到AI回复时剥离暂存） ----------------
const BLOCK_RE = /<记忆>([\s\S]*?)<\/记忆>\s*/g;
function harvest(mesId){
  const ctx = getContext();
  const chat = ctx.chat || [];
  const m = chat[mesId] ?? chat[chat.length-1];
  if(!m || m.is_user || m.is_system) return;
  const text = m.mes || '';
  let memo = null, match, re = new RegExp(BLOCK_RE.source,'g');
  while((match = re.exec(text)) !== null) memo = match[1];
  if(memo === null) return;
  m.mes = text.replace(new RegExp(BLOCK_RE.source,'g'), '').trimEnd();
  if(!m.extra) m.extra = {};
  m.extra.yiMemo = memo.trim();
  m.extra.yiDone = false;
  try{ ctx.saveChat?.(); }catch(e){}
  try{ ctx.updateMessageBlock?.(mesId, m); }catch(e){}
  refreshPanel();
}

// ---------------- 延迟入账：你发送下一条时才真正写入（swipe 免疫） ----------------
function commitPending(){
  const ctx = getContext();
  const st = meta(); if(!st) return;
  const chat = ctx.chat || [];
  for(let i=chat.length-1; i>=0; i--){
    const m = chat[i];
    if(!m || m.is_user || m.is_system) continue;
    if(m.extra && m.extra.yiMemo && !m.extra.yiDone){
      const n = parseLines(m.extra.yiMemo, st);
      m.extra.yiDone = true;
      prune(st); saveMeta();
      try{ ctx.saveChat?.(); }catch(e){}
      if(n>0) toastr.info(`忆：入账 ${n} 条`);
    }
    break; // 只看最后一条AI消息
  }
  applyInjection(); refreshPanel();
}

// ---------------- 重构（一次调用）与 总结并隐藏 ----------------
async function quietGen(prompt){
  const ctx = getContext();
  const fn = ctx.generateQuietPrompt;
  if(!fn) throw new Error('generateQuietPrompt 不可用');
  try{ return await fn({ quietPrompt: prompt }); }
  catch(e){ return await fn(prompt, false, false); }
}
async function rebuild(){
  const ctx = getContext(); const st = meta(); if(!st) return;
  toastr.info('忆：重构中，请稍候…');
  const dump = serialize(st) || '（档案为空）';
  const prompt =
`你是本聊天的记忆员。结合当前可见的对话与下方旧档案，重写一份完整档案，输出在 <忆全量> 与 </忆全量> 之间。
行文法（每行一条）：
卡[人物]…／卡[关系]…／卡[进行中]…／卡[身体]…（四行都要，各≤120字）
早 早期已不影响当前剧情的内容压成的一段概述（≤300字）
事#回合号[实体|实体]一句事实（按回合排序；合并重复；矛盾以更晚的为准；保留≤30条）
波#回合号[角色]表面…；水面下…（保留最近与最重的，≤15条；禁无回合戳的性格结论）
账[角色]该角色仍然相信的东西，包括错的（每人≤6条）
只输出 <忆全量>…</忆全量>，不加说明。
【旧档案】
${dump}`;
  try{
    const res = await quietGen(prompt);
    const m = String(res||'').match(/<忆全量>([\s\S]*?)<\/忆全量>/);
    if(!m){ toastr.error('忆：重构输出无法解析，档案未改动'); return; }
    parseLines(m[1], st, {replace:true});
    prune(st);
    st.lastMark = (ctx.chat||[]).length-1;
    saveMeta(); applyInjection(); refreshPanel();
    toastr.success(`忆：重构完成，已记到第 ${st.lastMark} 回合`);
  }catch(e){ console.error(e); toastr.error('忆：重构失败 '+e.message); }
}
async function rebuildAndHide(){
  const ctx = getContext(); const st = meta(); if(!st) return;
  const last = (ctx.chat||[]).length-1;
  if(!confirm(`先重构档案（花1次调用），然后隐藏 1-${Math.max(1,last-2)} 楼（保留开场白与最近2条）。继续？`)) return;
  await rebuild();
  const upTo = Math.max(1, last-2);
  try{
    const ex = ctx.executeSlashCommandsWithOptions ?? ctx.executeSlashCommands;
    await ex(`/hide 1-${upTo}`);
    toastr.success(`忆：已隐藏 1-${upTo}`);
  }catch(e){ toastr.warning(`自动隐藏失败，请手动 /hide 1-${upTo}`); }
}

// ---------------- 面板 UI ----------------
function panelHtml(){
  return `
  <div class="yi_stat" id="yi_stat"></div>
  <div class="yi_row">
    <div class="menu_button" id="yi_btn_rebuild" title="旧档案+可见对话→重写整份（花1次调用）">重构</div>
    <div class="menu_button" id="yi_btn_rebuildhide" title="重构后自动隐藏旧楼层">总结并隐藏</div>
    <div class="menu_button" id="yi_btn_refresh">刷新</div>
    <div class="menu_button" id="yi_btn_save">保存修改</div>
  </div>
  <h4>档案（可直接编辑，行文法：卡[..] 早 事#..[..] 波#..[..] 账[..]）</h4>
  <textarea id="yi_dump" spellcheck="false"></textarea>
  <h4>设置</h4>
  <div class="yi_row">
    <label><input type="checkbox" id="yi_enabled">启用注入</label>
    <label>深度 <input type="number" id="yi_depth" min="0" max="20"></label>
    <label>预算(字) <input type="number" id="yi_budget" min="400" max="6000" step="100"></label>
  </div>
  <h4>抽取指令（模型据此在回复末尾输出记忆块）</h4>
  <textarea id="yi_instr" class="yi_small" spellcheck="false"></textarea>
  <div class="yi_row"><div class="menu_button" id="yi_btn_instr_save">保存指令</div>
  <div class="menu_button" id="yi_btn_instr_reset">恢复默认</div></div>`;
}
function refreshPanel(){
  const st = meta(); if(!st) return;
  const ctx = getContext();
  const last = (ctx.chat||[]).length-1;
  const el = document.getElementById('yi_stat');
  if(el) el.textContent = `当前第 ${last} 楼｜上次重构记到第 ${st.lastMark} 楼｜事${st.events.length} 波${st.waves.length} 账${Object.values(st.minds).reduce((a,b)=>a+b.length,0)}`;
  const d = document.getElementById('yi_dump');
  if(d && document.activeElement!==d) d.value = serialize(st);
}
function mountUI(){
  if(document.getElementById('yi_top_button')) return;
  const holder = document.getElementById('top-settings-holder');
  if(!holder) return;
  const iconId = document.getElementById('table_drawer_icon') ? 'yi_drawer_icon' : 'table_drawer_icon';
  const wrap = document.createElement('div');
  wrap.id = 'yi_top_button';
  wrap.className = 'drawer';
  wrap.innerHTML = `
    <div class="drawer-toggle">
      <div id="${iconId}" class="drawer-icon fa-solid fa-book closedIcon interactable" title="牛角门·忆" tabindex="0"></div>
    </div>
    <div id="yi_panel" class="drawer-content closedDrawer">${panelHtml()}</div>`;
  // 插到「角」(rightNav) 之前，避免挤出屏幕
  const rightIcon = document.getElementById('rightNavDrawerIcon');
  const rightDrawer = rightIcon ? rightIcon.closest('.drawer') || rightIcon.parentElement : null;
  if(rightDrawer && rightDrawer.parentElement === holder) holder.insertBefore(wrap, rightDrawer);
  else holder.appendChild(wrap);
  const icon = wrap.querySelector('.drawer-icon');
  const panel = wrap.querySelector('#yi_panel');
  icon.addEventListener('click', ()=>{
    const open = panel.classList.contains('openDrawer');
    panel.classList.toggle('openDrawer', !open);
    panel.classList.toggle('closedDrawer', open);
    icon.classList.toggle('openIcon', !open);
    icon.classList.toggle('closedIcon', open);
    if(!open) refreshPanel();
  });
  const s = settings();
  panel.querySelector('#yi_enabled').checked = s.enabled;
  panel.querySelector('#yi_depth').value = s.depth;
  panel.querySelector('#yi_budget').value = s.budget;
  panel.querySelector('#yi_instr').value = s.instr;
  panel.querySelector('#yi_enabled').addEventListener('change', e=>{ s.enabled=e.target.checked; saveSettingsDebounced(); applyInjection(); });
  panel.querySelector('#yi_depth').addEventListener('change', e=>{ s.depth=+e.target.value||3; saveSettingsDebounced(); applyInjection(); });
  panel.querySelector('#yi_budget').addEventListener('change', e=>{ s.budget=+e.target.value||1800; saveSettingsDebounced(); applyInjection(); });
  panel.querySelector('#yi_btn_instr_save').addEventListener('click', ()=>{ s.instr=panel.querySelector('#yi_instr').value; saveSettingsDebounced(); applyInjection(); toastr.success('忆：指令已保存'); });
  panel.querySelector('#yi_btn_instr_reset').addEventListener('click', ()=>{ s.instr=DEFAULT_INSTR; panel.querySelector('#yi_instr').value=s.instr; saveSettingsDebounced(); applyInjection(); });
  panel.querySelector('#yi_btn_refresh').addEventListener('click', refreshPanel);
  panel.querySelector('#yi_btn_save').addEventListener('click', ()=>{
    const st = meta(); if(!st) return;
    parseLines(panel.querySelector('#yi_dump').value, st, {replace:true});
    prune(st); saveMeta(); applyInjection(); refreshPanel();
    toastr.success('忆：档案已保存');
  });
  panel.querySelector('#yi_btn_rebuild').addEventListener('click', rebuild);
  panel.querySelector('#yi_btn_rebuildhide').addEventListener('click', rebuildAndHide);
}

// ---------------- 事件接线 ----------------
function onReceived(mesId){ harvest(typeof mesId==='number'?mesId:undefined); applyInjection(); }
function onSent(){ commitPending(); }
function onChanged(){ applyInjection(); refreshPanel(); }
function onSwiped(mesId){ harvest(typeof mesId==='number'?mesId:undefined); }
function onEdited(mesId){ harvest(typeof mesId==='number'?mesId:undefined); }

jQuery(async () => {
  try{
    mountUI();
    applyInjection();
    eventSource.on(event_types.MESSAGE_RECEIVED, onReceived);
    eventSource.on(event_types.MESSAGE_SENT, onSent);
    eventSource.on(event_types.CHAT_CHANGED, onChanged);
    if(event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onSwiped);
    if(event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onEdited);
    console.log('[牛角门·忆] 已加载');
  }catch(e){ console.error('[牛角门·忆] 加载失败', e); }
});
