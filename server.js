'use strict';
// TINY KINGDOMS v0.4 — zero-dependency Node WebSocket game server.
// Prototype for 2 trusted players; deploy behind HTTPS/WSS for internet play.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const WIDTH = 48, HEIGHT = 32, TICK = 0.1, ROUND_SECONDS = 900;
const BASE_POS = [{x:5.5,y:16},{x:42.5,y:16}];
const BUILDINGS = {
  lumber:{name:'製材所',wood:40,iron:0,time:5,hp:180,range:0},
  mine:{name:'採掘所',wood:55,iron:0,time:6,hp:180,range:0},
  barracks:{name:'兵舎',wood:70,iron:20,time:10,hp:240,range:0},
  outpost:{name:'前哨基地',wood:60,iron:15,time:8,hp:250,range:5},
  tower:{name:'見張り塔',wood:50,iron:25,time:7,hp:230,range:0}
};
const UPGRADES = {
  lumber:[{id:'fast',name:'高速製材',description:'採取速度+70%',wood:65,iron:0,time:10},{id:'efficient',name:'高効率製材',description:'資源1→木材1.25',wood:65,iron:0,time:10}],
  mine:[{id:'machine',name:'機械採掘',description:'採掘速度+60%',wood:70,iron:10,time:12},{id:'armored',name:'防護採掘',description:'HPが2倍',wood:70,iron:10,time:12}],
  barracks:[{id:'mass',name:'徴兵兵舎',description:'生産時間-30%',wood:80,iron:35,time:15},{id:'elite',name:'精鋭兵舎',description:'新兵のHP/攻撃+20%',wood:80,iron:35,time:15}],
  outpost:[{id:'pioneer',name:'開拓基地',description:'領土半径+30%',wood:90,iron:30,time:15},{id:'fort',name:'要塞基地',description:'HP+80%/視界+20%',wood:90,iron:30,time:15}],
  tower:[{id:'damage',name:'射撃塔',description:'攻撃+40%',wood:65,iron:35,time:12},{id:'vision',name:'監視塔',description:'視界+60%',wood:65,iron:35,time:12}]
};
const TROOPS = {
  shield:{name:'盾兵',wood:0,iron:15,time:7,hp:100,damage:13,range:0.87,period:1.2,speed:1.75,sight:4},
  archer:{name:'弓兵',wood:10,iron:12,time:6,hp:65,damage:11,range:3.15,period:1.5,speed:1.85,sight:4.8},
  scout:{name:'斥候兵',wood:15,iron:7,time:5,hp:55,damage:8,range:0.95,period:0.8,speed:2.9,sight:7}
};
let nextId = 1;
const rooms = new Map();
const now = () => Date.now();
const randomId = () => (nextId++).toString(36);
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const round = (n) => Math.round(n*10)/10;
const within = (x,y) => Number.isFinite(x)&&Number.isFinite(y)&&x>1&&x<WIDTH-1&&y>1&&y<HEIGHT-1;
function rng(seed){let n=seed>>>0;return ()=>{n+=0x6d2b79f5;let t=n;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
function mapFor(seed){
  const r=rng(seed); const sites=[],rocks=[];
  const addSite=(type,x,y,stock)=>sites.push({id:randomId(),type,x:round(x),y:round(y),stock,max:stock,claimed:null,spent:false});
  const pair=(type,x,y,stock)=>{addSite(type,x,y,stock);addSite(type,WIDTH-x,HEIGHT-y,stock);};
  // Guaranteed equal starting resources in both kingdoms.
  pair('forest',9.0,12.3,480); pair('ore',9.1,19.8,240);
  pair('forest',14.4,7.6,460); pair('ore',14.6,24.3,230);
  pair('forest',16.5,16.3,460); pair('ore',19,10,235);
  for(let i=0;i<5;i++){
    const x=11+r()*9,y=3.5+r()*25;
    if(sites.some(s=>Math.hypot(s.x-x,s.y-y)<3.4))continue;
    pair(i%2?'ore':'forest',x,y,i%2?210:410);
  }
  // Impassable small rock clusters; entrances around the central routes stay open.
  for(let i=0;i<13;i++){
    const x=11+r()*10, y=3.3+r()*25.4;
    if(Math.abs(y-16)<2.2||[7,16,25].some(v=>Math.abs(y-v)<2.1&&x>19))continue;
    if(sites.some(s=>distance(s,{x,y})<2.1))continue;
    const rock={x:round(x),y:round(y),r:round(0.7+r()*0.45)};
    rocks.push(rock,{x:round(WIDTH-x),y:round(HEIGHT-y),r:rock.r});
  }
  return {sites,rocks,seed};
}
function newGame(seed){
  const map=mapFor(seed);
  const players=[0,1].map(side=>({side,wood:170,iron:50,kills:0,seen:{},notes:[],orders:[{mode:'defend',x:BASE_POS[side].x,y:BASE_POS[side].y},{mode:'defend',x:BASE_POS[side].x,y:BASE_POS[side].y}],connected:true}));
  const buildings=BASE_POS.map((p,side)=>({id:randomId(),side,type:'castle',x:p.x,y:p.y,hp:900,maxHp:900,buildLeft:0,upgrade:null,upgradeLeft:0,lv:1,linked:true,isolated:0,queue:[],working:null,site:null,cd:0}));
  const units=[];
  for(let side=0;side<2;side++)for(let squad=0;squad<2;squad++){
    const type=squad===0?'shield':'scout',p=BASE_POS[side];
    units.push(spawn(side,type,squad,p.x+(side===0?1:-1),p.y+(squad?1:-1),false));
  }
  return {seed,map,players,buildings,units,time:0,ended:false,winner:null,event:'',capture:[{owner:null,progress:0,attacker:null},{owner:null,progress:0,attacker:null},{owner:null,progress:0,attacker:null}],log:[],frame:0};
}
function spawn(side,type,squad,x,y,elite){const c=TROOPS[type];return {id:randomId(),side,type,squad,x,y,hp:c.hp*(elite?1.2:1),maxHp:c.hp*(elite?1.2:1),power:elite?1.2:1,cd:0,path:[],pathStep:0,elite,offset:Math.random()*Math.PI*2};}
function groundClear(game,x,y,radius=.7){
  return !game.map.rocks.some(rock=>Math.hypot(rock.x-x,rock.y-y)<rock.r+radius) &&
    !game.buildings.some(b=>b.hp>0&&Math.hypot(b.x-x,b.y-y)<radius+0.88) &&
    !game.map.sites.some(s=>!s.spent&&Math.hypot(s.x-x,s.y-y)<radius+0.6);
}
function circle(b){return b.type==='castle'?6.3 : b.upgrade==='pioneer'?6.5:5;}
function computeLinks(game,side){
  const b=game.buildings.filter(b=>b.side===side&&b.hp>0);
  const links=new Set(b.filter(b=>b.type==='castle').map(b=>b.id));
  // Outposts connect only through touching friendly connected territory.
  let changed=true;
  while(changed){changed=false; for(const post of b){if(post.type!=='outpost'||links.has(post.id)||post.buildLeft>0)continue;
    if(b.some(other=>links.has(other.id)&&distance(post,other)<=circle(other)+0.02)){links.add(post.id);changed=true;}
  }}
  for(const building of b){const linked=building.type==='castle'||[...b].some(c=>links.has(c.id)&&distance(building,c)<=circle(c)+0.05);
    building.linked=linked;
  }
  return b.filter(c=>links.has(c.id)&&c.buildLeft<=0);
}
function canBuild(game,side,type,x,y){
  if(!BUILDINGS[type]||!within(x,y))return '建設位置がマップ外です';
  const linked=computeLinks(game,side);
  if(!linked.some(b=>distance(b,{x,y})<=circle(b)-0.3))return '自国の領土内に配置してください';
  if(game.buildings.filter(b=>b.side===1-side&&b.hp>0&&(b.type==='castle'||b.type==='outpost')&&b.buildLeft<=0).some(b=>distance(b,{x,y})<circle(b)))return '敵の領土には建設できません';
  if(!groundClear(game,x,y))return '地形または他の建物と重なっています';
  if(game.units.some(u=>u.side!==side&&distance(u,{x,y})<2.7))return '敵部隊が近くにいます';
  if(type==='outpost'&&game.buildings.filter(b=>b.side===side&&b.type==='outpost'&&b.hp>0).length>=3)return '前哨基地は最大3か所です';
  if(['lumber','mine'].includes(type)){
    const t=type==='lumber'?'forest':'ore';
    const valid=game.map.sites.filter(s=>s.type===t&&s.stock>0&&!s.claimed&&distance(s,{x,y})<=5.4)
      .sort((a,b)=>distance(a,{x,y})-distance(b,{x,y}));
    if(!valid.length)return '未使用の資源地の近くに配置してください';
  }
  return null;
}
function event(game,msg){game.log.unshift({msg,at:round(game.time)});if(game.log.length>9)game.log.length=9;}
function action(game,side,a){
  const p=game.players[side];
  if(game.ended||!a||typeof a!=='object')return {error:'試合は終了しました'};
  if(a.kind==='build'){
    const type=a.type,x=Number(a.x),y=Number(a.y),c=BUILDINGS[type];
    const err=canBuild(game,side,type,x,y);if(err)return {error:err};
    if(p.wood<c.wood||p.iron<c.iron)return {error:'資源が不足しています'};
    p.wood-=c.wood;p.iron-=c.iron;
    let site=null;
    if(type==='lumber'||type==='mine'){
      site=game.map.sites.filter(s=>s.type===(type==='lumber'?'forest':'ore')&&s.stock>0&&!s.claimed&&distance(s,{x,y})<=5.4).sort((a,b)=>distance(a,{x,y})-distance(b,{x,y}))[0];site.claimed='reserved';
    }
    const b={id:randomId(),side,type,x:round(x),y:round(y),hp:c.hp,maxHp:c.hp,buildLeft:c.time,upgrade:null,upgradeLeft:0,lv:1,linked:true,isolated:0,queue:[],working:null,site:site?.id||null,cd:0};
    if(site)site.claimed=b.id;
    game.buildings.push(b);event(game,`${side===0?'青':'赤'}国が${c.name}を建設開始`);
    return {ok:'建設を開始しました'};
  }
  if(a.kind==='upgrade'){
    const b=game.buildings.find(b=>b.id===a.id&&b.side===side&&b.hp>0);
    if(!b||!UPGRADES[b.type])return {error:'施設を選択してください'};
    if(b.buildLeft>0||b.upgradeLeft>0||b.lv>1)return {error:'この施設は現在強化できません'};
    if(!b.linked)return {error:'補給線が切れています'};
    const c=UPGRADES[b.type].find(u=>u.id===a.branch);if(!c)return {error:'強化先が不正です'};
    if(p.wood<c.wood||p.iron<c.iron)return {error:'資源が不足しています'};
    p.wood-=c.wood;p.iron-=c.iron;b.upgradeLeft=c.time;b.upgradeTarget=c.id;
    return {ok:`${c.name}へ強化開始`};
  }
  if(a.kind==='recruit'){
    const b=game.buildings.find(b=>b.id===a.id&&b.side===side&&b.type==='barracks'&&b.hp>0);
    const type=a.type,squad=Number(a.squad),c=TROOPS[type];
    if(!b||!c||![0,1].includes(squad)||b.buildLeft>0)return {error:'兵舎か兵種を確認してください'};
    if(b.queue.length>=12)return {error:'生産予約は最大12体です'};
    const own=game.buildings.filter(b=>b.side===side);
    const total=game.units.filter(u=>u.side===side).length+own.reduce((n,v)=>n+v.queue.length+(v.working?1:0),0);
    const inSquad=game.units.filter(u=>u.side===side&&u.squad===squad).length+
      own.reduce((n,v)=>n+v.queue.filter(q=>q.squad===squad).length+(v.working?.squad===squad?1:0),0);
    if(total>=16)return {error:'全軍16体が上限です'};
    if(inSquad>=8)return {error:'1部隊の上限は8体です'};
    b.queue.push({type,squad});return {ok:`${c.name}を第${squad+1}部隊に予約`};
  }
  if(a.kind==='order'){
    const squad=Number(a.squad),mode=a.mode;
    if(![0,1].includes(squad)||!['march','defend','retreat'].includes(mode))return {error:'指示が不正です'};
    const castle=BASE_POS[side],x=mode==='retreat'?castle.x:Number(a.x),y=mode==='retreat'?castle.y:Number(a.y);
    if(!within(x,y))return {error:'指示地点がマップ外です'};
    p.orders[squad]={mode,x:round(x),y:round(y)};
    for(const u of game.units.filter(u=>u.side===side&&u.squad===squad))assignPath(game,u,p.orders[squad]);
    return {ok:mode==='retreat'?'撤退を指示しました':`第${squad+1}部隊に指示しました`};
  }
  return {error:'不明な操作です'};
}
function blockTile(game,tx,ty){
  if(tx<0||ty<0||tx>=WIDTH||ty>=HEIGHT)return true;
  const c={x:tx+.5,y:ty+.5};return game.map.rocks.some(r=>distance(r,c)<r.r+.36);
}
function assignPath(game,u,order){
  const k=Number.parseInt(u.id,36)||1,offset=(k%7-3)*0.29,offY=(Math.floor(k/7)%7-3)*0.29;
  const ex=clamp(order.x+offset,1,WIDTH-1),ey=clamp(order.y+offY,1,HEIGHT-1);
  const sx=clamp(Math.floor(u.x),0,WIDTH-1),sy=clamp(Math.floor(u.y),0,HEIGHT-1);
  const gx=clamp(Math.floor(ex),0,WIDTH-1),gy=clamp(Math.floor(ey),0,HEIGHT-1);
  const start=sy*WIDTH+sx,goal=gy*WIDTH+gx;
  if(start===goal){u.path=[{x:ex,y:ey}];u.pathStep=0;return;}
  const queue=[start],prev=new Int32Array(WIDTH*HEIGHT).fill(-1);prev[start]=start;
  let head=0;const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  while(head<queue.length){const index=queue[head++],cx=index%WIDTH,cy=Math.floor(index/WIDTH);
    if(index===goal)break;
    for(const [dx,dy] of dirs){const nx=cx+dx,ny=cy+dy,n=ny*WIDTH+nx;
      if(blockTile(game,nx,ny)||prev[n]!==-1)continue;
      if(dx&&dy&&(blockTile(game,cx+dx,cy)||blockTile(game,cx,cy+dy)))continue;
      prev[n]=index;queue.push(n);
    }
  }
  if(prev[goal]===-1){u.path=[{x:ex,y:ey}];u.pathStep=0;return;}
  const route=[];let p=goal;
  while(p!==start&&route.length<100){route.push({x:(p%WIDTH)+.5,y:Math.floor(p/WIDTH)+.5});p=prev[p];}
  route.reverse();route.push({x:ex,y:ey});u.path=route;u.pathStep=0;
}
function nearestTarget(game,u,sight){
  const enemyUnits=game.units.filter(v=>v.side!==u.side&&v.hp>0&&distance(v,u)<sight);
  const enemyBuildings=game.buildings.filter(v=>v.side!==u.side&&v.hp>0&&v.buildLeft<=0&&distance(v,u)<sight);
  const choices=[...enemyUnits,...enemyBuildings];choices.sort((a,b)=>distance(a,u)-distance(b,u));
  return choices[0]||null;
}
function moveToward(game,u,target,dt){
  const speed=TROOPS[u.type].speed*(game.map.sites.some(s=>s.type==='forest'&&!s.spent&&distance(s,u)<1.8)?.83:1);
  const dx=target.x-u.x,dy=target.y-u.y,d=Math.hypot(dx,dy);
  if(d<.11)return;
  const step=Math.min(d,speed*dt),nx=u.x+dx/d*step,ny=u.y+dy/d*step;
  if(!blockTile(game,Math.floor(nx),Math.floor(ny))){u.x=nx;u.y=ny;}
}
function damage(game,t,dmg,side){t.hp-=dmg;if(t.hp<=0){t.hp=0;if(t.type==='castle'){game.ended=true;game.winner=side;event(game,`${side===0?'青':'赤'}国が敵の本拠地を破壊して勝利！`);} }}
function update(game,dt){
  if(game.ended)return;
  game.time+=dt;game.frame++;
  const linked=[computeLinks(game,0),computeLinks(game,1)];
  // Base passive resources, and bonuses from held central sites.
  for(let side=0;side<2;side++){
    const p=game.players[side];p.wood+=dt*(1+(game.capture[2].owner===side?1.2:0));p.iron+=dt*(.3+(game.capture[0].owner===side?.7:0));
  }
  for(const b of game.buildings){
    if(b.hp<=0)continue;
    if(b.buildLeft>0){b.buildLeft=Math.max(0,b.buildLeft-dt);continue;}
    if(b.upgradeLeft>0){b.upgradeLeft-=dt;if(b.upgradeLeft<=0){b.upgrade=b.upgradeTarget;b.lv=2;b.upgradeLeft=0;
      if(b.upgrade==='armored'){b.maxHp*=2;b.hp*=2;}if(b.upgrade==='fort'){b.maxHp*=1.8;b.hp*=1.8;}
      event(game,`${b.side===0?'青':'赤'}国の${BUILDINGS[b.type]?.name}が強化完了`);
    }}
    if(!b.linked){b.isolated+=dt;}else b.isolated=0;
    const working=b.linked||b.isolated<15;
    if(['lumber','mine'].includes(b.type)&&working){
      const site=game.map.sites.find(s=>s.id===b.site);
      if(site&&site.stock>0){const rate=b.type==='lumber'?3:1.5,dist=distance(site,b);
        const ratio=dist<3.3?1:0.6;
        const speed=rate*ratio*(b.upgrade==='fast'?1.7:b.upgrade==='machine'?1.6:1);
        const efficiency=b.upgrade==='efficient'?1.25:1;
        const use=Math.min(site.stock,speed*dt);site.stock-=use;
        game.players[b.side][b.type==='lumber'?'wood':'iron']+=use*efficiency;
        if(site.stock<=.001){site.stock=0;site.spent=true;site.claimed=null;event(game,`${b.type==='lumber'?'森林':'鉱脈'}の資源を採り尽くしました`);}
      }
    }
    if(b.type==='barracks'&&working){
      if(!b.working&&b.queue.length){
        const item=b.queue[0],c=TROOPS[item.type],p=game.players[b.side];
        if(p.wood>=c.wood&&p.iron>=c.iron){p.wood-=c.wood;p.iron-=c.iron;b.working=b.queue.shift();b.workLeft=c.time*(b.upgrade==='mass'?.7:1)*(game.capture[1].owner===b.side?.8:1);}
      }
      if(b.working){b.workLeft-=dt;if(b.workLeft<=0){
        const item=b.working,c=TROOPS[item.type],elite=b.upgrade==='elite';
        const angle=b.side===0?0:Math.PI,u=spawn(b.side,item.type,item.squad,b.x+Math.cos(angle)*1.25,b.y+Math.sin(angle)*1.25,elite);
        u.hp=c.hp*(elite?1.2:1);u.maxHp=u.hp;game.units.push(u);assignPath(game,u,game.players[b.side].orders[item.squad]);b.working=null;
      }}
    }
  }
  for(const u of game.units){
    if(u.hp<=0)continue;
    u.cd=Math.max(0,u.cd-dt);
    const config=TROOPS[u.type],order=game.players[u.side].orders[u.squad];
    const target=nearestTarget(game,u,config.range+2.9);
    const inZone=order.mode!=='defend'||distance(u,{x:order.x,y:order.y})<5.4;
    const canFight=order.mode!=='retreat'&&target&&inZone;
    if(canFight){
      const d=distance(u,target),range=config.range+(target.type&&BUILDINGS[target.type]&&target.type!=='castle'?.45:0);
      if(d<=range){if(u.cd<=0){damage(game,target,config.damage*u.power,u.side);u.cd=config.period;}}
      else if(d<config.range+2.9)moveToward(game,u,target,dt);
    }else{
      if(!u.path.length)assignPath(game,u,order);
      const step=u.path[u.pathStep];
      if(step){if(distance(u,step)<.18)u.pathStep++;
        else moveToward(game,u,step,dt);
      }
    }
    if(order.mode==='retreat'&&distance(u,BASE_POS[u.side])<3.1)u.hp=Math.min(u.maxHp,u.hp+1.2*dt);
  }
  for(const b of game.buildings){
    if(b.hp<=0||b.type!=='tower'||b.buildLeft>0)continue;
    b.cd=Math.max(0,b.cd-dt);
    const range=b.upgrade==='vision'?8.0:5.0;
    const targets=game.units.filter(u=>u.side!==b.side&&distance(u,b)<range).sort((x,y)=>distance(x,b)-distance(y,b));
    if(targets.length&&b.cd<=0){damage(game,targets[0],(b.upgrade==='damage'?17:12),b.side);b.cd=1.55;}
  }
  // Remove dead units/buildings and release collection site after destruction.
  game.units=game.units.filter(u=>u.hp>0);
  for(const b of game.buildings.filter(b=>b.hp<=0)){
    const site=game.map.sites.find(s=>s.id===b.site);if(site&&!site.spent&&site.claimed===b.id)site.claimed=null;
    if(b.type!=='castle')event(game,`${b.side===0?'青':'赤'}国の${BUILDINGS[b.type]?.name}が破壊されました`);
  }
  game.buildings=game.buildings.filter(b=>b.hp>0||b.type==='castle');
  // Neutral objectives: contested control only when one side has units nearby.
  const centers=[{x:24,y:7},{x:24,y:16},{x:24,y:25}];
  for(let i=0;i<3;i++){
    const c=game.capture[i],here=[0,1].map(side=>game.units.some(u=>u.side===side&&distance(u,centers[i])<2.45));
    if(here[0]!==here[1]){const side=here[0]?0:1;if(c.owner!==side){
      if(c.attacker!==side){c.attacker=side;c.progress=0;}
      c.progress+=dt;
      if(c.progress>=8){c.owner=side;c.progress=0;c.attacker=null;event(game,`${side===0?'青':'赤'}国が${['中央鉱山','古代遺跡','中央森林'][i]}を制圧`);}
    }}else if(!here[0]&&!here[1])c.progress=Math.max(0,c.progress-dt*.6);
  }
  if(game.time>=ROUND_SECONDS&&!game.ended){
    game.ended=true;
    const score=side=>game.capture.filter(c=>c.owner===side).length*200+game.buildings.filter(b=>b.side===side&&b.hp>0).length*24+Math.max(0,game.buildings.find(b=>b.side===side&&b.type==='castle')?.hp||0);
    const a=score(0),b=score(1);game.winner=a===b?null:a>b?0:1;event(game,game.winner===null?'時間切れで引き分け！':`${game.winner===0?'青':'赤'}国が判定勝利！`);
  }
}
function visionSources(game,side){
  const list=[];
  for(const b of game.buildings.filter(b=>b.side===side&&b.hp>0&&b.buildLeft<=0)){
    let r=b.type==='castle'?7:b.type==='outpost'?(b.upgrade==='fort'?7.2:6):b.type==='tower'?(b.upgrade==='vision'?10:7):3.5;
    list.push({x:b.x,y:b.y,r});
  }
  for(const u of game.units.filter(u=>u.side===side))list.push({x:u.x,y:u.y,r:TROOPS[u.type].sight});
  return list;
}
function seen(src,obj){return src.some(v=>distance(v,obj)<=v.r);}
function snapBuilding(b,ghost=false){return {id:b.id,side:b.side,type:b.type,x:round(b.x),y:round(b.y),hp:ghost?null:Math.max(0,Math.round(b.hp)),maxHp:ghost?null:b.maxHp,buildLeft:ghost?0:round(b.buildLeft),upgrade: b.upgrade,upgradeLeft:ghost?0:round(b.upgradeLeft),lv:b.lv,linked:ghost?null:b.linked,isolated:ghost?0:round(b.isolated),queue:ghost?[]:b.queue,working:ghost?null:b.working,site:ghost?null:b.site,ghost};}
function snapshot(game,side){
  const p=game.players[side],sources=visionSources(game,side),enemy=1-side;
  const buildings=[];
  for(const b of game.buildings){
    if(b.side===side){buildings.push(snapBuilding(b));continue;}
    if(b.type==='castle'){buildings.push({...snapBuilding(b,!seen(sources,b)),ghost:!seen(sources,b)});continue;}
    if(seen(sources,b)){const visible=snapBuilding(b);buildings.push(visible);p.seen[b.id]={...visible,ghost:true};}
  }
  for(const [id,b] of Object.entries(p.seen)){
    if(buildings.some(v=>v.id===id))continue;
    if(seen(sources,b)){delete p.seen[id];continue;}
    buildings.push({...b,ghost:true,hp:null,maxHp:null});
  }
  const units=game.units.filter(u=>u.side===side||seen(sources,u)).map(u=>({id:u.id,side:u.side,type:u.type,squad:u.side===side?u.squad:null,x:round(u.x),y:round(u.y),hp:Math.round(u.hp),maxHp:Math.round(u.maxHp),elite:u.elite}));
  const owners=game.capture.map(c=>({owner:c.owner,progress:round(c.progress),attacker:c.attacker}));
  const sites=game.map.sites.map(s=>({id:s.id,type:s.type,x:s.x,y:s.y,stock:Math.ceil(s.stock),max:s.max,spent:s.spent}));
  return {kind:'state',seed:game.seed,side,time:round(game.time),duration:ROUND_SECONDS,ended:game.ended,winner:game.winner,
    wood:Math.floor(p.wood),iron:Math.floor(p.iron),orders:p.orders,buildings,units,sites,rocks:game.map.rocks,
    sources,objectives:owners,log:game.log.slice(0,6),caps:{units:16,squads:2,outposts:3},
    buildingRules:BUILDINGS,upgradeRules:UPGRADES,troopRules:TROOPS};
}
// The planner sees only the red player's snapshot. All commands go through action().
const BOT_SIDE = 1;
const BOT_GOALS = [{x:24,y:16,index:1},{x:24,y:7,index:0},{x:24,y:25,index:2}];
function botBuild(view,type,attempt){
  const own=view.buildings.filter(b=>b.side===BOT_SIDE&&b.hp>0);
  const anchors=own.filter(b=>b.linked&&b.buildLeft<=0&&['castle','outpost'].includes(b.type));
  const siteType={lumber:'forest',mine:'ore'}[type];
  const sites=view.sites.filter(s=>s.type===siteType&&!s.spent&&s.stock>0&&!own.some(b=>b.site===s.id));
  const known=view.buildings.filter(b=>!b.ghost&&b.hp>0);
  const candidates=[];
  for(const anchor of anchors){
    const radius=circle(anchor)-.3;
    for(let dx=-Math.floor(radius);dx<=radius;dx++){
      for(let dy=-Math.floor(radius);dy<=radius;dy++){
        const point={x:round(anchor.x+dx),y:round(anchor.y+dy)};
        if(!within(point.x,point.y)||distance(anchor,point)>radius)continue;
        if(view.rocks.some(r=>distance(r,point)<r.r+.7)||
          known.some(b=>distance(b,point)<1.58||(b.side!==BOT_SIDE&&b.buildLeft<=0&&
            ['castle','outpost'].includes(b.type)&&distance(b,point)<circle(b)))||
          view.sites.some(s=>!s.spent&&distance(s,point)<1.3)||
          view.units.some(u=>u.side!==BOT_SIDE&&distance(u,point)<2.7))continue;
        const score=siteType?Math.min(...sites.map(s=>distance(s,point))):distance(point,{x:39,y:16});
        if(!siteType||score<=5.4)candidates.push({...point,score});
      }
    }
  }
  candidates.sort((a,b)=>a.score-b.score);
  const point=candidates[attempt%candidates.length];
  return point&&{kind:'build',type,x:point.x,y:point.y};
}
function playBot(game,bot){
  if(game.ended||game.time<bot.next)return;
  bot.next=game.time+2;
  const view=snapshot(game,BOT_SIDE);
  const own=view.buildings.filter(b=>b.side===BOT_SIDE&&b.hp>0);
  const units=view.units.filter(u=>u.side===BOT_SIDE);
  const home=BASE_POS[BOT_SIDE];
  const issue=(command,description)=>{
    if(!command||!action(game,BOT_SIDE,command).ok)return;
    bot.log.unshift({msg:'BOT｜'+description,at:round(game.time)});
    if(bot.log.length>20)bot.log.pop();
  };
  for(const type of ['lumber','mine','barracks']){
    const cost=BUILDINGS[type];
    if(own.some(b=>b.type===type)||view.wood<cost.wood||view.iron<cost.iron)continue;
    const attempt=bot.attempts[type]||0;
    bot.attempts[type]=attempt+1;
    issue(botBuild(view,type,attempt),cost.name+'を建設');
    break;
  }
  const barracks=own.find(b=>b.type==='barracks'&&b.buildLeft<=0&&b.linked);
  if(barracks&&barracks.queue.length+(barracks.working?1:0)<2){
    const count=squad=>units.filter(u=>u.squad===squad).length+
      barracks.queue.filter(q=>q.squad===squad).length+(barracks.working?.squad===squad?1:0);
    const squad=count(0)<=count(1)?0:1;
    const type=(count(squad)%2===0?['shield','scout','archer']:['archer','scout','shield'])
      .find(name=>view.wood>=TROOPS[name].wood&&view.iron>=TROOPS[name].iron);
    if(type&&count(squad)<8)issue({kind:'recruit',id:barracks.id,type,squad},TROOPS[type].name+'を生産予約');
  }
  const threat=view.units.some(u=>u.side!==BOT_SIDE&&distance(u,home)<10);
  for(let squad=0;squad<2;squad++){
    const size=units.filter(u=>u.squad===squad).length;
    if(!size)continue;
    let target=home,mode='defend',description='本拠地を防衛';
    if(!threat){
      const goal=BOT_GOALS.find(point=>view.objectives[point.index].owner!==BOT_SIDE);
      if(squad===0&&size>=5&&(!goal||game.time>=120)){
        target=BASE_POS[0];mode='march';description='敵本拠地へ進軍';
      }else if((squad===1&&game.time>=10)||(squad===0&&size>=3)){
        target=goal||BOT_GOALS[0];mode=goal?'march':'defend';
        description=goal?'中央地点へ進軍・占領':'中央地点を防衛';
      }
    }
    const current=view.orders[squad];
    if(current.mode!==mode||distance(current,target)>.1){
      issue({kind:'order',squad,mode,x:target.x,y:target.y},'第'+(squad+1)+'部隊が'+description);
    }
  }
}

// --- Minimal RFC 6455 implementation; frames sent by browsers are masked. ---
function writeFrame(socket,opcode,data=Buffer.alloc(0)){
  if(socket.destroyed)return;
  const payload=Buffer.isBuffer(data)?data:Buffer.from(data);
  let header;
  if(payload.length<126){header=Buffer.from([0x80|opcode,payload.length]);}
  else if(payload.length<65536){header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=126;header.writeUInt16BE(payload.length,2);}
  else {header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2);}
  try{socket.write(Buffer.concat([header,payload]));}catch{}
}
function wsSend(conn,payload){if(conn&&conn.alive)writeFrame(conn.socket,1,JSON.stringify(payload));}
function decodeFrames(conn,chunk){
  conn.buffer=Buffer.concat([conn.buffer,chunk]);
  while(conn.buffer.length>=2){
    const buf=conn.buffer,fin=Boolean(buf[0]&128),op=buf[0]&15,masked=Boolean(buf[1]&128);
    let len=buf[1]&127,head=2;
    if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);head=4;}
    if(len===127){if(buf.length<10)return;const n=buf.readBigUInt64BE(2);if(n>BigInt(65536)){conn.socket.destroy();return;}len=Number(n);head=10;}
    if(!masked){conn.socket.destroy();return;}
    if(buf.length<head+4+len)return;
    const mask=buf.subarray(head,head+4),body=Buffer.from(buf.subarray(head+4,head+4+len));
    for(let i=0;i<body.length;i++)body[i]^=mask[i%4];
    conn.buffer=buf.subarray(head+4+len);
    if(op===8){conn.socket.end();return;}
    if(op===9){writeFrame(conn.socket,10,body);continue;}
    if(op===10)continue;
    if(op!==1||!fin){conn.socket.destroy();return;}
    try{const msg=JSON.parse(body.toString('utf8'));message(conn,msg);}catch{wsSend(conn,{kind:'error',message:'メッセージ形式が不正です'});}
  }
}
function roomCode(){let c;do{c=(Math.floor(100000+Math.random()*900000)).toString();}while(rooms.has(c));return c;}
function sendState(room,side){
  const state=snapshot(room.game,side);
  if(room.bot)state.dev={paused:room.paused,speed:room.speed,log:room.bot.log};
  wsSend(room.slots[side]?.conn,state);
}
function broadcastState(room){
  room.slots.forEach((slot,side)=>{if(slot?.conn?.alive)sendState(room,side);});
}
function resetDevGame(room){
  room.game=newGame(crypto.randomBytes(4).readUInt32BE());
  room.bot={next:0,attempts:{},log:[]};
  room.paused=false;
  room.speed=1;
}
function assignConnection(conn,room,side){
  const slot=room.slots[side];if(slot.conn&&slot.conn!==conn){wsSend(slot.conn,{kind:'error',message:'別の端末から再接続されました'});slot.conn.socket.end();}
  conn.room=room.code;conn.side=side;slot.conn=conn;slot.lastSeen=now();
  wsSend(conn,{kind:'joined',code:room.code,side,token:slot.token,ready:room.started,...(room.bot?{dev:true}:{})});
  if(room.started){sendState(room,side);wsSend(room.slots[1-side]?.conn,{kind:'peer',connected:true});}
}
function message(conn,m){
  if(!m||typeof m.kind!=='string')return;
  if(m.kind==='create'||m.kind==='createDev'){
    if(conn.room)return wsSend(conn,{kind:'error',message:'すでに参加しています'});
    if(rooms.size>=50)return wsSend(conn,{kind:'error',message:'現在、新しい部屋を作れません。少し後でお試しください'});
    const code=roomCode(),token=crypto.randomBytes(18).toString('hex');
    const room={code,slots:[{token,conn:null,lastSeen:now()},null],started:false,game:null,created:now()};
    if(m.kind==='createDev'){room.started=true;resetDevGame(room);}
    rooms.set(code,room);assignConnection(conn,room,0);return;
  }
  if(m.kind==='join'){
    const code=String(m.code||'').replace(/\D/g,'').slice(0,6),room=rooms.get(code);
    if(!room)return wsSend(conn,{kind:'error',message:'部屋が見つかりません'});
    if(conn.room&&conn.room!==code)return wsSend(conn,{kind:'error',message:'すでに他の部屋に参加しています'});
    if(m.token){const side=room.slots.findIndex(s=>s&&s.token===m.token);if(side>=0){assignConnection(conn,room,side);return;}}
    if(room.slots[1]||room.started)return wsSend(conn,{kind:'error',message:'この部屋は満員です'});
    room.slots[1]={token:crypto.randomBytes(18).toString('hex'),conn:null,lastSeen:now()};
    assignConnection(conn,room,1);room.started=true;room.game=newGame(crypto.randomBytes(4).readUInt32BE());
    for(let side=0;side<2;side++){wsSend(room.slots[side].conn,{kind:'start',side});wsSend(room.slots[side].conn,snapshot(room.game,side));}
    return;
  }
  const room=rooms.get(conn.room);if(!room||conn.side===undefined||room.slots[conn.side]?.conn!==conn)return;
  room.slots[conn.side].lastSeen=now();
  if(m.kind==='dev'&&room.bot&&conn.side===0){
    if(m.command==='pause'&&typeof m.paused==='boolean')room.paused=m.paused;
    else if(m.command==='speed'&&[1,3].includes(m.speed))room.speed=m.speed;
    else if(m.command==='rematch'&&now()-(room.lastRematch||0)>=1000){
      room.lastRematch=now();resetDevGame(room);wsSend(conn,{kind:'devReset'});
    }else return;
    return sendState(room,0);
  }
  if(m.kind==='action'&&room.started){
    const timestamp=now();
    conn.actionWindow=conn.actionWindow||{at:timestamp,count:0};
    if(timestamp-conn.actionWindow.at>=1000)conn.actionWindow={at:timestamp,count:0};
    if(++conn.actionWindow.count>12)return wsSend(conn,{kind:'error',message:'操作が速すぎます'});
    const result=room.paused?{error:'一時停止中です。再開してから操作してください'}:action(room.game,conn.side,m.action);
    wsSend(conn,{kind:'result',...result});if(result.ok)broadcastState(room);
  }
}
// Keep the static entrypoint at repo root: iPhone users can upload four files
// to GitHub without needing to create a folder. Never serve server.js publicly.
const FRONTEND=path.join(__dirname,'index.html');
const server=http.createServer((req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
  let url;
  try{url=new URL(req.url||'/', 'http://localhost');}catch{res.writeHead(400).end();return;}
  if(url.pathname==='/healthz'){
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(req.method==='HEAD'?'':JSON.stringify({ok:true,service:'tiny-kingdoms',version:'0.4.0'}));
    return;
  }
  if(!['/','/index.html'].includes(url.pathname)){res.writeHead(404).end('Not found');return;}
  fs.readFile(FRONTEND,(err,data)=>{
    if(err){res.writeHead(500).end('Frontend unavailable');return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'same-origin','X-Frame-Options':'DENY'});
    if(req.method==='HEAD')res.end();else res.end(data);
  });
});
server.on('upgrade',(req,socket,head)=>{
  const key=req.headers['sec-websocket-key'];
  // Browsers supply Origin. Only accept the same public host that serves the UI.
  let originOK=true;
  if(req.headers.origin){
    try{originOK=new URL(req.headers.origin).host===req.headers.host;}catch{originOK=false;}
  }
  if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!key||!originOK){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const conn={socket,buffer:Buffer.alloc(0),alive:true,room:null,side:undefined};
  socket.on('data',data=>decodeFrames(conn,data));if(head?.length)decodeFrames(conn,head);
  socket.on('error',()=>{});
  socket.on('close',()=>{conn.alive=false;const room=rooms.get(conn.room);
    if(room&&room.slots[conn.side]?.conn===conn){room.slots[conn.side].conn=null;room.slots[conn.side].lastSeen=now();wsSend(room.slots[1-conn.side]?.conn,{kind:'peer',connected:false});}
  });
});
let last=now();
setInterval(()=>{
  const t=now(),dt=Math.min(.2,(t-last)/1000);last=t;
  for(const room of rooms.values()){
    if(!room.started)continue;
    // Pause if a player is disconnected: prevents losing a match because of a network interruption.
    if(room.bot){
      if(!room.slots[0].conn?.alive||room.paused||room.game.ended)continue;
      for(let step=0;step<room.speed&&!room.game.ended;step++){
        playBot(room.game,room.bot);
        update(room.game,dt);
      }
    }else{
      if(!room.slots.every(s=>s?.conn?.alive))continue;
      update(room.game,dt);
    }
    if(room.game.frame%2===0||room.game.ended)broadcastState(room);
  }
},100);
setInterval(()=>{const t=now();for(const [code,room] of rooms){
  const allGone=room.slots.every(s=>!s?.conn?.alive);
  if(allGone&&t-Math.max(...room.slots.filter(Boolean).map(s=>s.lastSeen))>5*60*1000)rooms.delete(code);
  if(!room.started&&t-room.created>30*60*1000)rooms.delete(code);
}},60000);
server.listen(PORT,'0.0.0.0',()=>console.log(`TINY KINGDOMS: http://localhost:${PORT} | 二人とも同じURLを開いてください`));
module.exports={newGame,action,update,snapshot,mapFor,canBuild};
