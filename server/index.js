import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  startGame, drawCard, shuffleHand, moveCard, publicView, decideAiSlot, shouldAiShuffle
} from './engine.js';
import { SnapshotStore } from './store.js';
import { SlidingLimiter } from './rate-limit.js';

const ROOT=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const PORT=Number(process.env.PORT || 3000);
const HOST=process.env.HOST || '127.0.0.1';
const TRUST_PROXY=process.env.TRUST_PROXY==='1';
const TURN_MS=Math.max(200,Number(process.env.TURN_MS || 30000));
const DISCONNECT_GRACE_MS=Math.max(100,Number(process.env.DISCONNECT_GRACE_MS || 5000));
const ROOM_LIMIT=Number(process.env.MAX_ROOMS || 300);
const STREAM_LIMIT=Number(process.env.MAX_STREAMS || 300);
const ROOM_ALPHABET='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const securityHeaders={
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':"default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
};
const store=new SnapshotStore();
const limiter=new SlidingLimiter();
let rooms=new Map();
let shuttingDown=false;

function fail(message,status=400){const error=new Error(message);error.status=status;throw error;}
function json(res,status,data,headers={}) {
  const output=JSON.stringify(data);
  res.writeHead(status,{...securityHeaders,'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(output),'Cache-Control':'no-store',...headers});
  res.end(output);
}
async function body(req) {
  const size=Number(req.headers['content-length']);
  if(Number.isFinite(size)&&size>8192) fail('请求数据过大',413);
  const chunks=[];let bytes=0;
  for await (const chunk of req) {
    bytes+=chunk.length;
    if(bytes>8192) fail('请求数据过大',413);
    chunks.push(chunk);
  }
  try {
    const parsed=bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) fail('数据格式错误');
    return parsed;
  }catch(err){if(err.status)throw err;fail('请求数据不是有效 JSON');}
}
function nick(value) {
  if(typeof value!=='string') fail('请填写昵称');
  const name=value.replace(/[\x00-\x1F\x7F<>]/g,'').trim().slice(0,16);
  if(!name)fail('请填写昵称');
  return name;
}
function freshToken(){return randomBytes(24).toString('base64url');}
function digest(value){return createHash('sha256').update(value).digest('hex');}
function verifyToken(hash,received){
  if(typeof received!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(received)||!hash)return false;
  return timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(digest(received),'hex'));
}
function bearer(req) {
  const header=req.headers.authorization;
  const match=typeof header==='string' && header.match(/^Bearer ([A-Za-z0-9_-]{32})$/);
  return match?.[1] || null;
}
function newCode(){
  for(let j=0;j<100;j++) {
    let candidate='';for(let i=0;i<6;i++)candidate+=ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
    if(!rooms.has(candidate))return candidate;
  }
  fail('房间暂时无法创建',503);
}
function newPlayer(name,bot=false) {
  const credential=bot?null:freshToken();
  return {player:{id:randomUUID(),tokenHash:credential?digest(credential):null,
    name,bot,autoplay:false,hand:[]},credential};
}
function newRoom(name,capacity=4) {
  if(!Number.isInteger(capacity)||capacity<2||capacity>6)fail('房间人数只能是 2～6 人');
  if(rooms.size>=ROOM_LIMIT)fail('房间数量已达上限，请稍后重试',503);
  const {player,credential}=newPlayer(nick(name));
  const room={code:newCode(),capacity,ownerId:player.id,players:[player],phase:'lobby',
    round:0,turn:0,pairs:[],escaped:[],loserId:null,removed:null,lastAction:null,
    currentPlayerId:null,targetPlayerId:null,deadline:null,memory:new Map(),
    recentOps:new Map(),revision:0,actionId:0,drawHistory:[],
    clients:new Set(),disconnectTimers:new Map(),lastActive:Date.now(),turnTimer:null,aiTimer:null};
  rooms.set(room.code,room);
  return {room,player,credential};
}
function getRoom(roomCode){
  const room=rooms.get(String(roomCode||'').toUpperCase());
  if(!room)fail('房间不存在或已过期',404);
  room.lastActive=Date.now();return room;
}
function auth(room,received) {
  const player=room.players.find(p=>!p.bot&&verifyToken(p.tokenHash,received));
  if(!player)fail('身份凭证无效，请恢复原会话或重新加入',403);
  return player;
}
function onlyOwner(room,id){if(room.ownerId!==id)fail('只有房主可以操作',403);}
function createBot(room) {
  if(room.phase!=='lobby')fail('只能在等待房间中调整 AI');
  if(room.players.length>=room.capacity)fail('房间人数已满');
  const options=['阿龟','小圆','机灵鬼','桃桃','方块君','纸牌侠'];
  const used=new Set(room.players.map(p=>p.name));
  room.players.push(newPlayer(options.find(name=>!used.has(name)) || `AI ${room.players.length}`,true).player);
}
function wireView(room,player){return publicView(room,player.id);}
function sseMessage(room,player){
  return `id: ${room.revision}\nevent: state\ndata: ${JSON.stringify(wireView(room,player))}\n\n`;
}
function broadcast(room) {
  room.revision=(room.revision||0)+1;
  room.lastActive=Date.now();
  for(const client of [...room.clients]) {
    if(client.res.destroyed||client.res.writableEnded) {room.clients.delete(client);continue;}
    try {
      if(!client.res.write(sseMessage(room,client.player)) && client.res.writableLength>256*1024) {
        client.res.destroy();room.clients.delete(client);
      }
    }catch{room.clients.delete(client);client.res.destroy();}
  }
  store.mark(rooms);
}
function clearTimers(room){
  if(room.turnTimer)clearTimeout(room.turnTimer);
  if(room.aiTimer)clearTimeout(room.aiTimer);
  room.turnTimer=null;room.aiTimer=null;
  if(room.resumeTimer){clearTimeout(room.resumeTimer);room.resumeTimer=null;}
}
function setDeadline(room){if(room.phase==='playing')room.deadline=Date.now()+TURN_MS;}
function performDraw(room,actorId,slot) {
  drawCard(room,actorId,slot);
  setDeadline(room);
  broadcast(room);
  scheduleTurn(room);
}
function scheduleTurn(room) {
  clearTimers(room);
  if(room.phase!=='playing')return;
  const actor=room.players.find(p=>p.id===room.currentPlayerId);
  if(!actor)return;
  const remaining=Math.max(0,room.deadline-Date.now());
  const currentTurn=room.turn;
  room.turnTimer=setTimeout(()=>{
    if(room.phase!=='playing'||room.currentPlayerId!==actor.id||room.turn!==currentTurn)return;
    const target=room.players.find(p=>p.id===room.targetPlayerId);
    if(target?.hand.length)performDraw(room,actor.id,randomInt(target.hand.length));
  },remaining);
  room.turnTimer.unref();
  if(actor.bot||actor.autoplay) {
    const delay=Math.min(remaining,550+randomInt(650));
    room.aiTimer=setTimeout(()=>{
      if(room.phase!=='playing'||room.currentPlayerId!==actor.id||room.turn!==currentTurn)return;
      if(actor.bot&&actor.aiShuffleCheckedTurn!==currentTurn) {
        actor.aiShuffleCheckedTurn=currentTurn;
        if(shouldAiShuffle(room,actor.id)) {
          shuffleHand(room,actor.id);broadcast(room);
          room.aiTimer=setTimeout(()=>{
            if(room.phase==='playing'&&room.currentPlayerId===actor.id&&room.turn===currentTurn) {
              performDraw(room,actor.id,decideAiSlot(room,actor.id));
            }
          },380);room.aiTimer.unref();return;
        }
      }
      // Disconnected humans receive a fair random draw; AI uses only its legal observation.
      const target=room.players.find(p=>p.id===room.targetPlayerId);
      const slot=actor.bot?decideAiSlot(room,actor.id):randomInt(target.hand.length);
      performDraw(room,actor.id,slot);
    },delay);room.aiTimer.unref();
  }
}
function session(room,player,credential){return {code:room.code,token:credential,playerId:player.id};}
function closeRoom(room) {
  clearTimers(room);
  for(const timer of room.disconnectTimers.values())clearTimeout(timer);
  room.disconnectTimers.clear();
  for(const client of room.clients){try{client.res.end();}catch{}}
  room.clients.clear();rooms.delete(room.code);store.mark(rooms);
}
function closePlayerStreams(room,human) {
  for(const client of [...room.clients]) {
    if(client.player.id===human.id) {
      room.clients.delete(client);
      client.res.end();
    }
  }
  const timer=room.disconnectTimers.get(human.id);
  if(timer){clearTimeout(timer);room.disconnectTimers.delete(human.id);}
}
function leaveLobby(room,human) {
  room.players=room.players.filter(p=>p.id!==human.id);
  if(room.ownerId===human.id)room.ownerId=room.players.find(p=>!p.bot)?.id||null;
  if(!room.players.some(p=>!p.bot && p.tokenHash)){closeRoom(room);return;}
  broadcast(room);
}
function connectEvents(req,res,room,player) {
  const currentStreams=[...room.clients].filter(c=>c.player.id===player.id);
  while(currentStreams.length>=2) {
    const oldest=currentStreams.shift();oldest.res.end();room.clients.delete(oldest);
  }
  const total=[...rooms.values()].reduce((n,r)=>n+r.clients.size,0);
  if(total>=STREAM_LIMIT)fail('实时连接数已达上限，请稍后重试',503);
  res.writeHead(200,{...securityHeaders,'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.write(': connected\n\n');
  const client={res,player};room.clients.add(client);
  const delayed=room.disconnectTimers.get(player.id);
  if(delayed){clearTimeout(delayed);room.disconnectTimers.delete(player.id);}
  const recovered=player.autoplay;
  if(recovered){player.autoplay=false;broadcast(room);scheduleTurn(room);}
  else res.write(sseMessage(room,player));
  const heartbeat=setInterval(()=>{
    try{res.write(': ping\n\n');}catch{res.destroy();}
  },15000);heartbeat.unref();
  res.on('close',()=>{
    clearInterval(heartbeat);room.clients.delete(client);
    if(!rooms.has(room.code) || !room.players.includes(player) || !player.tokenHash)return;
    if(room.disconnectTimers.has(player.id))clearTimeout(room.disconnectTimers.get(player.id));
    const timer=setTimeout(()=>{
      room.disconnectTimers.delete(player.id);
      if(room.phase!=='playing')return;
      if([...room.clients].some(c=>c.player.id===player.id))return;
      if(player.tokenHash) {
        player.autoplay=true;
        broadcast(room);scheduleTurn(room);
      }
    },DISCONNECT_GRACE_MS);
    timer.unref();room.disconnectTimers.set(player.id,timer);
  });
}
function originCheck(req) {
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return;
  if(req.headers['sec-fetch-site']==='cross-site')fail('禁止跨站请求',403);
  if(!req.headers.origin)return;
  const host=req.headers.host;
  const forwarded=TRUST_PROXY && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const proto=forwarded && req.headers['x-forwarded-proto']==='https'?'https':'http';
  const expected=`${proto}://${host}`;
  if(req.headers.origin!==expected)fail('请求来源不匹配',403);
}
function ipOf(req){
  const socketIp=req.socket.remoteAddress||'unknown';
  if(TRUST_PROXY&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(socketIp)) {
    return String(req.headers['x-real-ip']||socketIp).slice(0,64);
  }
  return socketIp;
}
function throttle(req,route) {
  const ip=ipOf(req);
  const allowance=route==='create'?12:route==='join'?30:route==='events'?50:120;
  if(!limiter.check(`${route}:${ip}`,allowance))fail('操作过于频繁，请稍后再试',429);
}
function requestSignature(data) {
  const {requestId,token,...action}=data;
  return digest(JSON.stringify(action));
}
function checkRequestId(data) {
  if(typeof data.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(data.requestId))
    fail('缺少有效操作编号');
}
async function api(req,res,url) {
  if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:!store.lastError,version:'0.3.0'});
  if(req.method==='POST'&&url.pathname==='/api/quick') {
    throttle(req,'create');const data=await body(req);
    const {room,player,credential}=newRoom(data.name,4);
    while(room.players.length<4)createBot(room);
    startGame(room);setDeadline(room);scheduleTurn(room);broadcast(room);
    await store.flush();
    return json(res,200,session(room,player,credential));
  }
  if(req.method==='POST'&&url.pathname==='/api/rooms') {
    throttle(req,'create');const data=await body(req);
    const {room,player,credential}=newRoom(data.name,data.capacity??4);
    broadcast(room);await store.flush();
    return json(res,200,session(room,player,credential));
  }
  if(req.method==='POST'&&url.pathname==='/api/join') {
    throttle(req,'join');const data=await body(req);
    const room=getRoom(data.code);
    if(room.phase!=='lobby')fail('游戏已开始，只允许原玩家恢复连接');
    if(room.players.length>=room.capacity)fail('房间人数已满');
    const name=nick(data.name);
    if(room.players.some(p=>p.name.toLocaleLowerCase()===name.toLocaleLowerCase()))fail('昵称已被使用');
    const {player,credential}=newPlayer(name);
    room.players.push(player);broadcast(room);await store.flush();
    return json(res,200,session(room,player,credential));
  }
  const match=url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/(state|events|action)$/);
  if(!match)fail('未找到接口',404);
  throttle(req,match[2]);
  const room=getRoom(match[1]);
  const human=auth(room,bearer(req));
  if(req.method==='GET'&&match[2]==='state')return json(res,200,wireView(room,human));
  if(req.method==='GET'&&match[2]==='events')return connectEvents(req,res,room,human);
  if(req.method!=='POST'||match[2]!=='action')fail('不支持此操作',405);
  const data=await body(req);
  checkRequestId(data);
  const opKey=`${human.id}:${data.requestId}`;
  const signature=requestSignature(data);
  const previous=room.recentOps.get(opKey);
  if(previous) {
    if(previous!==signature)fail('操作编号与历史内容冲突',409);
    return json(res,200,{ok:true,duplicate:true,revision:room.revision});
  }
  if(!limiter.check(`action-player:${human.id}`,90))fail('操作过于频繁，请稍后再试',429);
  switch(data.type) {
    case 'add_bot':onlyOwner(room,human.id);createBot(room);break;
    case 'remove_bot':{
      onlyOwner(room,human.id);
      if(room.phase!=='lobby')fail('游戏开始后不能移除 AI');
      const bot=room.players.find(p=>p.id===data.botId&&p.bot);
      if(!bot)fail('未找到 AI 玩家');
      room.players=room.players.filter(p=>p.id!==bot.id);break;
    }
    case 'start':onlyOwner(room,human.id);startGame(room);setDeadline(room);scheduleTurn(room);break;
    case 'rematch':{
      onlyOwner(room,human.id);
      if(room.phase!=='finished')fail('本局尚未结束');
      startGame(room);setDeadline(room);scheduleTurn(room);break;
    }
    case 'shuffle':shuffleHand(room,human.id);break;
    case 'move':moveCard(room,human.id,data.from,data.to);break;
    case 'draw':{
      if(data.turn!==room.turn)fail('当前回合已变化，请重新选择',409);
      if(human.autoplay)fail('当前处于托管状态，请先恢复连接',409);
      performDraw(room,human.id,data.slot);break;
    }
    case 'leave':{
      closePlayerStreams(room,human);
      if(room.phase==='lobby') leaveLobby(room,human);
      else {
        human.autoplay=true;human.tokenHash=null; // A deliberate exit revokes recovery credentials.
        if(room.ownerId===human.id) {
          room.ownerId=room.players.find(p=>!p.bot&&p.id!==human.id&&p.tokenHash)?.id||null;
        }
        if(!room.players.some(p=>!p.bot&&p.tokenHash))closeRoom(room);
        else {broadcast(room);scheduleTurn(room);}
      }
      break;
    }
    default:fail('未知操作');
  }
  if(rooms.has(room.code)) {
    room.recentOps.set(opKey,signature);
    if(room.recentOps.size>160)room.recentOps.delete(room.recentOps.keys().next().value);
    if(data.type!=='draw'&&data.type!=='leave')broadcast(room);
    store.mark(rooms);
  }
  // An acknowledged user action must survive a clean process restart.
  await store.flush();
  return json(res,200,{ok:true,revision:room.revision});
}
async function staticFile(req,res,url) {
  if(req.method!=='GET'&&req.method!=='HEAD')fail('不支持此操作',405);
  const path=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
  const filename=resolve(ROOT,`.${path}`);
  if(filename!==ROOT&&!filename.startsWith(ROOT+sep))fail('拒绝访问',403);
  try {
    if(!(await stat(filename)).isFile())fail('文件不存在',404);
    const bytes=await readFile(filename);
    const headers={...securityHeaders,'Content-Type':mime[extname(filename)]||'application/octet-stream',
      'Content-Length':bytes.length,'Cache-Control':extname(filename)==='.html'?'no-store':'no-cache, must-revalidate'};
    res.writeHead(200,headers);
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch(err){if(err.code==='ENOENT')fail('文件不存在',404);throw err;}
}
const server=http.createServer(async(req,res)=>{
  try {
    if(shuttingDown)fail('服务器正在重启，请稍后重试',503);
    originCheck(req);
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/'))await api(req,res,url);
    else await staticFile(req,res,url);
  }catch(err) {
    if(!res.headersSent)json(res,err.status||500,{error:err.status?err.message:'服务器暂时不可用'});
    else res.end();
    if(!err.status&&process.env.NODE_ENV!=='test')console.error(err);
  }
});
server.requestTimeout=15000;
server.headersTimeout=10000;
server.keepAliveTimeout=10000;
server.maxRequestsPerSocket=200;
server.on('clientError',(err,socket)=>{
  if(!socket.destroyed)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
const cleaner=setInterval(()=>{
  for(const room of rooms.values()) {
    const age=Date.now()-room.lastActive;
    const ttl=room.phase==='playing'?24*60*60*1000:room.phase==='lobby'?60*60*1000:3*60*60*1000;
    if(age>ttl&&room.clients.size===0)closeRoom(room);
  }
  limiter.cleanup();
},60000);cleaner.unref();
async function closeGracefully() {
  if(shuttingDown)return;shuttingDown=true;
  clearInterval(cleaner);
  for(const room of rooms.values()) {
    clearTimers(room);
    for(const client of room.clients)client.res.end();
  }
  try {await store.flush();}
  catch(err){console.error('停止前保存房间失败:',err);process.exitCode=1;}
  server.close(()=>process.exit());
  server.closeAllConnections();
  setTimeout(()=>process.exit(process.exitCode||0),3000).unref();
}
process.on('SIGINT',closeGracefully);
process.on('SIGTERM',closeGracefully);
try {
  rooms=await store.load();
  // Purge abandoned rooms; never publish or reset secrets during recovery.
  for(const room of rooms.values()) {
    const age=Date.now()-(room.lastActive||0);
    const ttl=room.phase==='playing'?24*60*60*1000:room.phase==='lobby'?60*60*1000:3*60*60*1000;
    if(age>ttl||!room.players.some(p=>!p.bot&&p.tokenHash))rooms.delete(room.code);
    else if(room.phase==='playing') {
      room.deadline=Date.now()+TURN_MS;
      // Give browsers a short reconnect window before resumed disconnected-player
      // autopilot starts. No new cards are dealt and the turn is unchanged.
      room.resumeTimer=setTimeout(()=>{
        room.resumeTimer=null;
        if(rooms.has(room.code))scheduleTurn(room);
      },Math.min(5000,TURN_MS));
      room.resumeTimer.unref();
    }
  }
  if(rooms.size)store.mark(rooms);
  server.listen(PORT,HOST,()=>console.log(`抽乌龟 v0.3 已启动：http://${HOST}:${PORT}，恢复房间 ${rooms.size} 个`));
}catch(err){console.error('无法读取房间快照，服务拒绝启动以免丢失对局:',err.message);process.exitCode=1;}
