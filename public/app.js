const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const glyph = {S:'♠',H:'♥',C:'♣',D:'♦'};
const rankLabel = rank => String(rank);
const cardName = card => `${{S:'黑桃',H:'红桃',C:'梅花',D:'方块'}[card.suit]}${rankLabel(card.rank)}`;
const state = {
  session:null, view:null, form:'home', selected:null, selectedKey:null,
  network:'idle', pendingAction:null, reconciling:false,
  busy:false, toastTimeout:null, dragged:null, touchDrag:null,
  effectActive:null, queuedSnapshot:null, waitingUntil:0, lastEffectKey:null,
  dialog:null, dialogKey:null, sceneMode:null,
  preferences:{sound:localStorage.getItem('turtle-sound')!=='off',reduceMotion:localStorage.getItem('turtle-reduce-motion')==='on'}
};
const h = (str='') => String(str).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const getName = () => localStorage.getItem('turtle-name') || '玩家';
const nameInput = () => `<label class="field"><span>你的昵称</span><input name="name" value="${h(getName())}" required maxlength="16" autocomplete="nickname" placeholder="请输入昵称"></label>`;
const getPlayer = (id) => state.view?.players.find(p=>p.id===id);
const myPlayer = () => getPlayer(state.view?.myId);
const isHost = () => state.view?.ownerId === state.view?.myId;
const showingDraw = () => Boolean(state.effectActive) || Date.now()<(state.view?.animationUntil||0);
const myTurn = () => state.view?.phase==='playing' && state.view.currentPlayerId===state.view.myId && !showingDraw();
const isLocked = () => state.view?.targetPlayerId===state.view?.myId || showingDraw();
const introTop = (back=false) => `<header class="topbar">
  <div class="brand"><span class="brand-symbol">龟</span><span>抽乌龟</span></div>
  <div class="top-right">${back?'<button class="text-btn" data-ui="home">← 返回首页</button>':'<span>轻松一抽 · 好运别走</span>'}<span class="pill">公开亮牌 · 心理博弈</span></div>
</header>`;
function notice(message) {
  toastEl.textContent=message;toastEl.classList.add('visible');
  clearTimeout(state.toastTimeout);state.toastTimeout=setTimeout(()=>toastEl.classList.remove('visible'),2600);
}
const connection = {
  generation:0, controller:null, retryTimer:null, pollTimer:null, heartbeatTimer:null,
  retries:0, lastPulse:0, fetchingState:false
};
function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function tokenHeaders() {return state.session?{Authorization:`Bearer ${state.session.token}`}:{}}
function connectionLabel() {
  return {idle:'等待连接',connecting:'连接中…',connected:'实时联机',reconnecting:'重新连接…',
    fallback:'弱网 · 同步中',offline:'网络离线'}[state.network] || '连接中…';
}
function setNetworkStatus(value) {
  if(state.network===value)return;
  state.network=value;
  const tag=document.querySelector('#connection-tag');
  if(tag){tag.textContent=connectionLabel();tag.dataset.status=value;}
  const banner=document.querySelector('#network-banner');
  if(banner){banner.hidden=['connected','idle'].includes(value);banner.textContent=
    value==='offline'?'网络已断开，保留座位和手牌；恢复联网后自动同步。':
    '连接不稳定，正在自动重连并核对最新回合，请勿重复操作。';}
}
async function fetchWithTimeout(path,options={},timeout=12000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try {return await fetch(path,{...options,signal:controller.signal,cache:'no-store'});}
  catch(err) {
    const networkError=new Error('网络暂不可用，正在尝试重新连接');
    networkError.network=true;throw networkError;
  }finally{clearTimeout(timer);}
}
async function request(path,data,authorized=false) {
  const res=await fetchWithTimeout(path,{method:'POST',headers:{'Content-Type':'application/json',
    ...(authorized?tokenHeaders():{})},body:JSON.stringify(data)});
  let out;try{out=await res.json();}catch{throw new Error('服务器返回了无效响应');}
  if(!res.ok){const e=new Error(out.error||'操作失败');e.status=res.status;throw e;}
  return out;
}
function stopConnection() {
  connection.generation++;
  connection.controller?.abort();connection.controller=null;
  clearTimeout(connection.retryTimer);clearInterval(connection.pollTimer);
  clearInterval(connection.heartbeatTimer);
  connection.retryTimer=null;connection.pollTimer=null;connection.heartbeatTimer=null;
  connection.retries=0;
}
function activeSession(session) {
  stopConnection();
  state.session=session;state.form='home';state.dialog=null;state.selected=null;state.view=null;
  state.lastEffectKey=null;state.effectActive=null;state.queuedSnapshot=null;state.pendingAction=null;
  localStorage.setItem('turtle-session',JSON.stringify(session));
  render();
  connect();
}
function clearSession() {
  stopConnection();
  state.session=null;state.view=null;state.selected=null;state.effectActive=null;state.dialog=null;
  state.queuedSnapshot=null;state.waitingUntil=0;
  state.pendingAction=null;
  document.querySelectorAll('.draw-effect,.pair-effect,.deal-effect,.deal-flight').forEach(el=>el.remove());
  localStorage.removeItem('turtle-session');
  setNetworkStatus('idle');
}
function invalidSession() {
  clearSession();state.form='home';render();
  notice('原会话已失效或房间已关闭，请重新进入房间');
}
async function fetchState() {
  if(!state.session || connection.fetchingState)return;
  connection.fetchingState=true;
  const generation=connection.generation;
  const {code}=state.session;
  try {
    const response=await fetchWithTimeout(`/api/rooms/${code}/state`,{headers:tokenHeaders()});
    if(generation!==connection.generation)return;
    if([401,403,404].includes(response.status)){invalidSession();return;}
    if(!response.ok)throw new Error('状态同步失败');
    applySnapshot(await response.json());
    if(state.network==='offline')setNetworkStatus('fallback');
    void reconcilePending();
  }catch(err) {
    if(generation===connection.generation && err.network && state.network!=='reconnecting')
      setNetworkStatus(navigator.onLine===false?'offline':'fallback');
  }finally{connection.fetchingState=false;}
}
async function recover() {
  let stored;try{stored=JSON.parse(localStorage.getItem('turtle-session')||'null');}catch{}
  if(!stored?.code||!stored?.token)return;
  state.session=stored;
  setNetworkStatus('connecting');
  render();
  // Network failure must never discard the credential: it enables recovery after
  // a temporary outage or process restart.
  await fetchState();
  if(state.session)connect();
}
function applySnapshot(next) {
  if(!next || typeof next.revision!=='number')return;
  if(next.code!==state.session?.code)return;
  if(state.effectActive) {
    if(next.revision>state.effectActive.next.revision &&
      (!state.queuedSnapshot||next.revision>state.queuedSnapshot.revision))state.queuedSnapshot=next;
    return;
  }
  if(state.view && next.revision<=state.view.revision)return;
  const previous=state.view;
  if((previous?next.round>previous.round:next.lastAction?.deal?.until>Date.now()) && next.lastAction?.deal?.duration>0) {
    const effect={type:'deal',next,previous};
    state.effectActive=effect;state.waitingUntil=next.animationUntil||0;
    state.view={...next,myHand:[],pairs:[],escaped:[],players:next.players.map(p=>({...p,count:0,escaped:false}))};
    render();
    void playDealEffect(effect).catch(error=>console.warn('发牌动画中断',error)).finally(()=>finishEffect(effect));
    return;
  }
  const action=next.lastAction?.kind==='finished'?next.lastAction.finalDraw:next.lastAction;
  const effectKey=`${next.round}:${action?.id}`;
  const animate=previous?.phase==='playing' && previous.round===next.round &&
    action && ['draw','shuffle'].includes(action.kind) &&
    previous.lastAction?.id!==next.lastAction?.id && state.lastEffectKey!==effectKey;
  const key=`${next.round}:${next.turn}:${next.targetPlayerId}`;
  if(state.selectedKey!==key){state.selected=null;state.selectedKey=key;}
  state.selected=next.selection?.actorId===next.myId?next.selection.slot:null;
  if(movingTouch?.active) {
    const handChanged=(previous?.myHand||[]).map(card=>card.id).join(',')!==
      (next.myHand||[]).map(card=>card.id).join(',');
    if(handChanged||next.targetPlayerId===next.myId||next.phase!==previous?.phase)cancelTouchDrag();
    else{state.view=next;updateCountdown();return;}
  }
  state.waitingUntil=next.animationUntil||0;
  if(animate && action.kind==='draw' && action.card) {
    const origin=app.querySelector(previous.myId===action.targetId
      ? `.hand-scroll [data-own-card="${action.slot}"]`
      : `.target-list [data-slot="${action.slot}"]`)?.getBoundingClientRect();
    const effect={next,previous,action};
    state.lastEffectKey=effectKey;state.effectActive=effect;
    render();
    void playDrawEffect(effect,origin).catch(error=>console.warn('抽牌动画中断，已同步最新牌桌',error)).finally(()=>finishEffect(effect));
    return;
  }
  state.view=next;render();
  if(animate && action.kind==='shuffle') {
    state.lastEffectKey=effectKey;playShuffleEffect(action,next);
  }
}
function parseSseChunk(packet) {
  const type=packet.split('\n').find(row=>row.startsWith('event:'))?.slice(6).trim();
  if(type!=='state')return;
  const data=packet.split('\n').filter(row=>row.startsWith('data:')).map(row=>row.slice(5).trimStart()).join('\n');
  try{applySnapshot(JSON.parse(data));}catch(err){console.warn('状态数据解析失败',err);}
}
function finishEffect(effect) {
  if(state.effectActive!==effect)return;
  state.effectActive=null;state.view=effect.next;render();
  const queued=state.queuedSnapshot;state.queuedSnapshot=null;
  if(queued)applySnapshot(queued);
}
function startPolling(generation) {
  if(connection.pollTimer)return;
  connection.pollTimer=setInterval(()=>{
    if(generation===connection.generation)void fetchState();
  },4000);
  void fetchState();
}
function stopPolling() {
  clearInterval(connection.pollTimer);connection.pollTimer=null;
}
function scheduleReconnect(generation) {
  if(generation!==connection.generation||!state.session)return;
  connection.retries++;
  const offline=typeof navigator!=='undefined' && navigator.onLine===false;
  setNetworkStatus(offline?'offline':connection.retries>=2?'fallback':'reconnecting');
  if(connection.retries>=2)startPolling(generation);
  const backoff=Math.min(12000,600*Math.pow(1.8,Math.min(connection.retries,8)));
  const delay=offline?2500:backoff+Math.random()*400;
  clearTimeout(connection.retryTimer);
  connection.retryTimer=setTimeout(()=>void stream(generation),delay);
}
async function stream(generation) {
  if(generation!==connection.generation||!state.session)return;
  const controller=new AbortController();connection.controller=controller;
  const {code}=state.session;
  if(connection.retries===0)setNetworkStatus('connecting');
  let reader=null;
  try {
    const response=await fetch(`/api/rooms/${code}/events`,{
      headers:{...tokenHeaders(),Accept:'text/event-stream'},cache:'no-store',signal:controller.signal
    });
    if(generation!==connection.generation)return;
    if([401,403,404].includes(response.status)){invalidSession();return;}
    if(!response.ok||!response.body)throw new Error(`实时连接错误：${response.status}`);
    setNetworkStatus('connected');connection.retries=0;
    connection.lastPulse=Date.now();stopPolling();
    void reconcilePending();
    reader=response.body.getReader();
    const decoder=new TextDecoder();let buffer='';
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      if(generation!==connection.generation)return;
      connection.lastPulse=Date.now();
      buffer+=decoder.decode(value,{stream:true});
      if(buffer.length>1024*1024)throw new Error('状态流数据过大');
      buffer=buffer.replace(/\r\n/g,'\n');
      let cut;
      while((cut=buffer.indexOf('\n\n'))>=0) {
        const packet=buffer.slice(0,cut);buffer=buffer.slice(cut+2);
        parseSseChunk(packet);
      }
    }
    throw new Error('服务端关闭了实时连接');
  }catch(err) {
    if(generation!==connection.generation)return;
    if(!controller.signal.aborted && err?.message)console.warn('实时流中断:',err.message);
  }finally{
    if(reader){try{await reader.cancel();}catch{}}
    if(generation===connection.generation){connection.controller=null;scheduleReconnect(generation);}
  }
}
function connect() {
  const generation=++connection.generation;
  connection.controller?.abort();clearTimeout(connection.retryTimer);stopPolling();
  clearInterval(connection.heartbeatTimer);
  connection.retries=0;
  connection.heartbeatTimer=setInterval(()=>{
    if(generation!==connection.generation)return;
    if(state.network==='connected'&&Date.now()-connection.lastPulse>46000)
      connection.controller?.abort();
  },5000);
  void stream(generation);
}
async function reconcilePending() {
  if(!state.pendingAction||state.reconciling||!state.session)return;
  state.reconciling=true;
  const pending=state.pendingAction;
  try {
    await request(pending.path,pending.data,true);
    state.pendingAction=null;
    void fetchState();
  }catch(err) {
    if(!err.network) {
      state.pendingAction=null;
      notice(err.status===409?'原操作已过期，已按最新回合同步':'操作恢复失败：'+err.message);
      void fetchState();
    }
  }finally{state.reconciling=false;}
}
if(typeof window!=='undefined') {
  window.addEventListener('online',()=>{
    if(state.session){connection.controller?.abort();void fetchState();}
  });
  window.addEventListener('offline',()=>{if(state.session){setNetworkStatus('offline');connection.controller?.abort();}});
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden && state.session)void fetchState();
  });
}
const icons={
  cards:'<rect x="4" y="4" width="13" height="17" rx="2"/><path d="m17 5 4 2-3 14M8 10l3-3 3 3-3 4z"/>',
  people:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2"/>',
  door:'<path d="M13 3h7v18h-7M3 12h12m-4-4 4 4-4 4M13 3 7 5v4m0 6v4l6 2z"/>',
  copy:'<rect x="8" y="7" width="12" height="15" rx="2"/><path d="M15 3H4v15"/>',
  help:'<circle cx="12" cy="12" r="10"/><path d="M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01"/>',
  settings:'<path d="m10 2 4 0 1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1z"/><circle cx="12" cy="12" r="3"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  robot:'<rect x="3" y="6" width="18" height="15" rx="5"/><path d="M12 2v4M1 12h2m18 0h2M8 12h.01M16 12h.01M8 17h8"/>',
  shuffle:'<path d="M3 7h3c5 0 7 10 12 10h3m-4-4 4 4-4 4M3 17h3c2 0 3-1 4-3m4-4c1-2 2-3 4-3h3m-4-4 4 4-4 4"/>',
  chair:'<path d="M5 13V5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8M3 13h18v5H3zM6 18v4m12-4v4"/>',
  shell:'<path d="M3 15c0-7 4-12 9-12s9 5 9 12l-5 6H8zM8 9h8l3 6-4 4H9l-4-4zM8 9l-3-3m11 3 3-3M5 15H3m16 0h2M9 19l-1 2m7-2 1 2"/>'
};
const icon=name=>['help','settings','door'].includes(name)?`<img class="icon icon-art" src="/assets/icons/${name==='door'?'leave':name}.png" alt="">`:`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.cards}</svg>`;
function avatar(player,large=false) {
  const names=['turtle','cat','dog','rabbit','panda','owl','human_boy','human_girl'];
  const index=[...(player?.id||'home')].reduce((sum,c)=>sum+c.charCodeAt(0),0)%names.length;
  return `<span class="avatar ${large?'avatar-large':''}" aria-hidden="true"><img src="/assets/avatars/${names[index]}_round.png" alt=""></span>`;
}
function brand(large=false) {
  return `<div class="${large?'brand-emblem':'brand brand-mini'}">${large?'<h1 class="sr-only">龟牌派对</h1>':''}<img src="/assets/branding/turtle_party_logo.png" alt="${large?'':'龟牌派对'}"></div>`;
}
function sceneFrame() {
  return `<div class="scene-shell" data-mode="home"><div class="scene-room" aria-hidden="true"><img src="/assets/tables/room_window_scenery.png" alt=""></div><div class="scene-table" aria-hidden="true"><img src="/assets/tables/table_felt_wood_compact.png" alt=""></div><div class="scene-props" aria-hidden="true"><img class="scene-mascot mascot-happy" src="/assets/mascots/turtle_happy.png" alt=""><img class="scene-mascot mascot-thinking" src="/assets/mascots/turtle_thinking.png" alt=""></div><div class="scene-content"></div><div class="dialog-host"></div></div>`;
}
function tableToolbar(v) {
  const actor=v.players.find(p=>p.id===v.currentPlayerId);
  return `<header class="game-topbar">${brand()}
    <div class="wood-ribbon"><button class="room-copy" data-ui="copy" title="复制房间号">房间号 <strong>${h(v.code)}</strong> ${icon('copy')}</button><span class="pill connection-tag" id="connection-tag" data-status="${state.network}">${connectionLabel()}</span><span class="current-turn" title="${h(actor?.name||'等待好友入座')}">${v.phase==='lobby'?'等待入座':v.phase==='finished'?'本局结束':`轮到 <strong>${h(actor?.name||'玩家')}</strong>`}</span></div>
    <div class="top-actions"><button class="round-button" data-ui="rules" aria-label="玩法说明">${icon('help')}</button><button class="round-button" data-ui="settings" aria-label="游戏设置">${icon('settings')}</button><button class="round-button leave-button" data-ui="leave" aria-label="离开牌桌">${icon('door')}</button></div></header>
    <div class="network-banner" id="network-banner" role="status" ${['connected','idle'].includes(state.network)?'hidden':''}>${state.network==='offline'?'网络已断开，座位和手牌已保留。':'正在重新连接，请勿重复操作。'}</div>`;
}
function landing() {
  return `<div class="home-page"><header class="home-topbar"><span class="home-welcome">围桌而坐，好戏开场</span><button class="round-button" data-ui="settings" aria-label="游戏设置">${icon('settings')}</button></header>
    <main class="home-stage"><section class="home-entry">${brand(true)}<p class="home-tagline">二至六人围桌，抽一张，配一对。</p>
      <div class="hero-buttons"><button class="btn btn-primary" data-ui="quick">${icon('cards')}快速开始</button><button class="btn btn-cream" data-ui="create">${icon('people')}创建房间</button><button class="btn btn-cream" data-ui="join">${icon('door')}加入房间</button></div></section>
      <aside class="home-rules parchment art-panel" aria-labelledby="home-rules-title"><header class="panel-heading"><h2 id="home-rules-title">游戏规则</h2></header><div class="panel-body"><ol>
        <li><span class="rule-symbol">${icon('cards')}</span><span>随机移除一张牌<small>一副扑克，藏好这一局的小秘密</small></span></li>
        <li><span class="rule-symbol">${icon('people')}</span><span>轮流从邻座抽牌<small>先选中，再确认；翻牌全桌可见</small></span></li>
        <li><span class="rule-symbol">♥</span><span>相同点数自动配对<small>不比花色，只看点数</small></span></li>
        <li><span class="rule-symbol">${icon('shuffle')}</span><span>配对成功即移出<small>手牌清空，就能安全脱身</small></span></li>
        <li><span class="rule-symbol">${icon('shell')}</span><span>最后留下乌龟者失败<small>手牌清空，就能安全脱身</small></span></li>
      </ol></div></aside>
    </main><footer class="home-footer">一桌好牌，一起慢慢玩。</footer></div>`;
}
function modalFrame(title,content,extra='') {
  return `<div class="modal-layer"><button class="modal-backdrop" data-ui="close-dialog" tabindex="-1" aria-label="关闭弹窗"></button><section class="parchment modal-panel art-panel ${extra}" role="dialog" aria-modal="true" aria-label="${h(title)}"><header class="panel-heading"><h2>${h(title)}</h2><button class="modal-close round-button" data-ui="close-dialog" aria-label="关闭弹窗">${icon('close')}</button></header><div class="panel-body">${content}</div></section></div>`;
}
function formView() {
  const type=state.form;
  const titles={quick:'快速开始',create:'创建房间',join:'加入房间'};
  return modalFrame(titles[type],`<p class="modal-intro">${type==='quick'?'和三名电脑玩家，马上来一局。':type==='create'?'留好座位，等朋友一起上桌。':'输入好友分享的六位数字房间号。'}</p><form data-form="${type}" novalidate>${nameInput()}
    ${type==='create'?'<label class="field"><span>房间人数上限</span><select name="capacity"><option value="2">二人</option><option value="3">三人</option><option value="4" selected>四人（推荐）</option><option value="5">五人</option><option value="6">六人</option></select></label>':''}
    ${type==='join'?'<label class="field"><span>6 位房间号</span><input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="例如 003821" autocomplete="off" required></label>':''}
    <p class="form-error" role="status" aria-live="polite"></p><div class="action-row"><button class="btn btn-primary" type="submit">${type==='quick'?'开始对战':titles[type]}</button><button class="btn btn-cream" data-ui="close-dialog" type="button">返回</button></div></form>`,'form-panel');
}
function tableSeats(v,lobby=false) {
  const positions={2:[[50,21]],3:[[27,28],[73,28]],4:[[17,43],[50,22],[83,43]],5:[[13,47],[34,23],[66,23],[87,47]],6:[[11,50],[27,25],[50,19],[73,25],[89,50]]};
  const mine=v.players.findIndex(p=>p.id===v.myId);
  return `<div class="seat-ring" data-capacity="${v.capacity}">${positions[v.capacity].map(([x,y],i)=>{
    const player=v.players[(mine+i+1)%v.capacity];
    return player?seat(player,v,lobby,`--seat-x:${x}%;--seat-y:${y}%`):'<span class="seat-slot" hidden aria-hidden="true"></span>';
  }).join('')}</div>`;
}
function roomView(v) {
  const me=v.players.find(p=>p.id===v.myId);
  return `<div class="game-page lobby-page">${tableToolbar(v)}<main class="game-layout"><section class="table lobby-table" aria-label="等待中的好友牌桌">${tableSeats(v,true)}
    <div class="waiting-center"><div class="waiting-heading"><h1 class="hanging-sign">等待朋友上桌</h1><p class="waiting-note">房间已准备好，分享号码就能加入</p></div><div class="deck-stack" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="room-actions">${isHost()?`<button class="btn btn-cream" data-api="add_bot" ${v.players.length>=v.capacity?'disabled':''}>${icon('robot')}添加电脑</button>`:''}<button class="btn btn-cream" data-ui="copy">${icon('people')}邀请好友</button></div>
    ${isHost()?`<button class="btn btn-primary start-button" data-api="start" ${v.players.length<2?'disabled':''}>开始游戏</button>`:'<p class="waiting-owner">等房主开始，先坐一会儿。</p>'}</div>
    <div class="table-bottom"><span class="stat-chip">已入座 <strong>${v.players.length} / ${v.capacity}</strong></span><span class="lobby-hint">至少两人，即可开局</span></div></section>
    <section class="own-dock lobby-dock">${seat(me,v,true,'','own-seat')}<span class="own-welcome">你的座位已留好</span></section></main></div>`;
}
function playingCard(card,idx,own=true) {
  const red=['H','D'].includes(card.suit);
  const raised=own && !state.effectActive && state.view?.selection?.targetId===state.view?.myId && state.view.selection.slot===idx;
  return `<button type="button" class="card card-front ${red?'red':'black'} ${own?'own-card':''} ${raised?'being-selected':''}" data-card-id="${h(card.id)}" ${own?`draggable="${!isLocked()}" data-own-card="${idx}" style="--card-index:${idx}"`:'tabindex="-1"'} title="${h(cardName(card))}${raised?' · 对方正在选这张牌':''}" aria-label="${h(cardName(card))}${raised?'，对方正在选这张牌':''}">
      <span class="value">${h(rankLabel(card.rank))}</span><span class="corner-suit">${glyph[card.suit]}</span><span class="big-suit">${glyph[card.suit]}</span></button>`;
}
function seat(p,v,lobby=false,position='',extra='') {
  const status=lobby?(p.owner?'房主':p.bot?'电脑玩家':'已入座'):p.escaped?'安全脱身':p.autoplay&&!p.bot?'电脑托管':p.id===v.currentPlayerId?'正在抽牌':p.id===v.targetPlayerId?'等待被抽':'等待回合';
  return `<article data-player-seat="${h(p.id)}" class="seat ${extra} ${p.id===v.currentPlayerId?'active':''} ${p.id===v.targetPlayerId?'target':''} ${p.escaped?'out':''}" style="${position}">
    <div class="seat-portrait">${avatar(p,true)}${!lobby&&p.count?`<span class="seat-fan" aria-hidden="true">${Array.from({length:Math.min(3,p.count)},()=>'<i></i>').join('')}</span>`:''}</div>
    <div class="who"><strong title="${h(p.name)}">${h(p.name)}${p.id===v.myId?' <em>我</em>':''}</strong><span>${lobby?status:`${p.count} 张 · ${status}`}</span></div>
    ${lobby&&isHost()&&p.bot?`<button class="remove-bot" data-api="remove_bot" data-id="${h(p.id)}" aria-label="移除${h(p.name)}">${icon('close')}</button>`:''}</article>`;
}
function gameView(v) {
  const actor=getPlayer(v.currentPlayerId),target=getPlayer(v.targetPlayerId);
  const me=myPlayer();const myActive=myTurn();const selected=myActive?state.selected:v.selection?.slot;
  const liveCount=v.players.filter(p=>p.count>0).length;
  const isFinalTwo=liveCount===2;
  const backCards=(v.targetSlots||[]).map(index=>`<button class="card card-back ${selected===index?'selected':''}" data-slot="${index}" aria-pressed="${selected===index}" ${!myActive?'disabled':''} aria-label="抽取第 ${index+1} 张暗牌" title="第 ${index+1} 张牌"></button>`).join('');
  let headline='等待玩家行动', subline='观察其他玩家的抽牌过程';
  if(myActive){headline=`从 ${h(target?.name||'邻座')} 手中抽一张`;subline=`${target?.count||0} 张暗牌 · 点击选择，再确认抽取`;}
  else if(actor){headline=`${h(actor.name)} 正在抽牌`;subline=`正在从 ${h(target?.name||'邻座')} 的手牌中抽取`;
  if(v.escaped.includes(v.myId)){headline='你已安全脱身！';subline='继续围观，看看谁会留下乌龟';}
  }
  if(showingDraw()){headline=state.effectActive?.type==='deal'?'洗牌发牌中':'抽牌展示中';subline='在牌桌中央一起看看这一手';}
  const last=v.lastAction;
  const lastText=last?.kind==='draw'?(last.paired?'上一回合：成功配对':'上一回合：抽到一张新牌'):
    ['shuffle','reorder'].includes(last?.kind)?'有玩家调整了手牌顺序':'相同点数自动组成对子';
  return `<div class="game-page ${state.effectActive?'draw-presenting':''}">
    ${tableToolbar(v)}
    <main class="game-layout"><section class="table ${isFinalTwo?'final-table':''}" aria-label="纸牌游戏桌">
      ${tableSeats(v)}
      <div class="draw-area"><div class="round-kicker">${isFinalTwo?'最后两人 · 谁会留下乌龟？':myActive?'轮到你了':v.escaped.includes(v.myId)?'安全脱身':'留心牌桌'}</div>
        <div class="round-title">${headline}</div><div class="round-subtitle">${subline}</div>
        <div class="target-list" role="group" aria-label="待抽取的背面扑克牌">${backCards}</div>
        <div class="confirm-wrap ${myActive && v.targetSlots.length?'action-confirm':'status-confirm'}">${myActive && v.targetSlots.length?
          `<button class="btn btn-warm btn-small" data-api="draw" ${selected===null?'disabled':''}>确认抽取${selected===null?'':' · 第 '+(selected+1)+'张'}</button>`:
          `<span class="confirm-hint">${h(lastText)}</span>`}</div>
      </div>
      <aside class="discard-zone" aria-label="公共弃牌区"><span class="discard-label">弃牌区</span><div class="discard-cards">${v.pairs.length?v.pairs[v.pairs.length-1].cards.map(c=>playingCard(c,0,false)).join(''):`<span class="discard-empty">${icon('shell')}</span>`}</div><span class="discard-count">${v.pairs.length} 对 / 二十五对</span></aside>
      <div class="table-bottom"><span class="stat-chip">第 <strong>${v.round}</strong> 局 · 已配对 <strong>${v.pairs.length}</strong> / 25</span>
        <span class="stat-chip">${actor?'本回合倒计时 ':''}<strong class="timer" data-deadline="${v.deadline||0}">--</strong></span>
        <span class="stat-chip">剩余玩家 <strong>${v.players.filter(p=>p.count>0).length}</strong></span></div>
    </section>
    <section class="own-dock">${seat(me,v,false,'','own-seat')}<div class="hand-area"><div class="dock-top"><span class="dock-title">我的手牌 · ${me?.count||0} 张</span><span class="dock-sub">${showingDraw()?'正在展示这一手':isLocked()?'手牌已锁定':'长按排序 · 滑动看牌'}</span></div><div class="hand-scroll" aria-label="我的手牌">${v.myHand.length?v.myHand.map((c,i)=>playingCard(c,i)).join(''):'<div class="empty-hand">手牌清空 · 安全脱身</div>'}</div></div>
      <button class="btn btn-primary shuffle-button" data-api="shuffle" ${isLocked()||!me?.count||me.count<2?'disabled':''}>${icon('shuffle')}洗序</button></section></main>
    ${v.phase==='finished'&&!state.effectActive?finishView(v):''}
  </div>`;
}
function finishView(v) {
  const loser=getPlayer(v.loserId);
  const winners=v.escaped.map(id=>getPlayer(id)?.name).filter(Boolean);
  return `<div class="finish-layer"><section class="finish-banner parchment art-panel" role="dialog" aria-modal="true" aria-label="本局游戏结果"><header class="panel-heading"><h2>本局结束</h2></header><div class="panel-body">
    <div class="result-mascot">${avatar(loser,true)}</div><h3 class="result-title">${v.loserId===v.myId?'这次，你是乌龟！':'成功脱身！'}</h3>
    <p>本局乌龟：<strong>${h(loser?.name||'未知')}</strong><br>25 对牌已全部配齐，最后一张乌龟牌揭晓。</p>
    <div class="reveal-cards"><div><div class="reveal-label">开局移除</div>${playingCard(v.removed,0,false)}</div>
      <div><div class="reveal-label">剩余乌龟牌</div>${playingCard(v.lastCard,0,false)}</div></div>
    <div class="result-players">安全脱身：${winners.map(h).join('、')}</div>
    <div class="action-row" style="justify-content:center">${isHost()?'<button class="btn btn-primary" data-api="rematch">再来一局</button>':'<span class="pill">等待房主开启下一局</span>'}
    <button class="btn btn-soft" data-ui="leave">返回首页</button></div>
  </div></section></div>`;
}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const reducedMotion = () => state.preferences.reduceMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let audioContext=null;
function unlockAudio() {
  if(!state.preferences.sound)return null;
  const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return null;
  try {
    audioContext ||= new Audio();
    void audioContext.resume().catch(()=>{});
    return audioContext;
  }catch{return null;}
}
function playTone(kind) {
  if(!state.preferences.sound||document.hidden)return;
  if(!unlockAudio()||audioContext.state!=='running')return;
  try {
    const frequencies=kind==='pair'?[660,880]:kind==='reveal'?[520]:[340];
    frequencies.forEach((frequency,index)=>{
      const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();
      const time=audioContext.currentTime+index*.07;
      oscillator.frequency.value=frequency;oscillator.type='sine';
      gain.gain.setValueAtTime(0,time);gain.gain.linearRampToValueAtTime(.035,time+.012);
      gain.gain.exponentialRampToValueAtTime(.001,time+.12);
      oscillator.connect(gain);gain.connect(audioContext.destination);oscillator.start(time);oscillator.stop(time+.13);
    });
  }catch{}
}
async function animateBox(el,frames,duration) {
  const reduce=reducedMotion();
  if(el.animate && !reduce) {
    await el.animate(frames,{duration,easing:'ease-in-out',fill:'forwards'}).finished.catch(()=>{});
  } else {
    Object.assign(el.style,frames[frames.length-1]);
    await pause(duration);
  }
}
async function playDealEffect(effect) {
  const table=app.querySelector('.table')?.getBoundingClientRect();if(!table)return;
  const duration=Math.min(1200,Math.max(500,effect.next.lastAction.deal.until-Date.now()));
  const el=document.createElement('div');el.className='deal-effect';el.setAttribute('role','status');
  el.innerHTML=`<div class="deck-stack deck-shuffling"><i></i><i></i><i></i></div><strong>洗牌，准备开局</strong>`;
  document.body.appendChild(el);const flights=[];
  try {
    await pause(duration*.2);if(state.effectActive!==effect)return;
    el.querySelector('strong').textContent='好牌，发到每一个座位';
    await Promise.all(effect.next.players.flatMap((player,index)=>[0,1].map(async pass=>{
      await pause((index+pass*effect.next.players.length)*duration*.018);
      if(state.effectActive!==effect)return;
      const destination=app.querySelector(`[data-player-seat="${player.id}"]`)?.getBoundingClientRect();if(!destination)return;
      const card=document.createElement('div');card.className='card card-back deal-flight';
      card.style.left=`${table.left+table.width/2-20}px`;card.style.top=`${table.top+table.height/2-28}px`;
      document.body.appendChild(card);flights.push(card);
      await animateBox(card,[{transform:'translate(0,0)',opacity:1},{transform:`translate(${destination.left+destination.width/2-table.left-table.width/2}px,${destination.top+destination.height/2-table.top-table.height/2}px) scale(.55)`,opacity:0}],duration*.4);
      card.remove();
    })));
    if(state.effectActive!==effect)return;
    el.querySelector('strong').textContent=`开局已自动配对 ${effect.next.lastAction.deal.pairs} 对`;
    await pause(duration*.2);
  }finally{el.remove();flights.forEach(node=>node.remove());}
}
function drawArrivalView({previous,action}) {
  const view={...previous,selection:null,lastAction:action,
    players:previous.players.map(player=>({...player,count:player.count+
      (player.id===action.actorId?1:0)-(player.id===action.targetId?1:0)})),
    myHand:[...previous.myHand]};
  if(previous.myId===action.targetId)view.myHand.splice(action.slot,1);
  if(previous.myId===action.actorId)view.myHand.push(action.card);
  return view;
}
async function playDrawEffect(effect,origin) {
  if(typeof document.createElement!=='function'||!document.body)return;
  const {action,next,previous}=effect;
  const alive=()=>state.effectActive===effect;
  const table=app.querySelector('.table')?.getBoundingClientRect();
  if(!table)return;
  const from=origin||{left:table.left+table.width/2-32,top:table.top+table.height/2-45,width:64,height:91};
  const dx=table.left+table.width/2-(from.left+from.width/2);
  const dy=table.top+table.height*.56-(from.top+from.height/2);
  const duration=Math.min(2400,Math.max(600,action.animationUntil? action.animationUntil-Date.now():2400));
  const el=document.createElement('div');
  el.className='draw-effect';el.dataset.stage='lifting';el.setAttribute('role','status');
  el.style.left=`${from.left}px`;el.style.top=`${from.top}px`;
  el.style.width=`${from.width}px`;el.style.height=`${from.height}px`;
  el.innerHTML=`<div class="draw-caption">正在抽牌</div><div class="draw-flipper"><div class="flip-inner">
    <div class="flip-back"><div class="card card-back"></div></div>
    <div class="flip-front">${playingCard(action.card,0,false)}</div></div></div>`;
  document.body.appendChild(el);
  const source=app.querySelector(previous.myId===action.targetId
    ? `.hand-scroll [data-own-card="${action.slot}"]`:`.target-list [data-slot="${action.slot}"]`);
  source?.classList.add('draw-source');
  const center=`translate(${dx}px,${dy}px) scale(1.22)`;
  try {
    await animateBox(el,[{transform:'translate(0,0)'},{transform:center}],duration*.12);
    if(!alive())return;
    el.dataset.stage='flipping';
    await animateBox(el.querySelector('.flip-inner'),[{transform:'rotateY(0deg)'},{transform:'rotateY(180deg)'}],duration*.18);
    if(!alive())return;
    el.dataset.stage='revealed';
    playTone('reveal');
    el.querySelector('.draw-caption').textContent=`抽到了${cardName(action.card)}`;
    await pause(duration*.12);
    if(!alive())return;
    const destination=(next.myId===action.actorId?app.querySelector('.hand-scroll'):
      [...app.querySelectorAll('[data-player-seat]')].find(node=>node.dataset.playerSeat===action.actorId))?.getBoundingClientRect();
    const tx=destination?destination.left+destination.width/2-(from.left+from.width/2):dx;
    const ty=destination?destination.top+destination.height/2-(from.top+from.height/2):dy;
    el.dataset.stage='returning';
    await animateBox(el,[{transform:center,opacity:1},{transform:`translate(${tx}px,${ty}px) scale(.85)`,opacity:.5}],duration*.18);
    if(!alive())return;
    el.remove();
    state.view=drawArrivalView(effect);render();
    app.querySelector(`.hand-scroll [data-card-id="${action.card.id}"]`)?.classList.add('drawn-card');
    await pause(duration*.08);
    if(!alive())return;
    if(action.paired&&action.pair?.length===2)await playPairEffect(action.pair,duration*.32);
    else await pause(duration*.32);
  } finally {el.remove();}
}
async function playPairEffect(pair,duration) {
  playTone('pair');
  const el=document.createElement('div');
  el.className='pair-effect';el.setAttribute('role','status');
  el.innerHTML=`<strong>配对成功</strong><div class="pair-effect-cards">${pair.map(card=>playingCard(card,0,false)).join('')}</div>`;
  document.body.appendChild(el);
  pair.forEach(card=>app.querySelector(`.hand-scroll [data-card-id="${card.id}"]`)?.classList.add('pair-matching'));
  const zone=app.querySelector('.discard-zone')?.getBoundingClientRect();
  const bounds=el.getBoundingClientRect();
  const destination=zone?`translate(calc(-50% + ${zone.left+zone.width/2-bounds.left-bounds.width/2}px),calc(-50% + ${zone.top+zone.height/2-bounds.top-bounds.height/2}px)) scale(.3)`:'translate(-50%,-90%) scale(.55)';
  try {
    await animateBox(el,[{transform:'translate(-50%,-30%) scale(.8)',opacity:0},
      {transform:'translate(-50%,-50%) scale(1.08)',opacity:1,offset:.3},
      {transform:destination,opacity:0}],duration);
  }finally{el.remove();}
}
function playShuffleEffect(action,view) {
  const own=action.playerId===view.myId;
  const container=own?app.querySelector('.hand-scroll'):
    [...app.querySelectorAll('[data-player-seat]')].find(el=>el.dataset.playerSeat===action.playerId);
  if(!container) return;
  container.classList.add(own?'hand-shuffling':'seat-shuffling');
  setTimeout(()=>container.classList.remove('hand-shuffling','seat-shuffling'),480);
}

function dialogView() {
  if(state.form!=='home')return formView();
  if(state.dialog==='settings')return modalFrame('游戏设置',`<div class="settings-list"><label><span>轻柔音效<small>选牌、翻牌和配对时播放</small></span><input type="checkbox" name="sound" ${state.preferences.sound?'checked':''}></label><label><span>减少动态效果<small>使用简洁的移牌与翻牌反馈</small></span><input type="checkbox" name="reduceMotion" ${state.preferences.reduceMotion?'checked':''}></label></div><p class="modal-note">设置仅保存在这台设备上，不影响牌局规则。</p><div class="action-row"><button class="btn btn-primary" data-ui="close-dialog">返回牌桌</button></div>`);
  if(state.dialog==='rules')return modalFrame('围桌玩法',`<ol class="full-rules"><li>随机移除一张牌，剩余五十一张发给在座玩家。</li><li>相同点数自动配对；清空手牌就能安全脱身。</li><li>从指定邻座选一张牌，再确认抽取。被选者会看到对应手牌提起。</li><li>确认后向全桌翻牌，移入手中，再展示配对结果。</li><li>可以洗序或长按重排；被抽牌时，手牌顺序锁定。</li><li>二十五对配齐，最后持有乌龟牌的玩家失败。</li></ol><div class="action-row"><button class="btn btn-primary" data-ui="close-dialog">知道了</button></div>`);
  if(state.dialog==='leave')return modalFrame('离开这张牌桌？',`<p class="modal-intro">${state.view?.phase==='playing'?'对局中离开会撤销恢复凭证，由电脑继续托管。':'离开后，可以用房间号重新加入等待中的牌桌。'}</p><div class="action-row"><button class="btn btn-primary" data-ui="close-dialog">继续坐一会儿</button><button class="btn btn-cream" data-ui="confirm-leave">离开牌桌</button></div>`);
  return '';
}
const observedPanels=new Set();
function sizeArtPanel(panel) {
  const width=panel.getBoundingClientRect().width;
  if(!width||panel.dataset.artWidth===width.toFixed(2))return;
  panel.dataset.artWidth=width.toFixed(2);
  const scale=width/600;
  panel.style.setProperty('--art-top',`${128*scale}px`);
  panel.style.setProperty('--art-side',`${48*scale}px`);
  panel.style.setProperty('--art-bottom',`${66*scale}px`);
}
const panelObserver=typeof ResizeObserver==='function'?new ResizeObserver(entries=>entries.forEach(entry=>sizeArtPanel(entry.target))):null;
function updateArtwork() {
  for(const panel of observedPanels)if(!panel.isConnected){panelObserver?.unobserve(panel);observedPanels.delete(panel);}
  app.querySelectorAll('.art-panel').forEach(panel=>{
    sizeArtPanel(panel);
    if(!observedPanels.has(panel)){observedPanels.add(panel);panelObserver?.observe(panel);}
  });
  app.querySelectorAll('.btn').forEach(button=>{
    if(button.querySelector('.button-content'))return;
    const face=document.createElement('span');face.className='button-content';
    while(button.firstChild)face.appendChild(button.firstChild);
    button.appendChild(face);
  });
}
function render() {
  const targetOffset=app.querySelector('.target-list')?.scrollLeft||0;
  const handOffset=app.querySelector('.hand-scroll')?.scrollLeft||0;
  if(!app.querySelector('.scene-shell'))app.innerHTML=sceneFrame();
  const content=app.querySelector('.scene-content'),shell=app.querySelector('.scene-shell');
  const mode=!state.view?'home':state.view.phase==='lobby'?'lobby':'playing';
  content.innerHTML=!state.view?(state.session?`<div class="connecting-stage">${brand(true)}<p>正在入座，稍等一会儿…</p></div>`:landing()):state.view.phase==='lobby'?roomView(state.view):gameView(state.view);
  shell.dataset.mode=mode;shell.classList.toggle('motion-muted',state.preferences.reduceMotion);
  if(state.sceneMode&&state.sceneMode!==mode&&content.animate&&!reducedMotion())content.animate([{opacity:.35},{opacity:1}],{duration:180});
  state.sceneMode=mode;
  const key=state.form!=='home'?state.form:state.dialog;
  if(key!==state.dialogKey) {
    const host=app.querySelector('.dialog-host');host.innerHTML=dialogView();state.dialogKey=key;
    updateArtwork();
    if(key)host.querySelector('input,select,button:not([tabindex="-1"])')?.focus();
    else (app.querySelector('.finish-banner button')||app.querySelector(`[data-ui="${state.returnFocus||'settings'}"]`))?.focus();
  }
  if(state.view?.phase==='finished'&&!state.effectActive&&state.resultRound!==state.view.round) {
    state.resultRound=state.view.round;
    if(!key)app.querySelector('.finish-banner button')?.focus();
  }
  if(app.querySelector('.target-list')) app.querySelector('.target-list').scrollLeft=targetOffset;
  if(app.querySelector('.hand-scroll')) app.querySelector('.hand-scroll').scrollLeft=handOffset;
  updateArtwork();
  updateCountdown();
}
function updateCountdown() {
  if(state.waitingUntil&&Date.now()>=state.waitingUntil&&!state.effectActive) {
    state.waitingUntil=0;render();return;
  }
  document.querySelectorAll('.timer[data-deadline]').forEach(el=> {
    const deadline=Number(el.dataset.deadline);
    el.textContent=showingDraw()?'亮牌中':deadline?`${Math.max(0,Math.ceil((deadline-Date.now())/1000))}秒`:'--';
  });
}
async function sendAction(type,props={}) {
  if(!state.session) throw new Error('未加入房间');
  if(state.pendingAction && type!=='leave')throw new Error('上一操作正在等待服务器确认');
  const path=`/api/rooms/${state.session.code}/action`;
  const data={...props,type,requestId:requestId()};
  try {
    const result=await request(path,data,true);
    if(state.network!=='connected')void fetchState();
    return result;
  }catch(err) {
    if(err.network && type!=='leave') {
      state.pendingAction={path,data};
      setNetworkStatus('reconnecting');
      // The same request ID is replayed only after reconnection; the server
      // makes retries idempotent, including for draws and shuffles.
    }
    throw err;
  }
}
async function handleUi(type) {
  if(['quick','create','join'].includes(type)) {state.returnFocus=type;state.form=type;render();return;}
  if(['settings','rules','leave'].includes(type)) {state.returnFocus=type;state.dialog=type;render();return;}
  if(type==='close-dialog') {state.form='home';state.dialog=null;render();return;}
  if(type==='home') {if(state.session) return handleUi('leave');state.form='home';render();return;}
  if(type==='copy') {
    try{await navigator.clipboard.writeText(state.session.code);notice('已复制房间号');}
    catch{notice(`房间号：${state.session.code}`);}return;
  }
  if(type==='confirm-leave') {
    if(state.session) {
      state.busy=true;
      try{await sendAction('leave');}catch{}finally{state.busy=false;}
    }
    clearSession();state.form='home';render();return;
  }
}
app.addEventListener('click',async event=> {
  const button=event.target.closest('[data-ui],[data-api],[data-slot]');if(!button||state.busy) return;
  unlockAudio();
  if(button.dataset.ui) {await handleUi(button.dataset.ui);return;}
  if(button.hasAttribute('data-slot')) {
    if(!myTurn()) return;
    const slot=Number(button.dataset.slot);
    state.selected=state.selected===slot?null:slot;render();
    playTone('select');
    state.busy=true;
    try{await sendAction('select',{slot:state.selected,turn:state.view.turn});}
    catch(e){notice(e.message);void fetchState();}
    finally{state.busy=false;}
    return;
  }
  if(button.dataset.api) {
    const type=button.dataset.api;
    if(type==='draw'&&state.selected===null) return;
    const props=type==='draw'?{slot:state.selected,turn:state.view.turn}:type==='remove_bot'?{botId:button.dataset.id}:{};
    state.busy=true;
    try { await sendAction(type,props);if(type==='draw') state.selected=null; }
    catch(e){notice(e.message);}
    finally{state.busy=false;}
  }
});
app.addEventListener('submit',async event=> {
  const form=event.target.closest('form[data-form]');if(!form) return;
  event.preventDefault();if(state.busy)return;
  unlockAudio();
  const data=Object.fromEntries(new FormData(form));localStorage.setItem('turtle-name',data.name);
  const type=form.dataset.form;
  const error=form.querySelector('.form-error');
  const invalid=!String(data.name||'').trim()?'请输入昵称':type==='join'&&!/^\d{6}$/.test(String(data.code).trim())?'请输入六位数字房间号':null;
  if(invalid){error.textContent=invalid;form.querySelector(`[name="${!String(data.name||'').trim()?'name':'code'}"]`)?.focus();return;}
  const path=type==='quick'?'/api/quick':type==='create'?'/api/rooms':'/api/join';
  if(type==='join') data.code=String(data.code).trim();
  if(type==='create') data.capacity=Number(data.capacity);
  state.busy=true;
  const submit=form.querySelector('[type="submit"]');submit.disabled=true;
  try {const session=await request(path,data);activeSession(session);}
  catch(e){error.textContent=e.message;}finally{state.busy=false;submit.disabled=false;}
});
app.addEventListener('change',event=>{
  const name=event.target.name;
  if(!['sound','reduceMotion'].includes(name))return;
  state.preferences[name]=event.target.checked;
  localStorage.setItem(name==='sound'?'turtle-sound':'turtle-reduce-motion',event.target.checked?'on':'off');
  if(name==='sound')playTone('select');
  app.querySelector('.scene-shell')?.classList.toggle('motion-muted',state.preferences.reduceMotion);
});
document.addEventListener('keydown',event=>{
  const dialog=app.querySelector('.dialog-host [role="dialog"]')||app.querySelector('.finish-banner');
  if(!dialog)return;
  if(event.key==='Escape'&&(state.dialog||state.form!=='home')){event.preventDefault();void handleUi('close-dialog');return;}
  if(event.key!=='Tab')return;
  const controls=[...dialog.querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')];
  const first=controls[0],last=controls[controls.length-1];
  if(!dialog.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();return;}
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
});
if(typeof window!=='undefined')window.addEventListener('resize',()=>{
  cancelTouchDrag();
  if(state.effectActive){
    const effect=state.effectActive;
    document.querySelectorAll('.draw-effect,.pair-effect,.deal-effect,.deal-flight').forEach(el=>el.remove());
    finishEffect(effect);
  }
  updateArtwork();
});
let dragIndex=null;
app.addEventListener('dragstart',event=> {
  const card=event.target.closest('[data-own-card]');
  if(!card||isLocked()) {event.preventDefault();return;}
  dragIndex=Number(card.dataset.ownCard);card.classList.add('dragging');
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData('text/plain',String(dragIndex));
});
app.addEventListener('dragover',event=> {if(event.target.closest('[data-own-card]'))event.preventDefault();});
app.addEventListener('drop',async event=> {
  const card=event.target.closest('[data-own-card]');if(!card||dragIndex===null)return;
  event.preventDefault();const from=dragIndex;const to=Number(card.dataset.ownCard);dragIndex=null;
  if(from!==to)try{await sendAction('move',{from,to});}catch(e){notice(e.message);}
});
app.addEventListener('dragend',()=> {dragIndex=null;document.querySelectorAll('.dragging').forEach(el=>el.classList.remove('dragging'));});
// On touch screens, horizontal swipes scroll the hand. Reordering requires
// holding a card first and uses a visible floating copy and drop indicator.
let touchTimer=null;let touchScrollTimer=null;let movingTouch=null;
function cancelTouchDrag() {
  clearTimeout(touchTimer);clearInterval(touchScrollTimer);touchScrollTimer=null;
  if(movingTouch) {
    movingTouch.card?.classList.remove('dragging');
    movingTouch.ghost?.remove();
  }
  app.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));
  movingTouch=null;
}
function updateTouchDrag() {
  const d=movingTouch;if(!d?.active)return;
  const ghost=d.ghost;
  if(ghost) {ghost.style.left=`${d.x}px`;ghost.style.top=`${d.y}px`;}
  const hand=app.querySelector('.hand-scroll');
  if(hand) {
    const bounds=hand.getBoundingClientRect();
    if(d.y>=bounds.top-20&&d.y<=bounds.bottom+20) {
      if(d.x<bounds.left+36) hand.scrollLeft-=14;
      else if(d.x>bounds.right-36) hand.scrollLeft+=14;
    }
  }
  app.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));
  const hovered=document.elementFromPoint(d.x,d.y)?.closest('[data-own-card]');
  if(hovered && hovered!==d.card) hovered.classList.add('drop-target');
  d.to=hovered?Number(hovered.dataset.ownCard):null;
}
app.addEventListener('touchstart',event=> {
  const card=event.target.closest('[data-own-card]');
  if(!card||isLocked()||event.touches.length!==1) return;
  cancelTouchDrag();
  const t=event.touches[0];
  movingTouch={from:Number(card.dataset.ownCard),startX:t.clientX,startY:t.clientY,
    x:t.clientX,y:t.clientY,active:false,card,ghost:null,to:null};
  touchTimer=setTimeout(()=> {
    const d=movingTouch;if(!d)return;
    d.active=true;d.card.classList.add('dragging');
    const ghost=d.card.cloneNode(true);ghost.removeAttribute('draggable');
    ghost.classList.add('touch-ghost');ghost.removeAttribute('data-own-card');
    d.ghost=ghost;document.body.appendChild(ghost);
    touchScrollTimer=setInterval(updateTouchDrag,32);
    updateTouchDrag();
  },320);
},{passive:true});
app.addEventListener('touchmove',event=> {
  const d=movingTouch;if(!d)return;
  const t=event.touches[0];if(!t)return;
  d.x=t.clientX;d.y=t.clientY;
  if(!d.active) {
    if(Math.hypot(d.x-d.startX,d.y-d.startY)>12) cancelTouchDrag();
    return;
  }
  event.preventDefault();
  updateTouchDrag();
},{passive:false});
app.addEventListener('touchend',async event=> {
  const d=movingTouch;if(!d)return;
  const wasActive=d.active;
  // touchend's changedTouches contains the release position.
  const t=event.changedTouches?.[0];if(t){d.x=t.clientX;d.y=t.clientY;}
  if(wasActive) updateTouchDrag();
  const from=d.from,to=d.to;cancelTouchDrag();
  if(wasActive&&to!==null&&to!==from) {
    try{await sendAction('move',{from,to});}
    catch(e){notice(e.message);}
  }
},{passive:true});
app.addEventListener('touchcancel',cancelTouchDrag);
setInterval(updateCountdown,250);
render();recover();
