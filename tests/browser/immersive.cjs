const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const output=path.resolve(process.env.BROWSER_OUTPUT_DIR||path.join(require('node:os').tmpdir(),'turtle-party-browser'));fs.mkdirSync(output,{recursive:true});
const base=process.env.BROWSER_BASE_URL||'http://127.0.0.1:3000';
const checks=[],errors=[],screenshots=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function snapshot(page){return page.evaluate
(async()=>{const s=JSON.parse(localStorage.getItem('turtle-session'));return fetch(`/api/rooms/${s.code}/state`,{headers:{Authorization:`Bearer ${s.token}`}}).then(r=>r.json())});}
async function screen(page,name){const file=path.join(output,name+'.png');await page.screenshot({path:file});screenshots.push(file);}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow');}
async function rowLayout(page){for(const field of await page.locator('.field').all()){const label=await field.locator('span').boundingBox(),input=await field.locator('input,select').boundingBox();assert.ok(Math.abs(label.y+label.height/2-input.y-input.height/2)<3,'field wrapped');}await noOverflow(page);}
async function modalAndLayoutChecks(browser){
 const c=await browser.newContext({viewport:{width:1440,height:900}});
 const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
 await p.goto(base);
 const background=await p.locator('.scene-room').elementHandle();
 for(const viewport of [{width:1440,height:900},{width:1280,height:720},{width:844,height:390},{width:740,height:360},{width:667,height:375},{width:390,height:844}]){
  await p.setViewportSize(viewport);await noOverflow(p);
  assert.equal(await p.locator('.home-rules li').count(),5);
  await p.locator('[data-ui="join"]').click();await rowLayout(p);
  assert.equal(await background.evaluate(el=>el.isConnected),true);
  await p.locator('[name="code"]').fill('123');
  await p.locator('button[type="submit"]').click();
  assert.match(await p.locator('.form-error').innerText(),/六位数字/);
  await p.keyboard.press('Escape');assert.equal(await p.locator('[role="dialog"]').count(),0);
  if(viewport.width===390)await screen(p,'immersive-home-phone');
 }
 await p.setViewportSize({width:1440,height:900});
 await p.locator('[data-ui="settings"]').click();
 assert.equal(await p.locator('[name="sound"]').isChecked(),false);
 await p.locator('[name="sound"]').check();
 assert.equal(await p.evaluate(()=>localStorage.getItem('turtle-sound')),'on');
 await p.locator('[name="sound"]').uncheck();
 await p.locator('[name="reduceMotion"]').check();
 const dialog=p.locator('[role="dialog"]');
 const controls=dialog.locator('button,input,select');
 await controls.last().focus();await p.keyboard.press('Tab');
 assert.equal(await controls.first().evaluate(el=>el===document.activeElement),true);
 await p.keyboard.press('Escape');await p.reload();
 await p.locator('[data-ui="settings"]').click();
 assert.equal(await p.locator('[name="reduceMotion"]').isChecked(),true);
 await p.locator('[name="reduceMotion"]').uncheck();
 await p.keyboard.press('Escape');
 checks.push('六种视口的表单单行、常显规则、背景节点保留；弹窗焦点循环及设置持久化');
 for(let capacity=2;capacity<=6;capacity++){
  await p.locator('[data-ui="create"]').click();
  await p.locator('[name="name"]').fill('布局校验');
  await p.locator('[name="capacity"]').selectOption(String(capacity));
  await p.locator('button[type="submit"]').click();await p.waitForSelector('.lobby-page');await wait(200);
  assert.equal(await p.locator('.seat').count(),capacity);
  await p.locator('[data-ui="leave"]').click();await p.keyboard.press('Escape');
  assert.equal(await p.locator('.lobby-page').count(),1);
  if(capacity===6){
   for(let i=0;i<5;i++){await p.locator('[data-api="add_bot"]').click();await p.waitForFunction(n=>document.querySelectorAll('.seat:not(.empty-seat)').length===n,i+2);}
   await screen(p,'immersive-lobby-six-desktop');
   const before=await p.locator('.seat-ring .seat').evaluateAll(els=>els.map(el=>({id:el.dataset.playerSeat,x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y})));
   await p.locator('[data-api="start"]').click();await p.waitForSelector('.deal-effect');
   await p.waitForSelector('.deal-effect',{state:'detached'});
   const after=await p.locator('.seat-ring .seat').evaluateAll(els=>els.map(el=>({id:el.dataset.playerSeat,x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y})));
   assert.deepEqual(before,after);
   for(const viewport of [{width:1440,height:900},{width:844,height:390},{width:740,height:360},{width:667,height:375},{width:390,height:844}]){
    await p.setViewportSize(viewport);await wait(80);await noOverflow(p);
    await p.waitForFunction(()=>!document.querySelector('.draw-effect,.pair-effect,.deal-effect'));
    const sizes=await p.locator('.target-list .card').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return{w:r.width,h:r.height}}));
    assert.ok(sizes.every(r=>r.w>=44&&r.h>=44),'card touch target too small');
    const targets=await p.locator('.target-list').boundingBox(),hand=await p.locator('.own-dock').boundingBox();
    assert.ok(targets.y+targets.height<=hand.y,'target overlaps own hand');
    if(viewport.width===1440||viewport.width===390||viewport.width===740)await screen(p,'immersive-game-'+viewport.width+'x'+viewport.height);
   }
  }
  await p.locator('[data-ui="leave"]').click();
  await p.locator('[data-ui="confirm-leave"]').click();await p.waitForSelector('.home-page');
 }
 checks.push('二至六人座位、同场景洗牌发牌、开局座位稳定、三种小横屏牌面不小于四十四像素');
 await c.close();
}

(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||undefined,headless:true});
 const contexts=[];const pages=[];
 try{
  await modalAndLayoutChecks(browser);
  for(const viewport of [{width:1280,height:900},{width:390,height:844},{width:844,height:390}]){
   const c=await browser.newContext({viewport});contexts.push(c);const page=await c.newPage();pages.push(page);
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
   page.on('dialog',d=>d.accept());await page.goto(base);
   assert.equal(await page.locator('.home-rules').count(),1);assert.equal(await page.locator('[data-ui="help"]').count(),0);
   assert.ok(!/[A-Za-z]/.test(await page.locator('body').innerText()),'English on homepage');await noOverflow(page);
  }
  checks.push('三种视口：首页规则常显、中文界面、无横向溢出');
  await screen(pages[0],'immersive-home');
  const host=pages[0];await host.locator('[data-ui="create"]').click();await rowLayout(host);
  await host.locator('[name="name"]').fill('玩家甲');await host.locator('[name="capacity"]').selectOption('3');await host.locator('button[type="submit"]').click();await host.waitForSelector('.room-copy strong');
  const code=await host.locator('.room-copy strong').innerText();assert.match(code,/^[0-9]{6}$/);checks.push('真实表单创建六位纯数字房间');
  for(let i=1;i<3;i++){
   const page=pages[i];await page.locator('[data-ui="join"]').click();await rowLayout(page);
   assert.equal(await page.locator('[name="code"]').getAttribute('inputmode'),'numeric');
   if(i===1)await screen(page,'immersive-join-phone');
   await page.locator('[name="name"]').fill(i===1?'玩家乙':'玩家丙');await page.locator('[name="code"]').fill(code);await page.locator('button[type="submit"]').click();await page.waitForSelector('.lobby-page');
  }
  checks.push('手机竖屏及横屏：昵称/房间号标签与输入框同一行');
  await host.locator('[data-api="start"]').click();for(const p of pages)await p.waitForSelector('.table');
  const byId=new Map();for(const p of pages)byId.set((await snapshot(p)).myId,p);
  let paired=false,unpaired=false,finished=false,moves=0;
  for(let n=0;n<45;n++){
   const v=await snapshot(host);
   if(v.phase==='finished'){
    finished=true;
    if(paired&&unpaired)break;
    await host.locator('[data-api="rematch"]').click();await wait(200);continue;
   }
   const actor=byId.get(v.currentPlayerId),target=byId.get(v.targetPlayerId);
   assert.ok(actor&&target);
   await actor.waitForFunction(()=>[...document.querySelectorAll('[data-slot]')].some(b=>!b.disabled));
   const av=await snapshot(actor),tv=await snapshot(target),ranks=new Set(av.myHand.map(c=>c.rank));
   const matches=tv.myHand.map((c,i)=>({c,i}));
   let candidate=!unpaired?matches.find(x=>!ranks.has(x.c.rank)):null;
   candidate ||= matches.find(x=>ranks.has(x.c.rank)) || matches[0];
   const slot=candidate.i,card=candidate.c,willPair=ranks.has(card.rank);
   const before=await target.locator(`[data-own-card="${slot}"]`).boundingBox();
   await actor.locator(`[data-slot="${slot}"]`).click();
   await target.waitForSelector(`[data-own-card="${slot}"].being-selected`);
   await wait(160);const lifted=await target.locator(`[data-own-card="${slot}"]`).boundingBox();assert.ok(before.y-lifted.y>=12,'target card not lifted');
   assert.ok((await snapshot(target)).selection.slot===slot);
   if(n===0)await screen(target,'immersive-target-selected');
   await actor.locator('[data-api="draw"]').click();
   for(const p of pages)await p.waitForSelector('.draw-effect[data-stage="revealed"]');
   for(const p of pages){assert.equal(await p.locator('.draw-effect .flip-front [data-card-id]').getAttribute('data-card-id'),card.id);assert.equal(await p.locator('.finish-layer').count(),0);assert.ok(!/[A-Za-z]/.test(await p.locator('body').innerText()),'English during game');}
   if(!paired&&!unpaired)await screen(actor,'immersive-card-revealed');
   await actor.waitForSelector('.draw-effect',{state:'detached'});
   assert.equal(await actor.locator(`.hand-scroll [data-card-id="${card.id}"]`).count(),1,'drawn card never arrived in hand');
   if(willPair){
    for(const p of pages)await p.waitForSelector('.pair-effect');
    if(!paired)await screen(pages.find(p=>p!==actor&&p!==target),'immersive-observer-pair');
    paired=true;
   }else unpaired=true;
   await actor.waitForFunction(()=>!document.querySelector('.draw-effect,.pair-effect')&&!document.querySelector('.drawn-card'));
   moves++;
   for(const p of pages)await noOverflow(p);
  }
  assert.ok(paired&&unpaired&&finished,JSON.stringify({paired,unpaired,finished,moves}));
  checks.push('三端一致：选牌提起、翻牌牌面、进入手牌、对子动画');
  checks.push('成对与未成对抽牌均验证，最后一抽完整动画后才显示结算');
  checks.push(`完成真实三人对局，共抽牌 ${moves} 次`);
  assert.deepEqual(errors,[]);
  checks.push('三浏览器会话无页面异常');
  console.log(JSON.stringify({base,checks,screenshots,errors},null,2));
  fs.writeFileSync(path.join(output,'immersive-browser-report.json'),JSON.stringify({base,checks,screenshots,errors},null,2));
 }finally{for(const p of pages)try{await p.evaluate(async()=>{const s=JSON.parse(localStorage.getItem('turtle-session')||'null');if(s)await fetch('/api/rooms/'+s.code+'/action',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.token},body:JSON.stringify({type:'leave',requestId:crypto.randomUUID()}),signal:AbortSignal.timeout(8000)})})}catch{}for(const c of contexts)await c.close();await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
