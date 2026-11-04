import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const FIELDS = [
  'code', 'capacity', 'ownerId', 'players', 'phase', 'round', 'turn', 'pairs',
  'escaped', 'loserId', 'removed', 'lastAction', 'currentPlayerId',
  'targetPlayerId', 'deadline', 'lastActive', 'revision', 'actionId',
  'drawHistory'
];

export function encodeRooms(rooms) {
  const data = [...rooms.values()].map(room => {
    const result = Object.fromEntries(FIELDS.map(field => [field, room[field] ?? null]));
    result.memory = [...(room.memory || new Map())].map(([observer, targets]) => [observer, [...targets]]);
    result.recentOps = [...(room.recentOps || new Map())].slice(-160);
    result.players = room.players.map(player => ({
      id:player.id, tokenHash:player.tokenHash ?? null, name:player.name,
      bot:player.bot, autoplay:player.autoplay, hand:player.hand,
      aiShuffleCheckedTurn:player.aiShuffleCheckedTurn ?? null
    }));
    return result;
  });
  return JSON.stringify({format:VERSION, savedAt:Date.now(), rooms:data});
}

export function decodeRooms(contents) {
  const snapshot = JSON.parse(contents);
  if (snapshot?.format !== VERSION || !Array.isArray(snapshot.rooms)) throw new Error('房间快照格式不受支持');
  const rooms = new Map();
  for (const data of snapshot.rooms) {
    if (!data || !/^(?:[0-9]{6}|[A-Z2-9]{6})$/.test(data.code) ||
      !Number.isInteger(data.capacity) || data.capacity < 2 || data.capacity > 6 ||
      !Array.isArray(data.players) || data.players.length < 1 || data.players.length > data.capacity ||
      !['lobby','playing','finished'].includes(data.phase) ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 || rooms.has(data.code)) {
      throw new Error('房间快照包含无效元数据');
    }
    for (const player of data.players) {
      if (typeof player.id !== 'string' || typeof player.name !== 'string' ||
        typeof player.bot !== 'boolean' || !Array.isArray(player.hand) ||
        (!player.bot && player.tokenHash != null && !/^[a-f0-9]{64}$/.test(player.tokenHash))) {
        throw new Error('房间快照包含无效玩家信息');
      }
    }
    if (data.phase !== 'lobby') {
      const cards = [...data.players.flatMap(p=>p.hand),
        ...(data.pairs || []).flatMap(p=>p.cards), data.removed];
      if (cards.length !== 52 || new Set(cards.map(c=>c?.id)).size !== 52 ||
          !cards.every(c=>c && /^[SHCD]-(?:A|[2-9]|10|J|Q|K)$/.test(c.id) &&
            c.id === `${c.suit}-${c.rank}`)) {
        throw new Error('房间快照牌组校验失败');
      }
      if (data.phase === 'finished' && (data.pairs.length !== 25 ||
          data.players.reduce((n,p)=>n+p.hand.length,0) !== 1)) {
        throw new Error('结束房间的牌组校验失败');
      }
    }
    const memory = new Map((data.memory || []).map(([id, entries]) => [id, new Map(entries)]));
    const room = {...data, memory, recentOps:new Map(data.recentOps || []),
      clients:new Set(), disconnectTimers:new Map(), turnTimer:null, aiTimer:null,
      selection:null, animationUntil:0};
    // A process restart drops sockets, not the room or credentials. Reconnecting
    // the original identity stops the temporary bot takeover.
    for (const player of room.players) if (!player.bot) player.autoplay = true;
    if (room.phase === 'playing') room.deadline = Date.now() + 30000;
    rooms.set(room.code, room);
  }
  return rooms;
}

export class SnapshotStore {
  constructor(dataDir = process.env.DATA_DIR || resolve('data')) {
    this.dir=resolve(dataDir);
    this.path=join(this.dir,'rooms.json');
    this.chain=Promise.resolve();
    this.dirty=false;
    this.timer=null;
    this.rooms=null;
    this.lastError=null;
  }
  async load() {
    await mkdir(this.dir,{recursive:true,mode:0o700});
    try {return decodeRooms(await readFile(this.path,'utf8'));}
    catch (err) {if (err.code==='ENOENT') return new Map(); throw err;}
  }
  mark(rooms) {
    this.rooms=rooms;this.dirty=true;
    if (!this.timer) {
      this.timer=setTimeout(()=>{
        this.timer=null;this.flush().catch(err=>console.error('房间快照保存失败:',err.message));
      },70);
      this.timer.unref();
    }
  }
  async flush() {
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    if(!this.dirty) return this.chain;
    const data=encodeRooms(this.rooms);
    this.dirty=false;
    this.chain=this.chain.catch(()=>{}).then(async()=> {
      const temp=join(this.dir,`.rooms-${process.pid}-${randomUUID()}.tmp`);
      try {
        const file=await open(temp,'wx',0o600);
        try {await file.writeFile(data);await file.sync();}
        finally {await file.close();}
        await rename(temp,this.path);
        // Ensure the rename itself is durable on filesystems that support it.
        try {const dir=await open(dirname(this.path),'r');try {await dir.sync();}finally{await dir.close();}}catch{}
        this.lastError=null;
      }catch(err) {this.lastError=err;await unlink(temp).catch(()=>{});throw err;}
    });
    return this.chain;
  }
}
