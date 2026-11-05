import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomCode } from '../server/room-code.js';

test('房间号碰撞会重新生成且保留前导零',()=>{
  const values=[42,42,7];
  const code=createRoomCode(new Set(['000042']),()=>values.shift());
  assert.equal(code,'000007');
  assert.equal(createRoomCode(new Set(),()=>0),'000000');
  assert.equal(createRoomCode(new Set(),()=>999999),'999999');
});

test('连续碰撞达到上限时明确拒绝，不覆盖已有房间',()=>{
  const existing=new Set(['123456']);let calls=0;
  assert.throws(()=>createRoomCode(existing,()=>{calls++;return 123456;}),error=>error.status===503);
  assert.equal(calls,100);assert.equal(existing.size,1);
});
