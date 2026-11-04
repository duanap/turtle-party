import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function ui(stored={}) {
  let frame='';
  const content={innerHTML:''},dialog={innerHTML:'',querySelector:()=>null};
  const shell={dataset:{},classList:{toggle:()=>{}}};
  const app={get innerHTML(){return frame+content.innerHTML+dialog.innerHTML;},set innerHTML(value){frame=value;},
    querySelector:selector=>frame?({'.scene-shell':shell,'.scene-content':content,'.dialog-host':dialog}[selector]||null):null,
    querySelectorAll:()=>[],addEventListener:()=>{}};
  const toast={textContent:'',classList:{add:()=>{},remove:()=>{}}};
  const document={querySelector:k=>k==='#app'?app:toast,querySelectorAll:()=>[],addEventListener:()=>{}};
  const storage={getItem:key=>stored[key]??null,setItem:(key,value)=>{stored[key]=value;},removeItem:key=>{delete stored[key];}};
  const context=vm.createContext({document,localStorage:storage,setInterval:()=>{},
    setTimeout:()=>0,clearTimeout:()=>{},console,URL,encodeURIComponent});
  vm.runInContext(source,context,{filename:'app.js'});
  return {app,context};
}
function baseView() {
  return {
    code:'K5P7A2',phase:'playing',capacity:4,ownerId:'p0',myId:'p0',round:1,turn:1,
    players:[{id:'p0',name:'玩家甲',bot:false,owner:true,count:2,escaped:false},
      {id:'p1',name:'AI 小圆',bot:true,owner:false,count:3,escaped:false},
      {id:'p2',name:'访客乙',bot:false,owner:false,count:1,escaped:false}],
    myHand:[{id:'S-A',rank:'A',suit:'S'},{id:'D-7',rank:'7',suit:'D'}],
    targetSlots:[0,1,2],currentPlayerId:'p0',targetPlayerId:'p2',deadline:Date.now()+30000,
    pairs:[],escaped:[],loserId:null,removed:null,lastCard:null,lastAction:{kind:'started'}
  };
}

test('首页、创建与加入表单不会出现运行时异常',()=> {
  const {app,context}=ui();
  assert.match(app.innerHTML,/快速开始/);
  vm.runInContext("state.form='create';render();",context);
  assert.match(app.innerHTML,/房间人数上限/);
  vm.runInContext("state.form='join';render();",context);
  assert.match(app.innerHTML,/6 位房间号/);
});

test('牌桌与结算显示真实的剩余乌龟牌',()=> {
  const {app,context}=ui();
  const v=baseView();context.fixture=v;
  vm.runInContext('state.view=fixture;state.selected=1;render();',context);
  assert.match(app.innerHTML,/确认抽取/);
  assert.match(app.innerHTML,/第 2 张/);
  assert.match(app.innerHTML,/我的手牌/);
  v.phase='finished';v.currentPlayerId=null;v.targetPlayerId=null;v.targetSlots=[];
  v.players[0].count=0;v.players[1].count=1;v.players[2].count=0;
  v.loserId='p1';v.escaped=['p0','p2'];v.myHand=[];
  v.removed={rank:'9',suit:'H',id:'H-9'};
  v.lastCard={rank:'9',suit:'C',id:'C-9'};
  context.fixture=v;
  vm.runInContext('state.view=fixture;render();',context);
  assert.match(app.innerHTML,/剩余乌龟牌/);
  assert.match(app.innerHTML,/成功脱身/);
  assert.match(app.innerHTML,/♣/);
});

test('首页规则常显、界面中文以及数字房间号输入约束',()=>{
  const {app,context}=ui();
  assert.match(app.innerHTML,/home-rules/);
  assert.doesNotMatch(app.innerHTML,/data-ui="help"|A LITTLE|AI 对战/);
  vm.runInContext("state.form='join';render();",context);
  assert.match(app.innerHTML,/inputmode="numeric"/);
  assert.match(app.innerHTML,/pattern="\[0-9\]\{6\}"/);
});

test('被抽者只抬起被选中的那张手牌，取消选择会恢复',()=>{
  const {app,context}=ui();const v=baseView();
  v.targetPlayerId=v.myId;v.currentPlayerId='p1';
  v.selection={actorId:'p1',targetId:v.myId,slot:1,turn:v.turn};
  context.fixture=v;vm.runInContext('state.view=fixture;render();',context);
  assert.match(app.innerHTML,/own-card being-selected/);
  assert.match(app.innerHTML,/对方正在选这张牌/);
  v.selection=null;vm.runInContext('state.view=fixture;render();',context);
  assert.doesNotMatch(app.innerHTML,/own-card being-selected/);
});

test('牌面保留标准 A、J、Q、K，不把点数翻译成中文字符',()=>{
  const {app,context}=ui();const v=baseView();
  v.myHand=[['S','A'],['H','J'],['C','Q'],['D','K']].map(([suit,rank])=>({id:`${suit}-${rank}`,suit,rank}));
  context.fixture=v;vm.runInContext('state.view=fixture;render();',context);
  const labels=[...app.innerHTML.matchAll(/class="value">([^<]+)</g)].map(match=>match[1]);
  assert.deepEqual(labels,['A','J','Q','K']);
});

test('音效默认开启，保留关闭选择且不堆积尚未激活的声音',()=>{
  for(const [stored,expected] of [[{},true],[{'turtle-sound':'off'},false],[{'turtle-sound':'on'},true]]){
    const {context}=ui(stored);
    assert.equal(vm.runInContext('state.preferences.sound',context),expected);
  }
  const {context}=ui();let tones=0;
  context.window={AudioContext:class {
    state='suspended';
    resume(){return Promise.resolve();}
    createOscillator(){tones++;return {};}
  }};
  vm.runInContext("playTone('pair');playTone('pair');playTone('reveal');",context);
  assert.equal(tones,0);
});

test('等待房间只显示已入座玩家，空位不绘制位置框',()=>{
  const {app,context}=ui();const v=baseView();
  v.phase='lobby';v.capacity=6;v.players=[v.players[0]];
  context.fixture=v;vm.runInContext('state.view=fixture;render();',context);
  assert.equal((app.innerHTML.match(/data-player-seat=/g)||[]).length,1);
  assert.equal((app.innerHTML.match(/class="seat-slot" hidden/g)||[]).length,5);
  assert.doesNotMatch(app.innerHTML,/空位/);
  v.players.push({id:'p1',name:'新玩家',count:0,bot:false});
  vm.runInContext('render();',context);
  assert.equal((app.innerHTML.match(/data-player-seat=/g)||[]).length,2);
  assert.equal((app.innerHTML.match(/class="seat-slot" hidden/g)||[]).length,4);
});
