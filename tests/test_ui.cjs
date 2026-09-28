const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');
const assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:393,height:873},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let paired=false,online=true;
 const commands=[];
 const state={title:'Night Drive',artist:'Late Signal',playing:true,elapsed:102,duration:258,volume:.68,liked:false,shuffle:false,repeat:false,artwork:'',seekAvailable:true,volumeAvailable:true,available:{toggle:true,previous:true,next:true,shuffle:true,repeat:true,like:true,mute:true}};
 await page.route('http://127.0.0.1:8765/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.startsWith('/api/')){
   let body={};if(route.request().method()==='POST')body=route.request().postDataJSON();
   let data;
   if(url.pathname==='/api/pair'){paired=true;data={ok:true,token:'test-token'};}
   else if(url.pathname==='/api/state')data={ok:true,connected:online,state,device:'DESKTOP PC',sleepRemaining:0};
   else {commands.push(body);if(body.type==='toggle')state.playing=!state.playing;if(body.type==='volume')state.volume=body.value;data={ok:true};}
   return route.fulfill({json:data});
  }
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  const types={html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml'};
  return route.fulfill({body:fs.readFileSync(path.join(root,'ui',name)),contentType:types[name.split('.').pop()]});
 });
 await page.goto('http://127.0.0.1:8765/');
 assert(await page.locator('#pairDialog').isVisible());
 await page.fill('#host','192.168.1.10:8765');await page.fill('#code','123456');
 await page.click('#pairSubmit');await page.waitForFunction(()=>document.querySelector('#title').textContent==='Night Drive');
 assert(paired);assert.equal(await page.locator('#play').getAttribute('aria-label'),'Pause');
 await page.evaluate(()=>document.querySelector('#toast').classList.remove('visible'));
 await page.screenshot({path:path.join(root,'Preview.png'),fullPage:true});
 await page.click('#play');await page.waitForFunction(()=>document.querySelector('#play').getAttribute('aria-label')==='Play');
 assert.equal(commands.at(-1).type,'toggle');
 await page.click('[data-command="seekBy"][data-value="10"]');assert.equal(commands.at(-1).value,10);
 await page.click('#search');await page.fill('#query','ambient');await page.click('#searchForm button.submit');
 await page.waitForFunction(()=>!document.querySelector('#search').disabled);assert.equal(commands.at(-1).type,'search');
 await page.click('#sleep');await page.click('[data-minutes="30"]');
 await page.waitForFunction(()=>!document.querySelector('#sleep').disabled);assert.equal(commands.at(-1).value,30);
 await page.click('#volDown');await page.waitForFunction(()=>commands.at(-1)?.type==='volume');assert.equal(commands.at(-1).value,.63);
 await page.click('#volUp');await page.waitForFunction(()=>commands.at(-1)?.value===.68);assert.equal(commands.at(-1).value,.68);
 state.volume=null;await page.waitForFunction(()=>document.querySelector('#volDown').disabled&&document.querySelector('#volUp').disabled);
 state.volume=.04;await page.waitForFunction(()=>!document.querySelector('#volDown').disabled);
 await page.click('#volDown');await page.waitForFunction(()=>commands.at(-1)?.value===0);assert.equal(commands.at(-1).value,0);
 await page.click('#volUp');await page.waitForFunction(()=>commands.at(-1)?.value===.09);assert.equal(commands.at(-1).value,.09);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 online=false;await page.waitForFunction(()=>document.querySelector('#play').disabled);assert(await page.locator('#volume').isDisabled());
 assert.deepEqual(errors,[]);
 // Exercise the actual extension adapter against a DOM matching inspected SoundCloud controls.
 const tab=await browser.newPage();
 await tab.setContent(`<button class="playControls__play playing">pause</button><button class="playControls__next"></button><button class="playControls__prev"></button><div class="playControls__shuffle"><button class="shuffleControl m-shuffling"></button></div><div class="playControls__repeat"><button class="repeatControl m-one"></button></div><button class="playbackSoundBadge__like sc-button-selected"></button><a class="playbackSoundBadge__titleLink" title="Test title"></a><a class="playbackSoundBadge__lightLink">Artist</a><div class="playbackTimeline is-scrubbable"><div class="playbackTimeline__progressWrapper" aria-valuenow="42" aria-valuemax="200" style="width:200px;height:20px"></div></div><div class="volume"><button class="volume__button"></button><div class="volume__sliderWrapper" aria-valuenow="0.6"><div class="volume__sliderBackground" style="height:120px;width:4px"></div></div></div>`);
 await tab.evaluate(()=>{
  window.chrome={runtime:{onMessage:{addListener:fn=>window.adapter=fn},sendMessage:()=>Promise.resolve()}};
  document.querySelector('.playControls__play').onclick=e=>e.currentTarget.classList.toggle('playing');
  document.querySelector('.playControls__shuffle button').onclick=e=>e.currentTarget.classList.toggle('m-shuffling');
  document.querySelector('.playbackTimeline__progressWrapper').onmousedown=e=>{window.seekX=e.clientX;};
  document.querySelector('.volume__sliderWrapper').onmousedown=e=>{window.volumeY=e.clientY;};
 });
 await tab.addScriptTag({path:path.join(root,'extension/content.js')});
 const message=m=>tab.evaluate(m=>new Promise(r=>window.adapter(m,{},r)),m);
 let snapshot=await message({action:'state'});assert.equal(snapshot.playing,true);assert.equal(snapshot.repeat,true);assert.equal(snapshot.duration,200);assert.equal(snapshot.volume,.6);
 assert.equal((await message({action:'command',command:{type:'toggle'}})).ok,true);
 snapshot=await message({action:'state'});assert.equal(snapshot.playing,false);
 for(let i=0;i<2;i++)await message({action:'command',command:{type:'play'}});assert.equal((await message({action:'state'})).playing,true);
 for(let i=0;i<2;i++)await message({action:'command',command:{type:'pause'}});assert.equal((await message({action:'state'})).playing,false);
 await message({action:'command',command:{type:'shuffle'}});assert.equal((await message({action:'state'})).shuffle,false);
 await message({action:'command',command:{type:'seekTo',value:.5}});assert.equal(await tab.evaluate(()=>window.seekX),108);
 await message({action:'command',command:{type:'volume',value:.5}});assert.equal(typeof await tab.evaluate(()=>window.volumeY),'number');
 assert.equal((await message({action:'command',command:{type:'unknown'}})).ok,false);
 await browser.close();console.log('PASS: mobile pairing, commands, disconnect, 320/393px layout, extension state and control events.');
})().catch(error=>{console.error(error);process.exit(1)});
