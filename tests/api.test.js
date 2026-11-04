import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

async function unusedPort() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

async function startServer(options={}) {
  const port=await unusedPort();
  const dataDir=options.dataDir||await mkdtemp(join(tmpdir(),'turtle-v03-'));
  const child=spawn(process.execPath,['server/index.js'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'test',DATA_DIR:dataDir,
      DISCONNECT_GRACE_MS:'300',DRAW_ANIMATION_MS:'0',...options.env},
    stdio:'ignore'
  });
  const base=`http://127.0.0.1:${port}`;
  for(let attempt=0;attempt<90;attempt++) {
    try {const r=await fetch(`${base}/api/health`);if(r.ok)return {base,child,dataDir};}catch{}
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,35));
  }
  child.kill();throw new Error('服务器未启动');
}
async function stopServer(child) {
  if(child.exitCode!==null)return;
  const exited=once(child,'exit');
  child.kill('SIGTERM');
  await exited;
}
async function post(base,path,data,token=null,origin=null) {
  const headers={'content-type':'application/json'};
  if(token)headers.authorization=`Bearer ${token}`;
  if(origin)headers.origin=origin;
  const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(data)});
  return {status:response.status,data:await response.json(),headers:response.headers};
}
async function state(base,code,token) {
  const response=await fetch(`${base}/api/rooms/${code}/state`,{
    headers:{authorization:`Bearer ${token}`}});
  return {status:response.status,data:await response.json()};
}
async function action(base,session,type,props={}) {
  return post(base,`/api/rooms/${session.code}/action`,{
    type,requestId:randomUUID(),...props},session.token);
}

test('联机 API：创建、邀请、AI 补位、身份隔离、开始、重连与 SSE',async t=> {
  const {base,child}=await startServer();
  t.after(async()=>{await stopServer(child);});
  const create=await post(base,'/api/rooms',{name:'房主甲',capacity:4});
  assert.equal(create.status,200);
  const host=create.data;
  assert.match(host.code,/^[0-9]{6}$/);
  assert.equal((await state(base,host.code,'wrong-token')).status,403);
  const guestResult=await post(base,'/api/join',{name:'访客乙',code:host.code});
  assert.equal(guestResult.status,200);
  const guest=guestResult.data;
  const guestAgain=await post(base,'/api/join',{name:'访客乙',code:host.code});
  assert.equal(guestAgain.status,400);
  const addBot=await action(base,host,'add_bot');
  assert.equal(addBot.status,200);
  const before=(await state(base,host.code,host.token)).data;
  assert.equal(before.phase,'lobby');
  assert.equal(before.players.length,3);
  const notOwner=await action(base,guest,'start');
  assert.equal(notOwner.status,403);
  const start=await action(base,host,'start');
  assert.equal(start.status,200);
  const hostState=(await state(base,host.code,host.token)).data;
  const guestState=(await state(base,guest.code,guest.token)).data;
  assert.equal(hostState.phase,'playing');
  assert.equal(hostState.players.length,3);
  assert.equal(hostState.removed,null);
  assert.equal(hostState.lastCard,null);
  assert.ok(!('hand' in hostState.players.find(p=>p.id===guest.playerId)));
  assert.ok(!('hand' in guestState.players.find(p=>p.id===host.playerId)));
  const ownCardOfGuest=guestState.myHand[0]?.id;
  if(ownCardOfGuest) assert.ok(!JSON.stringify(hostState).includes(ownCardOfGuest),'其他玩家隐藏手牌不得出现在公开快照');
  const joinLate=await post(base,'/api/join',{name:'迟到玩家',code:host.code});
  assert.equal(joinLate.status,400);
  const targetId=hostState.targetPlayerId;
  const targetToken=targetId===host.playerId?host.token:targetId===guest.playerId?guest.token:null;
  if(targetToken) {
    const locked=await post(base,`/api/rooms/${host.code}/action`,{type:'shuffle',requestId:randomUUID()},targetToken);
    assert.equal(locked.status,400);
  }
  const eventRes=await fetch(`${base}/api/rooms/${host.code}/events`,{headers:{authorization:`Bearer ${host.token}`}});
  assert.equal(eventRes.status,200);
  assert.match(eventRes.headers.get('content-type'),/text\/event-stream/);
  const reader=eventRes.body.getReader();
  const first=await reader.read();
  assert.match(new TextDecoder().decode(first.value),/event: state/);
  await reader.cancel();
  const recent=(await state(base,host.code,host.token)).data;
  assert.ok(['playing','finished'].includes(recent.phase));
});

test('快速开始：自动加入三名 AI，支持房间重连',async t=> {
  const {base,child}=await startServer();t.after(async()=>{await stopServer(child);});
  const quick=await post(base,'/api/quick',{name:'单人玩家'});
  assert.equal(quick.status,200);
  const v=(await state(base,quick.data.code,quick.data.token)).data;
  assert.equal(v.phase,'playing');
  assert.equal(v.players.length,4);
  assert.equal(v.players.filter(p=>p.bot).length,3);
  assert.equal(v.players.filter(p=>!p.bot).length,1);
});

test('真实双客户端 API：轮流抽牌、独立手牌、公共事件与最终结算一致',async t=> {
  const {base,child}=await startServer();t.after(async()=>{await stopServer(child);});
  const host=(await post(base,'/api/rooms',{name:'电脑端',capacity:2})).data;
  const guest=(await post(base,'/api/join',{name:'手机端',code:host.code})).data;
  assert.equal((await action(base,host,'start')).status,200);
  const tokens=new Map([[host.playerId,host.token],[guest.playerId,guest.token]]);
  const endpoint=`/api/rooms/${host.code}/action`;
  let movements=0, sawUnpaired=false, sawPair=false;
  for(let i=0;i<850;i++) {
    const a=(await state(base,host.code,host.token)).data;
    const b=(await state(base,host.code,guest.token)).data;
    assert.equal(a.turn,b.turn);
    assert.equal(a.phase,b.phase);
    assert.deepEqual(a.players.map(p=>p.count),b.players.map(p=>p.count));
    if(a.phase==='finished') {
      assert.equal(a.pairs.length,25);
      assert.equal(a.removed.rank,a.lastCard.rank);
      assert.equal(b.removed.id,a.removed.id);
      assert.equal(a.loserId,b.loserId);
      break;
    }
    assert.equal(a.phase,'playing');
    const actorToken=tokens.get(a.currentPlayerId);
    const actor=a.currentPlayerId===host.playerId?a:b;
    const targetSize=actor.targetSlots.length;
    assert.ok(targetSize>0);
    const response=await post(base,endpoint,{type:'draw',requestId:randomUUID(),turn:actor.turn,slot:i%targetSize},actorToken);
    assert.equal(response.status,200,JSON.stringify(response.data));
    movements++;
    const after=(await state(base,host.code,host.token)).data;
    const action=after.lastAction?.kind==='finished'?after.lastAction.finalDraw:after.lastAction;
    assert.equal(action?.kind,'draw');
    assert.equal(action?.slot,i%targetSize);
    assert.equal(typeof action?.id,'number');
    sawUnpaired ||= action.paired===false;
    sawPair ||= action.paired===true;
    if(!action.paired) {
      const opponent=a.currentPlayerId===host.playerId?guest:host;
      const blind=(await state(base,host.code,opponent.token)).data;
      assert.equal(typeof blind.lastAction.card?.id,'string');
      assert.equal(blind.lastAction?.kind==='finished'?blind.lastAction.finalDraw.pair:blind.lastAction.pair,null);
    }
    if(after.phase==='finished') {
      assert.equal(after.pairs.length,25);
      break;
    }
  }
  // Fully paired draws are possible; do not assume any particular random deal.
  if(movements) assert.equal(sawPair || sawUnpaired,true);
  const final=(await state(base,host.code,host.token)).data;
  assert.equal(final.phase,'finished');
  assert.equal(final.pairs.length,25);
});

test('v0.3：会话凭证不进入 URL 或磁盘明文，安全响应头与跨站拦截生效', async t => {
  const {base,child,dataDir}=await startServer();
  t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});
  const create=await post(base,'/api/rooms',{name:'安全测试',capacity:2});
  assert.equal(create.status,200);
  const session=create.data;
  assert.equal((await fetch(`${base}/api/rooms/${session.code}/state?token=${session.token}`)).status,403);
  const good=await state(base,session.code,session.token);
  assert.equal(good.status,200);
  assert.ok(!JSON.stringify(good.data).includes(session.token));
  const snapshot=await readFile(join(dataDir,'rooms.json'),'utf8');
  assert.ok(snapshot.includes('tokenHash'));
  assert.ok(!snapshot.includes(session.token),'持久化文件不能包含恢复凭证原文');
  const page=await fetch(base+'/');
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  const attack=await post(base,'/api/rooms',{name:'跨站伪造',capacity:2},null,'https://other.example');
  assert.equal(attack.status,403);
  const wrong=await post(base,`/api/rooms/${session.code}/action`,
    {type:'add_bot',requestId:randomUUID()},'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(wrong.status,403);
});

test('v0.3：重复抽牌操作幂等，重复提交不额外抽牌，参数冲突拒绝', async t => {
  const {base,child,dataDir}=await startServer();
  t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});
  const host=(await post(base,'/api/rooms',{name:'房主',capacity:2})).data;
  const guest=(await post(base,'/api/join',{name:'访客',code:host.code})).data;
  assert.equal((await action(base,host,'start')).status,200);
  const before=(await state(base,host.code,host.token)).data;
  const actor=before.currentPlayerId===host.playerId?host:guest;
  const requestId=randomUUID();
  const payload={type:'draw',requestId,turn:before.turn,slot:0};
  const url=`/api/rooms/${host.code}/action`;
  const first=await post(base,url,payload,actor.token);
  assert.equal(first.status,200);
  const after=(await state(base,host.code,host.token)).data;
  assert.equal(after.turn,before.turn+1);
  const duplicate=await post(base,url,payload,actor.token);
  assert.equal(duplicate.status,200);
  assert.equal(duplicate.data.duplicate,true);
  const unchanged=(await state(base,host.code,host.token)).data;
  assert.equal(unchanged.turn,after.turn);
  assert.equal(unchanged.revision,after.revision);
  const conflict=await post(base,url,{...payload,slot:1},actor.token);
  assert.equal(conflict.status,409);
  const stale=await post(base,url,{...payload,requestId:randomUUID()},actor.token);
  assert.equal(stale.status,409);
});

test('v0.3：进程重启后可恢复玩家身份、手牌、回合和幂等记录', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'turtle-restart-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const first=await startServer({dataDir});
  const host=(await post(first.base,'/api/rooms',{name:'PC',capacity:2})).data;
  const guest=(await post(first.base,'/api/join',{name:'手机',code:host.code})).data;
  assert.equal((await action(first.base,host,'start')).status,200);
  const before=(await state(first.base,host.code,host.token)).data;
  const actor=before.currentPlayerId===host.playerId?host:guest;
  const move={type:'draw',requestId:randomUUID(),turn:before.turn,slot:0};
  assert.equal((await post(first.base,`/api/rooms/${host.code}/action`,move,actor.token)).status,200);
  const a=(await state(first.base,host.code,host.token)).data;
  const b=(await state(first.base,guest.code,guest.token)).data;
  await stopServer(first.child);
  const next=await startServer({dataDir});
  t.after(()=>stopServer(next.child));
  const restoredA=(await state(next.base,host.code,host.token)).data;
  const restoredB=(await state(next.base,guest.code,guest.token)).data;
  assert.equal(restoredA.round,a.round);
  assert.equal(restoredA.turn,a.turn);
  assert.deepEqual(restoredA.myHand,a.myHand);
  assert.deepEqual(restoredB.myHand,b.myHand);
  assert.deepEqual(restoredA.pairs,a.pairs);
  assert.equal(restoredA.currentPlayerId,a.currentPlayerId);
  assert.equal(restoredA.revision,a.revision);
  const retry=await post(next.base,`/api/rooms/${host.code}/action`,move,actor.token);
  assert.equal(retry.status,200);
  assert.equal(retry.data.duplicate,true);
  const viewAfterRetry=(await state(next.base,host.code,host.token)).data;
  assert.equal(viewAfterRetry.turn,a.turn);
  assert.ok(!('hand' in viewAfterRetry.players.find(p=>p.id===guest.playerId)));
  const resp=await fetch(`${next.base}/api/rooms/${host.code}/events`,
    {headers:{authorization:`Bearer ${host.token}`}});
  assert.equal(resp.status,200);
  await resp.body.cancel();
});

test('v0.3：SSE 掉线超时托管、重连自动解除且保持连续版本号', async t => {
  const {base,child,dataDir}=await startServer();
  t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});
  const host=(await post(base,'/api/rooms',{name:'掉线玩家',capacity:2})).data;
  const guest=(await post(base,'/api/join',{name:'对方玩家',code:host.code})).data;
  await action(base,host,'start');
  const initial=(await state(base,host.code,host.token)).data;
  const controller=new AbortController();
  const response=await fetch(`${base}/api/rooms/${host.code}/events`,{
    headers:{authorization:`Bearer ${host.token}`},signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader();
  const first=await reader.read();
  assert.match(new TextDecoder().decode(first.value),/event: state/);
  assert.match(new TextDecoder().decode(first.value),/id: \d+/);
  controller.abort();
  await waitFor(async()=>{
    const view=(await state(base,host.code,guest.token)).data;
    return view.players.find(p=>p.id===host.playerId).autoplay;
  },2000);
  const lost=(await state(base,host.code,guest.token)).data;
  assert.equal(lost.players.find(p=>p.id===host.playerId).autoplay,true);
  assert.ok(lost.revision>initial.revision);
  const recovered=await fetch(`${base}/api/rooms/${host.code}/events`,{
    headers:{authorization:`Bearer ${host.token}`}});
  assert.equal(recovered.status,200);
  const latest=(await state(base,host.code,guest.token)).data;
  assert.equal(latest.players.find(p=>p.id===host.playerId).autoplay,false);
  assert.ok(latest.revision>lost.revision);
  await recovered.body.cancel();
});

async function waitFor(fn,timeout=2000) {
  const start=Date.now();
  while(Date.now()-start<timeout) {
    if(await fn())return;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  throw new Error('等待异步条件超时');
}

test('v0.3：创建房间限流与请求体积限制生效', async t => {
  const {base,child,dataDir}=await startServer();
  t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});
  const tooLarge=await post(base,'/api/rooms',{name:'X'.repeat(10000),capacity:4});
  assert.equal(tooLarge.status,413);
  let limit=0;
  for(let i=0;i<14;i++) {
    const r=await post(base,'/api/rooms',{name:'测验'+i,capacity:2});
    if(r.status===429)limit++;
  }
  assert.ok(limit>=2);
});

test('v0.3：主动离开立即撤销旧凭证，并由剩余真人继任房主', async t => {
  const {base,child,dataDir}=await startServer();
  t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});
  const host=(await post(base,'/api/rooms',{name:'原房主',capacity:3})).data;
  const guest=(await post(base,'/api/join',{name:'继任者',code:host.code})).data;
  assert.equal((await action(base,host,'add_bot')).status,200);
  assert.equal((await action(base,host,'start')).status,200);
  const stream=await fetch(`${base}/api/rooms/${host.code}/events`,
    {headers:{authorization:`Bearer ${host.token}`}});
  assert.equal(stream.status,200);
  assert.equal((await action(base,host,'leave')).status,200);
  assert.equal((await state(base,host.code,host.token)).status,403);
  const other=(await state(base,guest.code,guest.token)).data;
  assert.equal(other.ownerId,guest.playerId);
  assert.equal(other.players.find(p=>p.id===host.playerId).autoplay,true);
  assert.ok(!('hand' in other.players.find(p=>p.id===host.playerId)));
  await stream.body.cancel().catch(()=>{});
});

test('六位数字房间号、跨玩家选牌预览与展示期间操作保护',async t=>{
  const {base,child,dataDir}=await startServer({env:{DRAW_ANIMATION_MS:'2000'}});
  t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});
  const host=(await post(base,'/api/rooms',{name:'选牌者',capacity:3})).data;
  assert.match(host.code,/^[0-9]{6}$/);
  const guest=(await post(base,'/api/join',{name:'被抽者',code:host.code})).data;
  const observer=(await post(base,'/api/join',{name:'旁观者',code:host.code})).data;
  await action(base,host,'start');
  const initial=(await state(base,host.code,host.token)).data;
  if(initial.phase==='finished')return;
  const sessions=[host,guest,observer];
  const actor=sessions.find(s=>s.playerId===initial.currentPlayerId);
  const target=sessions.find(s=>s.playerId===initial.targetPlayerId);
  assert.equal((await action(base,target,'select',{slot:0,turn:initial.turn})).status,400);
  assert.equal((await action(base,actor,'select',{slot:999,turn:initial.turn})).status,400);
  assert.equal((await action(base,actor,'select',{slot:0,turn:initial.turn-1})).status,409);
  assert.equal((await action(base,actor,'select',{slot:0,turn:initial.turn})).status,200);
  const preview=(await state(base,host.code,target.token)).data;
  assert.deepEqual(preview.selection,{actorId:actor.playerId,targetId:target.playerId,slot:0,turn:initial.turn});
  assert.ok(!('card' in preview.selection));
  assert.equal(preview.deadline,initial.deadline);
  const drawn=preview.myHand[0];
  assert.equal((await action(base,actor,'select',{slot:null,turn:initial.turn})).status,200);
  assert.equal((await state(base,host.code,target.token)).data.selection,null);
  assert.equal((await action(base,actor,'draw',{slot:0,turn:initial.turn})).status,200);
  for(const s of sessions){
    const v=(await state(base,host.code,s.token)).data;
    const draw=v.lastAction.kind==='finished'?v.lastAction.finalDraw:v.lastAction;
    assert.deepEqual(draw.card,drawn);
    assert.equal(v.selection,null);
    assert.equal(draw.animationMs,2000);
    if(v.phase==='playing'){
      const next=sessions.find(s=>s.playerId===v.currentPlayerId);
      assert.equal((await action(base,next,'select',{slot:0,turn:v.turn})).status,409);
    }
  }
});
