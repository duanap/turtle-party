const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const glyph = {S:'♠',H:'♥',C:'♣',D:'♦'};
const rankLabel = rank => ({A:'一',J:'侍',Q:'后',K:'王'}[rank] || rank);
const cardName = card => `${{S:'黑桃',H:'红桃',C:'梅花',D:'方块'}[card.suit]}${rankLabel(card.rank)}`;
const state = {
  session:null, view:null, form:'home', selected:null, selectedKey:null,
  network:'idle', pendingAction:null, reconciling:false,
  busy:false, toastTimeout:null, dragged:null, touchDrag:null,
  effectActive:null, queuedSnapshot:null, waitingUntil:0, lastEffectKey:null
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
  state.session=session;state.form='home';state.selected=null;state.view=null;
  state.lastEffectKey=null;state.effectActive=null;state.queuedSnapshot=null;state.pendingAction=null;
  localStorage.setItem('turtle-session',JSON.stringify(session));
  connect();
}
function clearSession() {
  stopConnection();
  state.session=null;state.view=null;state.selected=null;state.effectActive=null;
  state.queuedSnapshot=null;state.waitingUntil=0;
  state.pendingAction=null;
  document.querySelectorAll('.draw-effect,.pair-effect').forEach(el=>el.remove());
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
    void playDrawEffect(effect,origin).catch(error=>console.warn('抽牌动画中断，已同步最新牌桌',error)).finally(()=>{
      if(state.effectActive!==effect)return;
      state.effectActive=null;state.view=next;render();
      const queued=state.queuedSnapshot;state.queuedSnapshot=null;
      if(queued)applySnapshot(queued);
    });
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
function landing() {
  if(state.form!=='home') return formView();
  return `<div class="page">${introTop()}
    <main class="hero">
      <div><div class="overline">一场有点心机的纸牌游戏</div>
        <h1>谁是最后的<br><span class="light">那只乌龟？</span></h1>
        <p class="lead">抽一张，配一对，悄悄把乌龟留给别人。与好友联机，或直接挑战聪明又守规矩的电脑玩家。</p>
        <div class="hero-buttons"><button class="btn btn-primary" data-ui="quick">快速开始 · 电脑对战</button>
          <button class="btn btn-outline" data-ui="create">创建房间</button>
          <button class="btn btn-soft" data-ui="join">加入房间</button></div>
      </div>
      <div class="hero-illustration" aria-hidden="true"><div class="illustration-glow"></div><div class="deck-scene">
        <div class="demo-card one"></div><div class="demo-card three"></div>
        <div class="demo-card two"><span class="corner">后</span><span class="suit">♥</span></div><div class="turtle-bubble">🐢</div>
      </div></div>
    </main>
    <section class="details-bar"><div class="detail"><span class="round-icon">♣</span>2～6 人同桌</div>
      <div class="detail"><span class="round-icon">✦</span>自动配对 · 轻松上手</div>
      <div class="detail"><span class="round-icon">◈</span>真人与电脑同桌</div></section>
    <section class="popover home-rules"><h2>简单三步，看看谁留下乌龟</h2>
      <p>① 开局从 52 张扑克中随机抽走 1 张，发完剩余 51 张。相同点数自动配对弃牌。</p>
      <p>② 轮到你时，先选一张牌，再确认抽取。被选中的牌会提起；抽到的牌向全桌翻开，移入手中后，相同点数自动配对消除。</p>
      <p>③ 手牌清空即安全脱身。最终 25 对牌全部弃掉，剩最后 1 张牌的人就是乌龟。</p>
      <p>可拖动调整自己的手牌或使用「洗序」，打乱别人记住的位置；被别人抽牌时手牌会锁定。</p></section>
  </div>`;
}
function formView() {
  const type=state.form;
  const titles={quick:'快速开始',create:'创建房间',join:'加入房间'};
  const descriptions={quick:'立即与三名电脑玩家同桌开局。',create:'创建专属牌桌，邀请好友加入，也可以用电脑玩家补位。',join:'输入好友分享的六位数字房间号即可加入。'};
  return `<div class="page">${introTop(true)}<main class="form-panel">
    <div class="overline">准备上桌</div><h2>${titles[type]}</h2><p>${descriptions[type]}</p>
    <form data-form="${type}">${nameInput()}
      ${type==='create'?'<label class="field"><span>房间人数上限</span><select name="capacity"><option value="2">2 人</option><option value="3">3 人</option><option value="4" selected>4 人（推荐）</option><option value="5">5 人</option><option value="6">6 人</option></select></label>':''}
      ${type==='join'?'<label class="field"><span>6 位房间号</span><input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="例如 012345" autocomplete="off" required></label>':''}
      <div class="action-row"><button class="btn btn-primary" type="submit">${titles[type]}</button><button class="btn btn-soft" data-ui="home" type="button">返回</button></div>
    </form></main></div>`;
}
function roomView(v) {
  const memberSlots=v.players.map(p=>`<article class="member"><div class="avatar">${p.bot?'机':h(p.name.slice(0,1))}</div>
      <div><strong>${h(p.name)} ${p.owner?'· 房主':''}</strong><small>${p.bot?'智能玩家':'真人玩家'}</small></div>
      ${isHost()&&p.bot?`<button type="button" class="remove-bot" title="移除电脑玩家" data-api="remove_bot" data-id="${h(p.id)}">移除</button>`:''}</article>`).join('');
  const blanks=Array.from({length:v.capacity-v.players.length},()=>'<article class="member"><div class="avatar" style="background:#f0f1ed;color:#b4bfb3">＋</div><div><strong>等待加入</strong><small>空位</small></div></article>').join('');
  return `<div class="page">${introTop(false)}<main class="room-card">
    <div class="room-heading"><div><div class="overline">好友牌桌</div><h1>等朋友上桌</h1>
      <p>房间已准备好，分享房间号邀请好友。</p></div><div><div class="code-tag">${h(v.code)}</div>
      <div style="margin-top:9px;text-align:center"><button class="btn btn-small btn-soft" data-ui="copy">复制房间号</button></div></div></div>
    <div class="members">${memberSlots}${blanks}</div>
    <div class="room-actions">${isHost()?`<button class="btn btn-primary" data-api="start" ${v.players.length<2?'disabled':''}>开始游戏</button>
      <button class="btn btn-soft" data-api="add_bot" ${v.players.length>=v.capacity?'disabled':''}>＋ 添加电脑</button>`:'<span class="pill">等待房主开始游戏</span>'}
      <button class="btn btn-outline" data-ui="leave">离开房间</button></div>
    <div class="room-hint">已入座 ${v.players.length} / ${v.capacity} · 至少两名玩家（含电脑）即可开始 · 游戏开始后不再允许中途加入</div>
  </main></div>`;
}
function playingCard(card,idx,own=true) {
  const red=['H','D'].includes(card.suit);
  const raised=own && !state.effectActive && state.view?.selection?.targetId===state.view?.myId && state.view.selection.slot===idx;
  return `<button type="button" class="card card-front ${red?'red':'black'} ${own?'own-card':''} ${raised?'being-selected':''}" data-card-id="${h(card.id)}" ${own?`draggable="${!isLocked()}" data-own-card="${idx}" style="--card-index:${idx}"`:'tabindex="-1"'} title="${h(cardName(card))}${raised?' · 对方正在选这张牌':''}" aria-label="${h(cardName(card))}${raised?'，对方正在选这张牌':''}">
      <span class="value">${h(rankLabel(card.rank))}</span><span class="corner-suit">${glyph[card.suit]}</span><span class="big-suit">${glyph[card.suit]}</span></button>`;
}
function seat(p,v) {
  const status=p.escaped?'已脱身':p.id===v.currentPlayerId?'抽牌中':p.id===v.targetPlayerId?'等待被抽':`${p.count} 张牌`;
  return `<div data-player-seat="${h(p.id)}" class="seat ${p.id===v.currentPlayerId?'active':''} ${p.id===v.targetPlayerId?'target':''} ${p.escaped?'out':''}">
    <div class="avatar">${p.bot?'机':h(p.name.slice(0,1))}</div><div class="who"><strong>${h(p.name)}</strong><span>${status}</span></div></div>`;
}
function gameView(v) {
  const actor=getPlayer(v.currentPlayerId),target=getPlayer(v.targetPlayerId);
  const me=myPlayer();const myActive=myTurn();const selected=myActive?state.selected:v.selection?.slot;
  const liveCount=v.players.filter(p=>p.count>0).length;
  const isFinalTwo=liveCount===2;
  const competitors=v.players.filter(p=>p.id!==v.myId);
  const backCards=(v.targetSlots||[]).map(index=>`<button class="card card-back ${selected===index?'selected':''}" data-slot="${index}" aria-pressed="${selected===index}" ${!myActive?'disabled':''} aria-label="抽取第 ${index+1} 张暗牌" title="第 ${index+1} 张牌"></button>`).join('');
  let headline='等待玩家行动', subline='观察其他玩家的抽牌过程';
  if(myActive){headline=`从 ${h(target?.name||'邻座')} 手中抽一张`;subline=`${target?.count||0} 张暗牌 · 点击选择，再确认抽取`;}
  else if(actor){headline=`${h(actor.name)} 正在抽牌`;subline=`正在从 ${h(target?.name||'邻座')} 的手牌中抽取`;
  if(v.escaped.includes(v.myId)){headline='你已安全脱身！';subline='继续围观，看看谁会留下乌龟';}
  }
  if(showingDraw()){headline='抽牌展示中';subline='翻开亮牌，移入手中，再看看能否配对';}
  const last=v.lastAction;
  const lastText=last?.kind==='draw'?(last.paired?'上一回合：成功配对':'上一回合：抽到一张新牌'):
    ['shuffle','reorder'].includes(last?.kind)?'有玩家调整了手牌顺序':'相同点数自动组成对子';
  return `<div class="game-page ${state.effectActive?'draw-presenting':''}">
    <header class="game-topbar"><div class="brand"><span class="brand-symbol">龟</span>抽乌龟</div>
      <div class="top-actions"><span class="game-meta">第 ${v.round} 局 · 房间 ${h(v.code)}</span><span class="pill connection-tag" id="connection-tag" data-status="${state.network}">${connectionLabel()}</span>
      <button class="btn btn-small btn-soft" data-ui="leave">退出</button></div></header>
    <div class="network-banner" id="network-banner" role="status" ${['connected','idle'].includes(state.network)?'hidden':''}>${state.network==='offline'?'网络已断开，保留座位和手牌；恢复联网后自动同步。':'连接不稳定，正在自动重连并核对最新回合，请勿重复操作。'}</div>
    <main class="game-layout"><section class="table ${isFinalTwo?'final-table':''}" aria-label="纸牌游戏桌">
      <div class="seat-row">${competitors.map(p=>seat(p,v)).join('')}</div>
      <div class="draw-area"><div class="round-kicker">${isFinalTwo?'最后两人 · 谁会留下乌龟？':myActive?'轮到你了':v.escaped.includes(v.myId)?'安全脱身':'留心牌桌'}</div>
        <div class="round-title">${headline}</div><div class="round-subtitle">${subline}</div>
        <div class="target-list" role="group" aria-label="待抽取的背面扑克牌">${backCards}</div>
        <div class="confirm-wrap ${myActive && v.targetSlots.length?'action-confirm':'status-confirm'}">${myActive && v.targetSlots.length?
          `<button class="btn btn-warm btn-small" data-api="draw" ${selected===null?'disabled':''}>确认抽取${selected===null?'':' · 第 '+(selected+1)+'张'}</button>`:
          `<span class="confirm-hint">${h(lastText)}</span>`}</div>
      </div>
      <div class="table-bottom"><span class="stat-chip">已配对 <strong>${v.pairs.length}</strong> / 25</span>
        <span class="stat-chip">${actor?'本回合倒计时 ':''}<strong class="timer" data-deadline="${v.deadline||0}">--</strong></span>
        <span class="stat-chip">剩余玩家 <strong>${v.players.filter(p=>p.count>0).length}</strong></span></div>
    </section>
    <section class="own-dock"><div class="dock-top"><div><span class="dock-title">我的手牌 · ${me?.count||0} 张</span>
      <span class="dock-sub">${showingDraw()?'正在亮牌，稍后继续':isLocked()?'正在被抽牌，已锁定':'长按拖动排序 · 横向滑动查看更多'}</span></div>
      <button class="btn btn-small btn-soft" data-api="shuffle" ${isLocked()||!me?.count||me.count<2?'disabled':''}>↝ 洗序</button></div>
      <div class="hand-scroll" aria-label="我的手牌">${v.myHand.length?v.myHand.map((c,i)=>playingCard(c,i)).join(''):'<div class="empty-hand">手牌清空 · 安全脱身</div>'}</div></section></main>
    ${v.phase==='finished'&&!state.effectActive?finishView(v):''}
  </div>`;
}
function finishView(v) {
  const loser=getPlayer(v.loserId);
  const winners=v.escaped.map(id=>getPlayer(id)?.name).filter(Boolean);
  return `<div class="finish-layer"><section class="finish-banner" role="dialog" aria-modal="true" aria-label="本局游戏结果">
    <div class="overline">本局结束</div><h2>${v.loserId===v.myId?'这次，你是乌龟！':'成功脱身！'}</h2>
    <p>本局乌龟：<strong>${h(loser?.name||'未知')}</strong><br>25 对牌已全部配齐，最后一张乌龟牌揭晓。</p>
    <div class="reveal-cards"><div><div class="reveal-label">开局移除</div>${playingCard(v.removed,0,false)}</div>
      <div><div class="reveal-label">剩余乌龟牌</div>${playingCard(v.lastCard,0,false)}</div></div>
    <div class="result-players">安全脱身：${winners.map(h).join('、')}</div>
    <div class="action-row" style="justify-content:center">${isHost()?'<button class="btn btn-primary" data-api="rematch">再来一局</button>':'<span class="pill">等待房主开启下一局</span>'}
    <button class="btn btn-soft" data-ui="leave">返回首页</button></div>
  </section></div>`;
}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function animateBox(el,frames,duration) {
  const reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(el.animate && !reduce) {
    await el.animate(frames,{duration,easing:'ease-in-out',fill:'forwards'}).finished.catch(()=>{});
  } else {
    Object.assign(el.style,frames[frames.length-1]);
    await pause(duration);
  }
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
    el.querySelector('.draw-caption').textContent=`抽到了${cardName(action.card)}`;
    await pause(duration*.18);
    if(!alive())return;
    const destination=(next.myId===action.actorId?app.querySelector('.hand-scroll'):
      [...app.querySelectorAll('[data-player-seat]')].find(node=>node.dataset.playerSeat===action.actorId))?.getBoundingClientRect();
    const tx=destination?destination.left+destination.width/2-(from.left+from.width/2):dx;
    const ty=destination?destination.top+destination.height/2-(from.top+from.height/2):dy;
    el.dataset.stage='returning';
    await animateBox(el,[{transform:center,opacity:1},{transform:`translate(${tx}px,${ty}px) scale(.85)`,opacity:.5}],duration*.22);
    if(!alive())return;
    el.remove();
    state.view=drawArrivalView(effect);render();
    app.querySelector(`.hand-scroll [data-card-id="${action.card.id}"]`)?.classList.add('drawn-card');
    await pause(duration*.10);
    if(!alive())return;
    if(action.paired&&action.pair?.length===2)await playPairEffect(action.pair,duration*.20);
    else await pause(duration*.20);
  } finally {el.remove();}
}
async function playPairEffect(pair,duration) {
  const el=document.createElement('div');
  el.className='pair-effect';el.setAttribute('role','status');
  el.innerHTML=`<strong>配对成功</strong><div class="pair-effect-cards">${pair.map(card=>playingCard(card,0,false)).join('')}</div>`;
  document.body.appendChild(el);
  pair.forEach(card=>app.querySelector(`.hand-scroll [data-card-id="${card.id}"]`)?.classList.add('pair-matching'));
  try {
    await animateBox(el,[{transform:'translate(-50%,-30%) scale(.8)',opacity:0},
      {transform:'translate(-50%,-50%) scale(1.08)',opacity:1,offset:.3},
      {transform:'translate(-50%,-90%) scale(.55)',opacity:0}],duration);
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

function render() {
  const targetOffset=app.querySelector('.target-list')?.scrollLeft||0;
  const handOffset=app.querySelector('.hand-scroll')?.scrollLeft||0;
  if(!state.view) app.innerHTML=landing();
  else if(state.view.phase==='lobby') app.innerHTML=roomView(state.view);
  else app.innerHTML=gameView(state.view);
  if(app.querySelector('.target-list')) app.querySelector('.target-list').scrollLeft=targetOffset;
  if(app.querySelector('.hand-scroll')) app.querySelector('.hand-scroll').scrollLeft=handOffset;
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
  if(['quick','create','join'].includes(type)) {state.form=type;render();return;}
  if(type==='home') {if(state.session) return handleUi('leave');state.form='home';render();return;}
  if(type==='copy') {
    try{await navigator.clipboard.writeText(state.session.code);notice('已复制房间号');}
    catch{notice(`房间号：${state.session.code}`);}return;
  }
  if(type==='leave') {
    if(state.session) {
      if(!confirm('确定离开当前牌桌吗？游戏中离开将由电脑托管。')) return;
      try{await sendAction('leave');}catch{}
    }
    clearSession();state.form='home';render();return;
  }
}
app.addEventListener('click',async event=> {
  const button=event.target.closest('[data-ui],[data-api],[data-slot]');if(!button||state.busy) return;
  if(button.dataset.ui) {await handleUi(button.dataset.ui);return;}
  if(button.hasAttribute('data-slot')) {
    if(!myTurn()) return;
    const slot=Number(button.dataset.slot);
    state.selected=state.selected===slot?null:slot;render();
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
  const data=Object.fromEntries(new FormData(form));localStorage.setItem('turtle-name',data.name);
  const type=form.dataset.form;
  const path=type==='quick'?'/api/quick':type==='create'?'/api/rooms':'/api/join';
  if(type==='join') data.code=String(data.code).trim();
  if(type==='create') data.capacity=Number(data.capacity);
  state.busy=true;
  try {const session=await request(path,data);activeSession(session);}
  catch(e){notice(e.message);}finally{state.busy=false;}
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
