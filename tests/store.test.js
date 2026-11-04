import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotStore, decodeRooms } from '../server/store.js';

const dummy={
  code:'A2Z7H3',capacity:2,ownerId:'p1',phase:'lobby',revision:3,
  round:0,turn:0,players:[{id:'p1',name:'甲',bot:false,hand:[],
    autoplay:false,tokenHash:'a'.repeat(64)}],memory:new Map(),recentOps:new Map(),
  pairs:[],escaped:[],clients:new Set()
};

test('v0.3：快照原子保存 0600，能还原 Map 与房间内容',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'turtle-store-test-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=new SnapshotStore(dataDir);
  const rooms=new Map([[dummy.code,{...dummy,memory:new Map([['p1',new Map()]])}]]);
  store.mark(rooms);
  await store.flush();
  const contents=await readFile(join(dataDir,'rooms.json'),'utf8');
  assert.equal(JSON.parse(contents).format,1);
  assert.equal((await stat(join(dataDir,'rooms.json'))).mode&0o777,0o600);
  const restored=await store.load();
  assert.equal(restored.get(dummy.code).revision,3);
  assert.ok(restored.get(dummy.code).memory instanceof Map);
  assert.equal(restored.get(dummy.code).players[0].autoplay,true);
});

test('v0.3：损坏与不合规快照拒绝加载，不会静默重置正在进行的牌局',()=>{
  assert.throws(()=>decodeRooms('{not a json'),SyntaxError);
  assert.throws(()=>decodeRooms(JSON.stringify({format:2,rooms:[]})),/不受支持/);
  assert.throws(()=>decodeRooms(JSON.stringify({format:1,rooms:[{code:'BAD',players:[]}]})),/无效元数据/);
});
