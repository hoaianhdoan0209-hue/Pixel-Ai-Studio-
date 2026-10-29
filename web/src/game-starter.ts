/** Original, dependency-free starter. The exact files are tested by the build runner. */
export const STARTER_NAME = 'Làng Đèn Nhỏ';
export const STARTER_DESCRIPTION = 'Một chuyến dạo chơi pixel ấm áp: tìm ba hạt sáng và thắp đèn cho ngôi nhà mái đỏ.';
export const STARTER_INSTRUCTIONS = [
  'Di chuyển bằng WASD, phím mũi tên hoặc các nút trên màn hình.',
  'Đến gần hạt sáng rồi nhấn E, phím cách hoặc Tương tác để nhặt.',
  'Mang đủ ba hạt sáng về bậc cửa ngôi nhà mái đỏ để thắp đèn. Có thể chơi lại.',
];

const html = String.raw`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Làng Đèn Nhỏ</title><link rel="stylesheet" href="style.css"></head>
<body><main class="game-shell"><header><div><span class="eyebrow">PIXEL AI WORLD · CHUYẾN ĐI NHỎ</span><h1>Làng Đèn Nhỏ <span aria-hidden="true">✦</span></h1></div><button id="reset" class="quiet">Chơi lại ↻</button></header>
<section class="quest" aria-label="Nhiệm vụ"><span class="quest-icon" aria-hidden="true">✧</span><div><strong>Thắp sáng căn nhà mái đỏ</strong><p>Tìm 3 hạt sáng, rồi mang về bậc cửa.</p></div><output id="count" aria-label="Hạt sáng đã thu thập">0 / 3</output></section>
<div class="scene"><canvas id="world" width="768" height="512" tabindex="0" aria-label="Bản đồ ngôi làng. Dùng phím mũi tên để di chuyển." role="img"></canvas><span class="scene-note" aria-hidden="true">NGÔI LÀNG BÌNH YÊN · 16:42</span><div id="victory" class="victory" hidden><span aria-hidden="true">✦</span><h2>Đèn đã sáng, nhà đã ấm!</h2><p>Cảm ơn bạn đã mang ánh sáng về làng.</p><button id="again">Thêm một chuyến đi</button></div></div>
<p id="message" class="message" role="status" aria-live="polite">Đi tìm ba hạt sáng đang lấp lánh quanh làng.</p>
<footer><div class="controls" role="group" aria-label="Điều khiển di chuyển"><button data-direction="up" class="up" aria-label="Đi lên">↑</button><button data-direction="left" aria-label="Đi sang trái">←</button><button data-direction="down" aria-label="Đi xuống">↓</button><button data-direction="right" aria-label="Đi sang phải">→</button></div><div class="keyboard"><span><kbd>W A S D</kbd> / <kbd>↑ ↓ ← →</kbd> di chuyển</span><span><kbd>E</kbd> / <kbd>Space</kbd> tương tác</span></div><button id="interact" class="interact">Tương tác <span aria-hidden="true">✦</span></button></footer>
<p class="smallprint">Một khu vườn nhỏ, không vội vàng. Chạm vào bản đồ để dùng bàn phím.</p></main><script src="game.js"></script></body></html>`;

const css = String.raw`*{box-sizing:border-box}html{background:#f6edda;color:#473e31;font-family:system-ui,-apple-system,Segoe UI,sans-serif}body{margin:0;padding:18px}button{font:inherit;cursor:pointer;border:1px solid #d4c7a8;border-radius:7px;color:#57472f;background:#fff8e9;padding:10px 16px;font-weight:600;touch-action:manipulation;box-shadow:0 2px 0 #d4c7a8}button:hover{background:#f5dfb8}button:active{transform:translateY(2px);box-shadow:none}button:focus-visible,canvas:focus-visible{outline:3px solid #7e9b68;outline-offset:3px}.game-shell{max-width:930px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:15px}.eyebrow{font-size:9px;font-weight:700;letter-spacing:1.7px;color:#8d8b69}h1{font-family:Georgia,serif;font-size:30px;font-weight:400;margin:5px 0 0;letter-spacing:-.7px}h1 span{color:#b18a44;font-size:22px}.quiet{font-size:11px;padding:8px 12px}.quest{display:flex;gap:12px;align-items:center;border:1px solid #e0d2b2;border-radius:9px;background:#fffaed;padding:12px 15px;margin-bottom:12px}.quest-icon{font-size:29px;color:#b38635}.quest strong{font-size:13px}.quest p{font-size:11px;color:#91816a;margin:5px 0 0}.quest output{margin-left:auto;white-space:nowrap;background:#f3e7cb;padding:8px 11px;border-radius:6px;color:#9c7134;font-size:14px;font-weight:700}.scene{position:relative;overflow:hidden;border:4px solid #746e4a;border-radius:10px;box-shadow:0 5px 0 #c8bb96;background:#a9ba7e}canvas{width:100%;height:auto;display:block;image-rendering:pixelated;touch-action:none}.scene-note{position:absolute;bottom:9px;left:12px;padding:5px 8px;background:#fff1cbd6;border:1px solid #ead7a6;border-radius:4px;color:#7d7655;font-size:8px;letter-spacing:1px;pointer-events:none}.message{background:#eee7d3;border-radius:7px;padding:11px 13px;margin:14px 0 11px;font-size:12px;min-height:40px;color:#6b6147}footer{display:flex;align-items:center;justify-content:space-between;gap:15px}.controls{display:grid;grid-template-columns:repeat(3,44px);gap:4px}.controls button{height:44px;padding:0;font-size:19px}.controls .up{grid-column:2}.controls button:nth-child(2){grid-column:1}.keyboard{display:grid;gap:8px;font-size:10px;color:#8e8168}.keyboard kbd{font-family:inherit;font-size:9px;background:#fff9ec;border:1px solid #ded2b5;border-radius:3px;padding:3px 5px}.interact{background:#667f52;border-color:#587146;color:#fff8de;font-size:12px;min-height:44px;box-shadow:0 3px 0 #465d37}.interact:hover{background:#78925f}.interact span{margin-left:15px;color:#e7dba5}.smallprint{font-size:10px;color:#9a8e73;text-align:center;margin:15px 0 0}.victory{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;background:#384a32e8;color:#fff1cc;padding:20px}.victory[hidden]{display:none}.victory>span{font-size:55px;color:#edc66a}.victory h2{font-family:Georgia,serif;font-size:30px;font-weight:400;line-height:1.3;margin:10px 0}.victory p{font-size:13px;margin:0 0 22px;color:#d1d6b9}.victory button{background:#edcf89;border-color:#f9dda2;color:#59492a;box-shadow:0 3px 0 #917947}button:disabled{opacity:.5;cursor:default}@media(max-width:520px){body{padding:10px}h1{font-size:25px}.eyebrow{font-size:7px;letter-spacing:1px}.quest{padding:10px;gap:8px}.quest strong{font-size:11px}.quest p{font-size:9px}.quest output{font-size:12px;padding:7px}.keyboard{display:none}.message{font-size:11px;line-height:1.6;min-height:54px}.victory h2{font-size:24px}.victory p{font-size:11px}.scene-note{font-size:6px;bottom:5px;left:5px}.controls{grid-template-columns:repeat(3,44px)}.controls button{height:44px}.interact{padding:10px 13px}}`;

const javascript = String.raw`(function(root){
'use strict';
var COLS=24,ROWS=16,DOOR={x:12,y:7};
var SPARKS=[{id:'orchard',x:5,y:5},{id:'creek',x:19,y:8},{id:'meadow',x:6,y:12}];
var TREES=[[2,2],[3,2],[2,3],[20,2],[21,2],[21,3],[3,9],[2,10],[22,8],[15,12],[16,13]];
function blocked(x,y){return !Number.isInteger(x)||!Number.isInteger(y)||x<1||y<1||x>22||y>14||(x>=8&&x<=15&&y>=2&&y<=6)||(x>=18&&x<=22&&y>=11&&y<=14)||TREES.some(function(t){return t[0]===x&&t[1]===y});}
function createState(){return {player:{x:12,y:12},collected:[],delivered:false,steps:0,facing:'down'};}
function move(state,dx,dy){
 if(state.delivered||!Number.isInteger(dx)||!Number.isInteger(dy)||Math.abs(dx)+Math.abs(dy)!==1)return state;
 var x=state.player.x+dx,y=state.player.y+dy;
 if(blocked(x,y))return state;
 return Object.assign({},state,{player:{x:x,y:y},steps:state.steps+1,facing:dy<0?'up':dy>0?'down':dx<0?'left':'right'});
}
function near(a,b){return Math.abs(a.x-b.x)+Math.abs(a.y-b.y)<=1;}
function interact(state){
 if(state.delivered)return state;
 var spark=SPARKS.find(function(s){return state.collected.indexOf(s.id)<0&&near(state.player,s)});
 if(spark)return Object.assign({},state,{collected:state.collected.concat(spark.id)});
 if(state.collected.length===SPARKS.length&&near(state.player,DOOR))return Object.assign({},state,{delivered:true});
 return state;
}
function reset(){return createState();}
var api={COLS:COLS,ROWS:ROWS,DOOR:DOOR,SPARKS:SPARKS,TREES:TREES,blocked:blocked,createState:createState,move:move,interact:interact,reset:reset};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.PixelVillage=api;
if(typeof document==='undefined')return;
var canvas=document.getElementById('world');if(!canvas)return;
var ctx=canvas.getContext('2d');if(!ctx)return;
ctx.imageSmoothingEnabled=false;
var state=createState(),visual={x:12*32+16,y:12*32+16},held=null,lastFrame=0;
var motionPreference=root.matchMedia('(prefers-reduced-motion: reduce)'),reduceMotion=motionPreference.matches;
motionPreference.addEventListener('change',function(e){reduceMotion=e.matches});
var count=document.getElementById('count'),message=document.getElementById('message'),victory=document.getElementById('victory');
function rect(x,y,w,h,color){ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),w,h);}
function line(x,y,w,color){rect(x,y,w,2,color);}
function tree(tx,ty,size){
 var x=tx*32+16,y=ty*32+27,s=size||1;
 ctx.save();ctx.translate(x,y);ctx.scale(s,s);ctx.fillStyle='#516d4c40';ctx.fillRect(-19,3,38,10);
 rect(-5,-13,11,22,'#816444');rect(1,-11,5,20,'#6d503a');
 rect(-22,-35,44,20,'#6b8e5d');rect(-17,-48,34,32,'#759a67');rect(-10,-56,22,16,'#829e6b');
 rect(-25,-27,8,11,'#637f54');rect(-16,-37,8,5,'#8aa371');rect(9,-34,12,8,'#608452');rect(-9,-51,9,4,'#92ac77');rect(-19,-13,38,5,'#5d8052');ctx.restore();
}
function flower(x,y,color){rect(x,y,2,6,'#7f9555');rect(x-2,y-2,6,3,color);rect(x,y-4,2,7,color);rect(x,y-1,2,2,'#f5d891');}
function cottage(){
 rect(247,211,288,23,'#62754b40');
 rect(260,120,246,96,'#9c7352');rect(266,121,234,90,'#d3af78');rect(266,178,234,33,'#ba905d');
 for(var y=128;y<210;y+=26)rect(266,y,234,4,'#ac8054');
 for(var x=270;x<500;x+=57){rect(x,126,5,84,'#785538');rect(x+5,128,3,80,'#956b45');}
 rect(276,156,50,40,'#79553d');rect(281,161,40,27,'#526f62');rect(299,161,4,27,'#a98253');rect(280,173,42,4,'#b18c5c');
 rect(443,148,42,43,'#79553d');rect(448,153,32,29,state.delivered?'#f6cc70':'#526f62');rect(462,153,4,29,'#ab8252');rect(448,167,32,4,'#ab8252');
 rect(362,156,57,60,'#76503c');rect(368,161,45,55,'#8f6142');rect(373,164,14,47,'#a17248');rect(394,165,13,46,'#9a6b45');rect(400,190,5,5,'#dfb465');
 rect(357,211,69,8,'#72573d');rect(352,219,79,8,'#a38a61');rect(358,227,67,5,'#c3aa77');
 rect(240,103,280,24,'#70463a');rect(249,80,263,25,'#8d4b3d');rect(261,56,239,26,'#a75544');rect(274,39,212,19,'#b65d49');
 for(var ry=52;ry<123;ry+=19){for(var rx=255;rx<510;rx+=39){rect(rx+(ry%2)*12,ry,29,3,'#844637');rect(rx+7,ry+4,11,2,'#be674e');}}
 rect(286,39,13,50,'#7f4838');rect(294,44,6,38,'#a66149');rect(427,22,24,48,'#947f62');rect(423,20,32,9,'#b39a72');rect(430,35,14,4,'#746651');rect(433,48,15,4,'#746651');
 rect(242,124,277,6,'#e3bc7c');rect(249,130,12,80,'#78553b');rect(504,130,10,78,'#78553b');
 rect(337,131,93,22,'#ead5a0');rect(343,137,82,3,'#b58f59');rect(370,143,31,3,'#b58f59');
 rect(329,202,23,20,'#9b7048');rect(333,201,15,4,'#ce9760');rect(331,209,19,3,'#785b3d');flower(339,195,'#dca37b');
 rect(452,208,31,22,'#987345');rect(449,212,37,4,'#b2915c');rect(449,222,37,4,'#755e40');
 rect(428,180,5,33,'#765638');rect(425,171,11,15,state.delivered?'#ffe3a0':'#bea65f');rect(427,174,7,10,state.delivered?'#fff0af':'#e8c987');
 if(state.delivered){ctx.fillStyle='#ffe6a336';ctx.beginPath();ctx.arc(430,179,34,0,Math.PI*2);ctx.fill();}
}
function player(time){
 var px=visual.x,py=visual.y,bob=Math.abs(visual.x-(state.player.x*32+16))+Math.abs(visual.y-(state.player.y*32+16))>2?Math.sin(time/80)*2:0;
 ctx.save();ctx.translate(Math.round(px),Math.round(py+bob));
 rect(-9,8,20,5,'#536e474d');rect(-6,2,5,9,'#584b3b');rect(2,2,5,9,'#584b3b');rect(-8,-10,17,14,'#68838b');rect(-10,-7,4,9,'#ebc08c');rect(8,-7,4,9,'#ebc08c');rect(-6,-21,13,12,'#edc18d');rect(-9,-24,19,7,'#80573d');rect(-13,-18,28,4,'#795236');rect(-4,-29,10,6,'#8f6342');rect(2,-14,2,2,'#544735');rect(-7,2,15,3,'#53727b');ctx.restore();
}
function draw(time){
 rect(0,0,768,512,'#a9ba7e');
 for(var gy=0;gy<512;gy+=16){for(var gx=0;gx<768;gx+=16){var seed=(gx*7+gy*13)%79;if(seed<17){rect(gx+4,gy+7,3,2,'#9bb276');rect(gx+6,gy+4,2,4,'#93a86c');}}}
 // Warm sand paths and an irregular pond.
 rect(352,218,72,294,'#b3b886');rect(360,222,56,290,'#e7ca96');rect(0,278,768,64,'#b6ba85');rect(0,286,768,48,'#e8cc9a');rect(150,138,47,176,'#e8cc9a');rect(604,285,42,76,'#e8cc9a');
 for(var p=0;p<32;p++){var sx=(p*73+21)%768,sy=291+(p*11)%37;rect(sx,sy,4,2,'#d5b986');}for(var py=240;py<512;py+=29)rect(378+(py%17),py,4,2,'#cfb27f');
 rect(565,345,176,145,'#e5cb94');rect(577,353,157,128,'#89afa2');rect(590,345,131,143,'#89afa2');
 for(var w=0;w<13;w++){var wx=594+(w*31)%120,wy=365+(w*23)%105;rect(wx,wy,13,2,'#b3cbb7');}
 rect(564,366,23,42,'#9a7b51');for(var b=0;b<4;b++)rect(563,369+b*10,26,3,'#b79763');rect(561,365,3,46,'#765b3e');rect(588,365,3,46,'#765b3e');
 for(var edge=0;edge<24;edge++){if(edge<9||edge>14){tree(edge,0,.95);tree(edge,15,.78);}}
 tree(0,4,1.2);tree(23,5,1.2);tree(0,9,1.1);tree(23,13,1.1);
 // Lower props remain visible but every solid tree has a matching tile.
 TREES.filter(function(t){return t[1]<7}).forEach(function(t){tree(t[0],t[1],1.1)});
 cottage();
 // Orchard planter and flower beds.
 rect(92,171,41,8,'#856949');rect(98,160,29,13,'#799352');rect(92,175,41,4,'#c5a170');
 [[116,221],[212,372],[178,396],[530,272],[700,185],[462,304],[75,289],[555,448]].forEach(function(f,i){flower(f[0],f[1],i%2?'#ead6a0':'#dbac8c')});
 // A sign marks the destination instead of requiring unexplained discovery.
 rect(440,238,4,33,'#896d49');rect(424,239,36,18,'#e2cc93');rect(429,244,25,3,'#aa8050');rect(437,249,9,3,'#aa8050');
 SPARKS.forEach(function(s,i){if(state.collected.indexOf(s.id)>=0)return;var sx=s.x*32+16,sy=s.y*32+12+Math.sin(time/420+i)*3;ctx.fillStyle='#ffe39d30';ctx.beginPath();ctx.arc(sx,sy,18,0,Math.PI*2);ctx.fill();rect(sx-3,sy-7,6,15,'#ffe8a3');rect(sx-7,sy-3,14,6,'#f8d575');rect(sx-2,sy-2,4,4,'#fff3cb');});
 if(state.player.y<9)player(time);
 TREES.filter(function(t){return t[1]>=7}).forEach(function(t){tree(t[0],t[1],1.1)});
 if(state.player.y>=9)player(time);
 // Tiny butterflies are decorative; the quest has no timer.
 var butterfly=Math.sin(time/650)*9;rect(218+butterfly,108,4,3,'#e8d29d');rect(224+butterfly,106,4,4,'#e8d29d');
}
function refresh(previous){
 count.textContent=state.collected.length+' / 3';canvas.dataset.x=String(state.player.x);canvas.dataset.y=String(state.player.y);canvas.dataset.collected=String(state.collected.length);canvas.dataset.delivered=String(state.delivered);
 canvas.setAttribute('aria-label','Bản đồ ngôi làng. Vị trí '+state.player.x+', '+state.player.y+'. Đã tìm '+state.collected.length+' trên 3 hạt sáng.');
 victory.hidden=!state.delivered;
 if(state.delivered)message.textContent='Hoàn thành! Bạn đã thắp đèn cho căn nhà sau '+state.steps+' bước chân.';
 else if(previous&&previous.collected.length<state.collected.length)message.textContent=state.collected.length===3?'Đủ ba hạt sáng rồi! Về bậc cửa căn nhà mái đỏ và nhấn E.':'Bạn vừa nhặt một hạt sáng. Còn '+(3-state.collected.length)+' hạt nữa quanh làng.';
 else if(near(state.player,DOOR))message.textContent=state.collected.length===3?'Bạn đã về đến nhà. Nhấn E hoặc Tương tác để thắp đèn.':'Căn nhà cần đủ 3 hạt sáng. Hãy khám phá hai bên đường và bên bờ suối.';
 else if(SPARKS.some(function(s){return state.collected.indexOf(s.id)<0&&near(state.player,s)}))message.textContent='Một hạt sáng ở ngay bên cạnh! Nhấn E, phím cách hoặc Tương tác để nhặt.';
 else message.textContent=state.collected.length===3?'Mang ánh sáng về bậc cửa căn nhà mái đỏ phía bắc.':'Đi tìm ba hạt sáng đang lấp lánh quanh làng.';
}
function perform(dx,dy){var prev=state;state=move(state,dx,dy);refresh(prev);}
function act(){var prev=state;state=interact(state);refresh(prev);}
function restart(){stopHold();state=reset();visual.x=state.player.x*32+16;visual.y=state.player.y*32+16;refresh();canvas.focus();}
var directions={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
document.addEventListener('keydown',function(e){if(e.ctrlKey||e.metaKey||e.altKey)return;var key=e.key.toLowerCase(),dir=key==='arrowup'||key==='w'?'up':key==='arrowdown'||key==='s'?'down':key==='arrowleft'||key==='a'?'left':key==='arrowright'||key==='d'?'right':null;if(dir){e.preventDefault();perform.apply(null,directions[dir]);}else if(key==='e'||key===' '){e.preventDefault();if(!e.repeat)act();}});
function stopHold(){if(held!==null)clearInterval(held);held=null;}
document.querySelectorAll('[data-direction]').forEach(function(button){
 function step(){var dir=directions[button.dataset.direction];perform.apply(null,dir);}
 button.addEventListener('pointerdown',function(e){e.preventDefault();stopHold();step();button.setPointerCapture(e.pointerId);held=setInterval(step,145);});
 button.addEventListener('pointerup',stopHold);button.addEventListener('pointercancel',stopHold);button.addEventListener('lostpointercapture',stopHold);
 button.addEventListener('click',function(e){if(e.detail===0)step();});
});
root.addEventListener('blur',stopHold);document.addEventListener('visibilitychange',function(){if(document.hidden)stopHold()});
document.getElementById('interact').addEventListener('click',act);document.getElementById('reset').addEventListener('click',restart);document.getElementById('again').addEventListener('click',restart);canvas.addEventListener('pointerdown',function(){canvas.focus()});
function frame(time){var elapsed=Math.min(time-lastFrame,48);lastFrame=time;var blend=reduceMotion?1:1-Math.exp(-elapsed/50);visual.x+=(state.player.x*32+16-visual.x)*blend;visual.y+=(state.player.y*32+16-visual.y)*blend;draw(reduceMotion?0:time);root.requestAnimationFrame(frame);}
refresh();root.requestAnimationFrame(frame);
})(globalThis);`;

const tests = String.raw`'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const game=require('./game.js');
function route(state,target){
 const queue=[{x:state.player.x,y:state.player.y,path:[]}],seen=new Set([state.player.x+','+state.player.y]);
 while(queue.length){const next=queue.shift();if(next.x===target.x&&next.y===target.y)return next.path.reduce((s,d)=>game.move(s,d[0],d[1]),state);for(const d of [[0,-1],[1,0],[0,1],[-1,0]]){const x=next.x+d[0],y=next.y+d[1],key=x+','+y;if(!game.blocked(x,y)&&!seen.has(key)){seen.add(key);queue.push({x,y,path:next.path.concat([d])});}}}
 throw Error('Quest destination is unreachable');
}
test('movement is cardinal, immutable and blocked by house, trees, pond and map edges',()=>{
 const state=game.createState(),next=game.move(state,-1,0);
 assert.deepEqual(next.player,{x:11,y:12});assert.deepEqual(state.player,{x:12,y:12});assert.equal(next.steps,1);
 assert.strictEqual(game.move(state,1,1),state);assert.strictEqual(game.move(state,0,0),state);assert.strictEqual(game.move(state,99,0),state);
 for(const obstacle of [{x:12,y:6},{x:2,y:2},{x:19,y:12},{x:0,y:8}])assert.equal(game.blocked(obstacle.x,obstacle.y),true);
 const doorstep=Object.assign({},state,{player:{x:12,y:7}});assert.strictEqual(game.move(doorstep,0,-1),doorstep);
});
test('interaction requires proximity and every spark is collectible only once',()=>{
 let state=game.createState();assert.strictEqual(game.interact(state),state);
 state=route(state,game.SPARKS[0]);const previous=state;state=game.interact(state);
 assert.equal(state.collected.length,1);assert.deepEqual(previous.collected,[]);assert.equal(state.collected[0],game.SPARKS[0].id);
 assert.strictEqual(game.interact(state),state);assert.equal(state.delivered,false);
});
test('all sparks and the cottage are reachable; winning requires delivery and reset starts fresh',()=>{
 let state=route(game.createState(),game.DOOR);assert.strictEqual(game.interact(state),state);
 for(const spark of game.SPARKS){state=route(state,spark);state=game.interact(state);}
 assert.equal(state.collected.length,3);assert.equal(state.delivered,false);
 assert.strictEqual(game.interact(state),state);
 state=route(state,game.DOOR);state=game.interact(state);assert.equal(state.delivered,true);
 assert.strictEqual(game.move(state,1,0),state);assert.strictEqual(game.interact(state),state);
 const fresh=game.reset();assert.deepEqual(fresh,game.createState());assert.notStrictEqual(fresh.collected,state.collected);assert.equal(fresh.delivered,false);
});`;

export const STARTER_FILES: Array<{path: string; content: string}> = [
  {path: 'index.html', content: html}, {path: 'style.css', content: css},
  {path: 'game.js', content: javascript}, {path: 'game.test.js', content: tests},
];
