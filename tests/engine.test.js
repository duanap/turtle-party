import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeck, discardPairs, startGame, drawCard, decideAiSlot, aiObservation, publicView, shuffleHand, moveCard, shouldAiShuffle, evaluateObservation, chooseSlotFromObservation} from '../server/engine.js';

function roomFor(n=4) {
  return {code:'TEST12', capacity:n, ownerId:'p0', phase:'lobby', players:Array.from({length:n},(_,i)=>({id:`p${i}`,name:`玩家${i}`,bot:i>0,hand:[]}))};
}

test('完整牌组：52 张且不重复', () => {
  const deck=createDeck();
  assert.equal(deck.length,52);
  assert.equal(new Set(deck.map(c=>c.id)).size,52);
});

test('初始配对 4 张同点数时全部消除；3 张剩余 1 张', () => {
  const hand=createDeck().filter(c=>c.rank==='A');
  assert.equal(discardPairs(hand).length,2);
  assert.equal(hand.length,0);
  const three=createDeck().filter(c=>c.rank==='K').slice(0,3);
  assert.equal(discardPairs(three).length,1);
  assert.equal(three.length,1);
});

test('2 至 6 人发牌，始终 51 张有效牌且只暴露自己的手牌', () => {
  for (let n=2;n<=6;n++) {
    const room=roomFor(n); startGame(room);
    const cards=[...room.players.flatMap(p=>p.hand),...room.pairs.flatMap(p=>p.cards),room.removed];
    assert.equal(cards.length,52);
    assert.equal(new Set(cards.map(c=>c.id)).size,52);
    assert.equal((cards.length-1-room.pairs.length*2)%2,1);
    const publicData=publicView(room,'p0');
    assert.equal(publicData.myHand.length,room.players[0].hand.length);
    assert.ok(!('hand' in publicData.players[1]));
    assert.ok(!('removed' in publicData.players[1]));
    assert.equal(publicData.removed, room.phase==='playing' ? null : room.removed);
    assert.equal(publicData.targetSlots.length,room.players.find(p=>p.id===room.targetPlayerId)?.hand.length||0);
  }
});

test('AI 不使用目标暗牌牌面，仅根据合法已知位置选牌', () => {
  const room=roomFor(2); startGame(room);
  const actor=room.players.find(p=>p.id===room.currentPlayerId);
  const target=room.players.find(p=>p.id===room.targetPlayerId);
  const matchedRank=actor.hand[0].rank;
  room.memory.set(actor.id,new Map([[target.id,[{index:0,rank:matchedRank}]]]));
  assert.equal(decideAiSlot(room,actor.id,()=>0),0);
  const observation=aiObservation(room,actor.id);
  assert.ok(!('targetHand' in observation));
  assert.ok(!('removed' in observation));
  assert.ok(observation.ownRanks.every(v=>typeof v==='string'));
});

test('抽牌操作需要准确回合和合法位置', () => {
  const room=roomFor(); startGame(room);
  assert.throws(()=>drawCard(room,'unknown',0),/轮到/);
  assert.throws(()=>drawCard(room,room.currentPlayerId,100),/不存在/);
});

test('被抽玩家锁定，其他玩家可以洗序和调整手牌', () => {
  const room=roomFor(); startGame(room);
  assert.throws(()=>shuffleHand(room,room.targetPlayerId),/锁定/);
  assert.throws(()=>moveCard(room,room.targetPlayerId,0,0),/锁定/);
  const other=room.players.find(p=>p.id!==room.targetPlayerId&&p.hand.length>1);
  if(other) {moveCard(room,other.id,0,1);shuffleHand(room,other.id,()=>0);}
});

test('包括两个玩家同时脱身在内的随机完整对局均合法完成', () => {
  for(let n=2;n<=6;n++) {
    for(let trial=0;trial<100;trial++) {
      const room=roomFor(n); startGame(room);
      for(let i=0;i<3000&&room.phase==='playing';i++) {
        const actor=room.currentPlayerId;
        drawCard(room,actor,decideAiSlot(room,actor));
      }
      assert.equal(room.phase,'finished',`n=${n},trial=${trial}`);
      assert.equal(room.pairs.length,25);
      assert.equal(room.removed.rank,room.players.find(p=>p.hand.length===1)?.hand[0].rank);
      assert.equal(room.players.reduce((sum,p)=>sum+p.hand.length,0),1);
      assert.equal(room.players.filter(p=>p.hand.length===1).length,1);
      assert.equal(room.escaped.length,n-1);
      assert.equal(publicView(room,'p0').removed.id,room.removed.id);
    }
  }
});

test('多于两人的残局：抽牌双方可同时清空，第三人持乌龟', () => {
  const room=roomFor(3);
  const deck=createDeck();
  // 一对 A，另一张不同点数的单牌；其他 48 张已弃掉。
  const a=deck.find(c=>c.id==='S-A');
  const b=deck.find(c=>c.id==='H-A');
  const odd=deck.find(c=>c.id==='S-K');
  // 用人工构造的残局验证抽牌双方同时清空，重点检查状态流转。
  room.phase='playing'; room.removed={id:'REMOVED',rank:'K',suit:'D'};
  room.pairs = Array.from({length:24},(_,i)=>({cards:[{id:`x${i}a`},{id:`x${i}b`}],playerId:'p2',turn:0}));
  room.players[0].hand=[a];room.players[1].hand=[b];room.players[2].hand=[odd];
  room.currentPlayerId='p0';room.targetPlayerId='p1';room.escaped=[];room.turn=0;room.memory=new Map();
  const result=drawCard(room,'p0',0);
  assert.equal(result.finished,true);
  assert.equal(room.escaped.length,2);
  assert.equal(room.loserId,'p2');
});

test('AI memory: known card positions shift after a public draw and transfer without leaking a card', () => {
  const room=roomFor(3);
  const deck=createDeck();
  const card=id=>deck.find(c=>c.id===id);
  room.phase='playing';room.turn=8;room.actionId=3;room.pairs=[];room.escaped=[];
  room.currentPlayerId='p0';room.targetPlayerId='p1';room.memory=new Map();
  room.players[0].hand=[card('S-A')];
  room.players[1].hand=[card('H-7'),card('C-K'),card('D-7')];
  room.players[2].hand=[card('S-Q'),card('H-J')];
  room.memory.set('p2',new Map([['p1',[{index:0,rank:'7'},{index:1,rank:'K'},{index:2,rank:'7'}]]]));
  drawCard(room,'p0',1);
  const observer=room.memory.get('p2');
  assert.deepEqual(observer.get('p1'),[{index:0,rank:'7'},{index:1,rank:'7'}]);
  assert.deepEqual(observer.get('p0'),[{index:1,rank:'K'}]);
  assert.deepEqual(room.memory.get('p1').get('p0'),[{index:1,rank:'K'}]);
  const publicData=publicView(room,'p2');
  assert.equal(publicData.lastAction.slot,1);
  assert.equal(publicData.lastAction.card.id,'C-K');
  assert.deepEqual(room.memory.get('p1').get('p0'),[{index:1,rank:'K'}]);
  // The target's own reorder destroys other observers' exact positional knowledge.
  moveCard(room,'p1',0,1);
  assert.equal(room.memory.get('p2').has('p1'),false);
  assert.deepEqual(room.memory.get('p2').get('p0'),[{index:1,rank:'K'}]);
});

test('AI position knowledge: a public pair invalidates actor card positions', () => {
  const room=roomFor(3);const deck=createDeck();const card=id=>deck.find(c=>c.id===id);
  room.phase='playing';room.turn=1;room.pairs=[];room.escaped=[];
  room.currentPlayerId='p0';room.targetPlayerId='p1';room.memory=new Map();
  room.players[0].hand=[card('S-A'),card('S-3')];
  room.players[1].hand=[card('D-2'),card('H-A'),card('C-K')];
  room.players[2].hand=[card('D-7')];
  room.memory.set('p2',new Map([['p0',[{index:0,rank:'A'},{index:1,rank:'3'}]],['p1',[{index:2,rank:'K'}]]]));
  drawCard(room,'p0',1);
  assert.equal(room.memory.get('p2').has('p0'),false);
  assert.deepEqual(room.memory.get('p2').get('p1'),[{index:1,rank:'K'}]);
  assert.equal(publicView(room,'p2').lastAction.pair.length,2);
});

test('AI shuffle and information estimates only use legal observations', () => {
  const room=roomFor(3);const deck=createDeck();const card=id=>deck.find(c=>c.id===id);
  room.phase='playing';room.currentPlayerId='p1';room.targetPlayerId='p0';room.pairs=[];room.memory=new Map();
  room.players[0].hand=[card('S-A')];
  room.players[1].hand=[card('S-K'),card('D-7'),card('S-2')];
  room.players[2].hand=[card('S-9')];
  assert.equal(shouldAiShuffle(room,'p1',()=>0),true);
  assert.equal(shouldAiShuffle(room,'p1',()=>99),false);
  assert.equal(shouldAiShuffle(room,'p0',()=>0),false);
  room.targetPlayerId='p1';
  assert.equal(shouldAiShuffle(room,'p1',()=>0),false);
  room.targetPlayerId='p0';
  const observation=aiObservation(room,'p1');
  assert.equal('targetHand' in observation,false);
  assert.equal('removed' in observation,false);
  const estimation=evaluateObservation(observation);
  assert.ok(estimation.estimatedMatchChance>=0 && estimation.estimatedMatchChance<=1);
  const known={ownRanks:['A'],targetCount:3,knownSlots:[{index:0,rank:'K'},{index:2,rank:'A'}]};
  assert.equal(chooseSlotFromObservation(known,()=>0),2);
  assert.equal(chooseSlotFromObservation({...known,knownSlots:[{index:0,rank:'K'}]},()=>0),1);
});
