import { randomInt } from 'node:crypto';

export class RuleError extends Error { constructor(message) {super(message);this.status=400;} }

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'C', 'D'];

export function createDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ id: `${suit}-${rank}`, rank, suit })));
}

export function shuffleInPlace(cards, rng = randomInt) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function discardPairs(hand) {
  const groups = new Map();
  for (const card of hand) {
    if (!groups.has(card.rank)) groups.set(card.rank, []);
    groups.get(card.rank).push(card);
  }
  const pairs = [];
  const discarded = new Set();
  for (const cards of groups.values()) {
    for (let i = 0; i + 1 < cards.length; i += 2) {
      pairs.push([cards[i], cards[i + 1]]);
      discarded.add(cards[i].id);
      discarded.add(cards[i + 1].id);
    }
  }
  const survivors = hand.filter(c => !discarded.has(c.id));
  hand.splice(0, hand.length, ...survivors);
  return pairs;
}

export function livePlayers(room) {
  return room.players.filter(p => p.hand.length > 0);
}

function playerAt(room, id) {
  return room.players.find(p => p.id === id);
}

function nextSeat(room, fromId, direction) {
  const from = room.players.findIndex(p => p.id === fromId);
  if (from < 0) throw new Error('Invalid seat');
  for (let step = 1; step <= room.players.length; step++) {
    const idx = (from + direction * step + room.players.length * 2) % room.players.length;
    if (room.players[idx].hand.length > 0) return room.players[idx].id;
  }
  return null;
}

function finishIfNeeded(room) {
  const live = livePlayers(room);
  if (live.length > 1) return false;
  if (live.length !== 1 || live[0].hand.length !== 1 || room.pairs.length !== 25) {
    throw new Error('牌组不变量被破坏：结束时必须剩余 1 张牌和 25 对弃牌');
  }
  room.phase = 'finished';
  room.currentPlayerId = null;
  room.targetPlayerId = null;
  room.deadline = null;
  room.loserId = live[0].id;
  room.lastAction = { kind: 'finished', playerId: live[0].id, finalDraw:room.lastAction?.kind === 'draw' ? room.lastAction : null, id: (room.actionId = (room.actionId || 0) + 1) };
  return true;
}

function markEscaped(room) {
  for (const player of room.players) {
    if (player.hand.length === 0 && !room.escaped.includes(player.id)) {
      room.escaped.push(player.id);
    }
  }
}

export function startGame(room, rng = randomInt) {
  if (!['lobby', 'finished'].includes(room.phase)) throw new RuleError('当前状态不能开始新一局');
  if (room.players.length < 2 || room.players.length > 6) throw new RuleError('需要 2 至 6 名玩家');
  const deck = shuffleInPlace(createDeck(), rng);
  room.removed = deck.pop();
  room.pairs = [];
  room.escaped = [];
  room.loserId = null;
  room.turn = 0;
  room.round = (room.round || 0) + 1;
  room.phase = 'playing';
  room.memory = new Map();
  room.drawHistory = [];
  room.actionId = 0;
  room.players.forEach(p => { p.hand = []; p.aiShuffleCheckedTurn = null; });
  deck.forEach((card, idx) => { room.players[idx % room.players.length].hand.push(card); });
  room.players.forEach(p => {
    const pairs = discardPairs(p.hand);
    pairs.forEach(cards => room.pairs.push({ cards, playerId: p.id, turn: 0 }));
  });
  markEscaped(room);
  if (finishIfNeeded(room)) return;
  const alive = livePlayers(room);
  const initial = alive[rng(alive.length)];
  room.currentPlayerId = initial.id;
  room.targetPlayerId = nextSeat(room, initial.id, -1);
  room.deadline = Date.now() + 30000;
  room.lastAction = { kind: 'started', id: (room.actionId = (room.actionId || 0) + 1) };
}

export function moveCard(room, playerId, fromIndex, toIndex) {
  if (room.phase !== 'playing') throw new RuleError('对局未进行中');
  const player = playerAt(room, playerId);
  if (!player || player.hand.length === 0) throw new RuleError('玩家没有手牌');
  if (room.targetPlayerId === playerId) throw new RuleError('正在被抽牌，手牌已锁定');
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
    fromIndex < 0 || fromIndex >= player.hand.length || toIndex < 0 || toIndex >= player.hand.length) {
    throw new RuleError('无效手牌位置');
  }
  const [card] = player.hand.splice(fromIndex, 1);
  player.hand.splice(toIndex, 0, card);
  forgetPlayerPositions(room, playerId);
  room.lastAction = { kind: 'reorder', playerId, id: (room.actionId = (room.actionId || 0) + 1) };
  return true;
}

export function forgetPlayerPositions(room, playerId) {
  for (const entries of (room.memory || new Map()).values()) {
    entries.delete(playerId);
  }
}

export function shuffleHand(room, playerId, rng = randomInt) {
  if (room.phase !== 'playing') throw new RuleError('对局未进行中');
  const player = playerAt(room, playerId);
  if (!player || player.hand.length === 0) throw new RuleError('玩家没有手牌');
  if (room.targetPlayerId === playerId) throw new RuleError('正在被抽牌，手牌已锁定');
  shuffleInPlace(player.hand, rng);
  forgetPlayerPositions(room, playerId);
  room.lastAction = { kind: 'shuffle', playerId, id: (room.actionId = (room.actionId || 0) + 1) };
}

// AI 只接收经筛选的公开信息与自己已知的信息，不读取其他玩家隐藏的牌面。
export function aiObservation(room, actorId) {
  const actor = playerAt(room, actorId);
  const target = playerAt(room, room.targetPlayerId);
  if (!actor || !target || room.currentPlayerId !== actorId || !actor.hand.length || !target.hand.length) {
    throw new Error('当前无法进行 AI 抽牌');
  }
  return {
    ownRanks: actor.hand.map(c => c.rank),
    targetCount: target.hand.length,
    knownSlots: (room.memory?.get(actorId)?.get(target.id) || []).map(k => ({ index:k.index, rank:k.rank })),
    // Both observations are derived exclusively from public pairs and the bot's own cards.
    publicPairs: room.pairs.map(pair => pair.cards[0].rank),
    otherKnownRanks: [...(room.memory?.get(actorId)?.entries() || [])]
      .filter(([id]) => id !== target.id && id !== actorId)
      .flatMap(([, entries]) => entries.map(entry => entry.rank)),
  };
}

// A useful rank must still exist outside the bot's hand and publicly discarded pairs.
// The missing removed card is *not* inspected. All genuinely unknown slots are
// exchangeable: giving an edge slot extra weight would fabricate information.
export function evaluateObservation(observation) {
  const counts = new Map(RANKS.map(rank => [rank, 4]));
  for (const rank of observation.ownRanks) counts.set(rank, counts.get(rank) - 1);
  for (const rank of observation.publicPairs || []) counts.set(rank, counts.get(rank) - 2);
  for (const rank of observation.otherKnownRanks || []) counts.set(rank, counts.get(rank) - 1);
  for (const {rank} of observation.knownSlots || []) counts.set(rank, counts.get(rank) - 1);
  const wanted = new Set(observation.ownRanks);
  const unseenMatches = [...wanted].reduce((n, rank) => n + Math.max(0, counts.get(rank) || 0), 0);
  const unseenTotal = [...counts.values()].reduce((n, count) => n + Math.max(0, count), 0);
  return { unseenMatches, unseenTotal, estimatedMatchChance: unseenTotal ? unseenMatches / unseenTotal : 0 };
}

export function chooseSlotFromObservation(observation, rng = randomInt) {
  const { ownRanks, targetCount, knownSlots } = observation;
  if (!Number.isInteger(targetCount) || targetCount <= 0) throw new Error('没有可抽取的牌');
  const ranks = new Set(ownRanks);
  const valid = knownSlots.filter(k => Number.isInteger(k.index) && k.index >= 0 && k.index < targetCount);
  const matches = valid.filter(k => ranks.has(k.rank));
  if (matches.length) return matches[rng(matches.length)].index;
  const knownMisses = new Set(valid.map(k => k.index));
  const candidates = Array.from({length: targetCount}, (_, idx) => idx).filter(idx => !knownMisses.has(idx));
  const possible = candidates.length ? candidates : Array.from({length: targetCount}, (_, idx) => idx);
  return possible[rng(possible.length)];
}

// Bots rearrange their own unknown card positions before drawing, never while
// locked as another player's target. Probability increases in a two-player endgame.
export function shouldAiShuffle(room, actorId, rng = randomInt) {
  const bot = playerAt(room, actorId);
  if (!bot?.bot || bot.hand.length < 2 || room.phase !== 'playing' ||
    room.targetPlayerId === actorId) return false;
  const live = livePlayers(room).length;
  const chance = live === 2 ? 65 : 32;
  return rng(100) < chance;
}

// A public draw position shifts the positions of any legitimately remembered
// neighbouring cards. When the drawn card can be identified by an observer, its
// rank can be followed into the actor's visible append slot (unless paired).
function updateMemoriesAfterDraw(room, actor, target, slot, drawn, paired) {
  const memory = room.memory || new Map();
  for (const [observerId, targets] of memory.entries()) {
    const previous = targets.get(target.id) || [];
    const transferred = previous.find(entry => entry.index === slot);
    const survivors = previous.filter(entry => entry.index !== slot)
      .map(entry => ({ index:entry.index > slot ? entry.index - 1 : entry.index, rank:entry.rank }));
    if (previous.length) {
      if (survivors.length) targets.set(target.id, survivors);
      else targets.delete(target.id);
    }
    if (paired) {
      // A public pair removes a second card from the actor at an unknown slot.
      targets.delete(actor.id);
    } else if (observerId !== actor.id && transferred) {
      const entries = targets.get(actor.id) || [];
      const index = actor.hand.length - 1;
      targets.set(actor.id, [...entries.filter(entry => entry.index !== index),
        {index,rank:transferred.rank}]);
    }
  }
  if (target.bot && !paired) {
    if (!memory.has(target.id)) memory.set(target.id, new Map());
    const observer = memory.get(target.id);
    const entries = observer.get(actor.id) || [];
    const index = actor.hand.length - 1;
    observer.set(actor.id,[...entries.filter(entry=>entry.index!==index),{index,rank:drawn.rank}]);
  }
}


export function decideAiSlot(room, actorId, rng = randomInt) {
  return chooseSlotFromObservation(aiObservation(room, actorId), rng);
}

export function drawCard(room, actorId, slot) {
  if (room.phase !== 'playing') throw new RuleError('游戏尚未开始');
  if (room.currentPlayerId !== actorId) throw new RuleError('尚未轮到该玩家');
  const actor = playerAt(room, actorId);
  const target = playerAt(room, room.targetPlayerId);
  if (!actor || !target) throw new Error('找不到玩家');
  if (!Number.isInteger(slot) || slot < 0 || slot >= target.hand.length) throw new RuleError('选择的牌不存在');

  const targetCountBefore = target.hand.length;
  const [drawn] = target.hand.splice(slot, 1);
  actor.hand.push(drawn);
  const matched = discardPairs(actor.hand);
  for (const cards of matched) room.pairs.push({ cards, playerId: actor.id, turn: room.turn + 1 });
  updateMemoriesAfterDraw(room, actor, target, slot, drawn, matched.length > 0);
  room.drawHistory ||= [];
  room.drawHistory.push({ actorId, targetId:target.id, slot, targetCount:targetCountBefore });
  if (room.drawHistory.length > 32) room.drawHistory.shift();

  room.turn += 1;
  markEscaped(room);
  room.lastAction = {
    kind: 'draw', actorId: actor.id, targetId: target.id, slot,
    id: (room.actionId = (room.actionId || 0) + 1), paired: matched.length > 0,
    appendIndex: matched.length ? null : actor.hand.length - 1,
    pair: matched.length ? matched[0] : null,
    turn: room.turn,
  };
  if (finishIfNeeded(room)) return { paired: matched.length > 0, finished: true };

  const nextActorId = nextSeat(room, actor.id, +1);
  if (!nextActorId) throw new Error('无法确定下一位玩家');
  room.currentPlayerId = nextActorId;
  room.targetPlayerId = nextSeat(room, nextActorId, -1);
  room.deadline = Date.now() + 30000;
  return { paired: matched.length > 0, finished: false };
}

export function publicView(room, viewerId) {
  const viewer = playerAt(room, viewerId);
  if (!viewer) throw new Error('无效观察者');
  const players = room.players.map(p => ({
    id: p.id, name: p.name, bot: p.bot, autoplay: Boolean(p.autoplay),
    count: p.hand.length, escaped: room.escaped.includes(p.id), owner: p.id === room.ownerId,
  }));
  const target = playerAt(room, room.targetPlayerId);
  return {
    code: room.code,
    revision: room.revision || 0,
    phase: room.phase,
    capacity: room.capacity,
    ownerId: room.ownerId,
    myId: viewerId,
    round: room.round || 0,
    turn: room.turn || 0,
    players,
    myHand: viewer.hand.map(c => ({ ...c })),
    targetSlots: target ? Array.from({ length: target.hand.length }, (_, index) => index) : [],
    currentPlayerId: room.currentPlayerId || null,
    targetPlayerId: room.targetPlayerId || null,
    deadline: room.deadline || null,
    pairs: room.pairs.map(p => ({ ...p })),
    escaped: [...room.escaped],
    loserId: room.phase === 'finished' ? room.loserId : null,
    removed: room.phase === 'finished' ? { ...room.removed } : null,
    lastCard: room.phase === 'finished' ? { ...playerAt(room, room.loserId).hand[0] } : null,
    lastAction: room.lastAction,
  };
}
