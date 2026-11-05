import { randomInt } from 'node:crypto';

export function createRoomCode(existing, random = randomInt) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = String(random(1000000)).padStart(6, '0');
    if (!existing.has(code)) return code;
  }
  const error = new Error('房间暂时无法创建，请稍后重试');
  error.status = 503;
  throw error;
}
