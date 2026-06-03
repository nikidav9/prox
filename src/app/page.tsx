"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { AGENTS, AgentDef } from "@/lib/agents";

const TILE  = 16;
const SCALE = 3;
const RT    = TILE * SCALE;
const COLS  = 20;
const ROWS  = 13;
const W     = COLS * RT;
const H     = ROWS * RT;
const WALK_SPD = 48;

type Dir    = 0 | 1 | 2 | 3;
const DOWN = 0, LEFT = 1, RIGHT = 2, UP = 3;
type AState = "idle" | "type" | "walk" | "talk";

const CHAR_W = 16, CHAR_H = 32;
const SPRITE_URLS = [0,1,2,3,4,5].map(
  i => `/characters/char_${i}.png`
);

const SEATS = [
  {tx:2, ty:3, dir:DOWN as Dir},
  {tx:5, ty:3, dir:DOWN as Dir},
  {tx:8, ty:3, dir:DOWN as Dir},
  {tx:11,ty:3, dir:DOWN as Dir},
  {tx:14,ty:3, dir:DOWN as Dir},
  {tx:2, ty:6, dir:DOWN as Dir},
  {tx:5, ty:6, dir:DOWN as Dir},
  {tx:8, ty:6, dir:DOWN as Dir},
  {tx:11,ty:6, dir:DOWN as Dir},
  {tx:14,ty:6, dir:DOWN as Dir},
  {tx:2, ty:9, dir:DOWN as Dir},
  {tx:5, ty:9, dir:DOWN as Dir},
  {tx:8, ty:9, dir:DOWN as Dir},
  {tx:11,ty:9, dir:DOWN as Dir},
  {tx:14,ty:9, dir:DOWN as Dir},
];
const DESK_OBS = [
  {tx:2,ty:2},{tx:5,ty:2},{tx:8,ty:2},{tx:11,ty:2},{tx:14,ty:2},
  {tx:2,ty:5},{tx:5,ty:5},{tx:8,ty:5},{tx:11,ty:5},{tx:14,ty:5},
  {tx:2,ty:10},{tx:5,ty:10},{tx:8,ty:10},{tx:11,ty:10},{tx:14,ty:10},
];

const WALKABLE: boolean[][] = Array.from({length:ROWS}, (_,r) =>
  Array.from({length:COLS}, (_,c) => r>0 && r<ROWS-1 && c>0 && c<COLS-1)
);
for (const {tx,ty} of DESK_OBS) WALKABLE[ty][tx] = false;

function bfs(fx:number,fy:number,tx:number,ty:number): {x:number,y:number}[] {
  if (fx===tx&&fy===ty) return [];
  type N={x:number,y:number,prev:N|null};
  const vis=new Uint8Array(ROWS*COLS);
  const q:N[]=[{x:fx,y:fy,prev:null}];
  vis[fy*COLS+fx]=1;
  while(q.length){
    const cur=q.shift()!;
    for(const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]] as [number,number][]){
      const nx=cur.x+dx,ny=cur.y+dy;
      if(nx<0||ny<0||nx>=COLS||ny>=ROWS)continue;
      if(!WALKABLE[ny][nx]||vis[ny*COLS+nx])continue;
      vis[ny*COLS+nx]=1;
      const node:N={x:nx,y:ny,prev:cur};
      if(nx===tx&&ny===ty){
        const path:{x:number,y:number}[]=[];
        let n:N|null=node;
        while(n){path.unshift({x:n.x,y:n.y});n=n.prev;}
        path.shift(); return path;
      }
      q.push(node);
    }
  }
  return [];
}

function dirBetween(ax:number,ay:number,bx:number,by:number):Dir{
  const dx=bx-ax,dy=by-ay;
  if(Math.abs(dx)>=Math.abs(dy))return dx>0?RIGHT:LEFT;
  return dy>0?DOWN:UP;
}

interface AgentRT {
  def: AgentDef; si: number;
  ax: number; ay: number;
  tileX: number; tileY: number;
  path: {x:number,y:number}[];
  state: AState; dir: Dir;
  animT: number; animF: number;
  seatI: number;
  bubble: string|null; bubbleT: number;
  onPathEnd: (()=>void)|null;
  busy: boolean;
}

const P = {
  floorA:"#C8A96E",floorB:"#B89252",wallDark:"#1E1E3A",wallMid:"#252545",
  wood1:"#A0692A",wood2:"#7A4E1A",wood3:"#6B3E12",woodFloor:"#8B5E2A",
  monBody:"#787878",chair:"#C8A87A",chairDk:"#A07850",
  book1:"#C0392B",book2:"#27AE60",book3:"#2980B9",book4:"#F39C12",book5:"#8E44AD",
  plant:"#27AE60",plantDk:"#1E8449",pot:"#A04010",potDk:"#7A3010",
};

function rr(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number){
  ctx.beginPath();
  ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function drawFloor(ctx:CanvasRenderingContext2D){
  for(let r=1;r<ROWS-1;r++)for(let c=1;c<COLS-1;c++){
    ctx.fillStyle=(c+r)%2===0?P.floorA:P.floorB;ctx.fillRect(c*RT,r*RT,RT,RT);
    ctx.strokeStyle="rgba(0,0,0,0.12)";ctx.lineWidth=1;ctx.strokeRect(c*RT+.5,r*RT+.5,RT-1,RT-1);
  }
}
function drawWalls(ctx:CanvasRenderingContext2D){
  ctx.fillStyle=P.wallDark;ctx.fillRect(0,0,W,RT);
  ctx.fillStyle=P.wallMid;ctx.fillRect(0,0,RT,H);ctx.fillRect(W-RT,0,RT,H);ctx.fillRect(0,H-RT,W,RT);
  ctx.fillStyle=P.wood3;ctx.fillRect(RT,H-RT,W-RT*2,4);ctx.fillRect(RT,RT-2,W-RT*2,4);
}
function drawBookshelves(ctx:CanvasRenderingContext2D){
  const defs=[{sx:1*RT,sw:5*RT},{sx:8*RT,sw:5*RT},{sx:15*RT,sw:4*RT}];
  for(const{sx,sw}of defs){
    const sy=4,sh=RT-6;
    ctx.fillStyle=P.wood3;ctx.fillRect(sx,sy,sw,sh);
    ctx.fillStyle=P.woodFloor;
    ctx.fillRect(sx,sy,sw,4);ctx.fillRect(sx,sy+sh-4,sw,4);
    ctx.fillRect(sx,sy,4,sh);ctx.fillRect(sx+sw-4,sy,4,sh);
    ctx.fillRect(sx,sy+sh/2-2,sw,3);
    const bc=[P.book1,P.book2,P.book3,P.book4,P.book5,"#D4D4D4","#E67E22",P.book1,P.book3,P.book2];
    let bx=sx+6,row=0;
    while(bx<sx+sw-6){
      const bw=5+Math.floor(Math.abs(Math.sin(bx*0.3))*4),bh=sh/2-7,bsy=sy+5+row*(sh/2+1);
      ctx.fillStyle=bc[(bx+row*3)%bc.length];ctx.fillRect(bx,bsy,bw,bh);
      ctx.fillStyle="rgba(0,0,0,0.2)";ctx.fillRect(bx,bsy,1,bh);
      bx+=bw+1;
      if(bx>=sx+sw-6&&row===0){bx=sx+6;row=1;}
      if(row>1)break;
    }
  }
}
function drawDeskStation(ctx:CanvasRenderingContext2D,seatTile:{tx:number,ty:number,dir:Dir},isTop:boolean,agent:AgentRT|undefined,fc:number){
  const deskTy=isTop?seatTile.ty-1:seatTile.ty+1;
  const dsx=seatTile.tx*RT-RT,dsy=deskTy*RT;
  ctx.fillStyle="rgba(0,0,0,0.25)";ctx.fillRect(dsx+3,dsy+RT+2,RT*3,6);
  ctx.fillStyle=P.wood1;ctx.fillRect(dsx,dsy,RT*3,RT);
  ctx.fillStyle=P.wood2;
  for(let g=0;g<3;g++)ctx.fillRect(dsx+g*RT+RT*0.3,dsy+4,2,RT-8);
  ctx.fillRect(dsx,dsy+RT-6,RT*3,6);
  ctx.fillStyle=P.wood3;ctx.fillRect(dsx+4,dsy+RT,8,14);ctx.fillRect(dsx+RT*3-12,dsy+RT,8,14);
  const mx=seatTile.tx*RT,my=dsy+3,mw=RT-2,mh=RT-10;
  ctx.fillStyle=P.monBody;ctx.fillRect(mx+mw/2-8,my+mh,16,5);ctx.fillRect(mx+mw/2-12,my+mh+4,24,4);
  rr(ctx,mx+1,my,mw-2,mh,3);ctx.fill();
  ctx.strokeStyle="#555";ctx.lineWidth=1;ctx.stroke();
  ctx.fillStyle="#2a2a2a";ctx.fillRect(mx+4,my+3,mw-8,mh-6);
  if(agent&&agent.busy){
    ctx.fillStyle="#0d1520";ctx.fillRect(mx+5,my+4,mw-10,mh-8);
    const lc=["#00FF41","#4FA3FF","#FF6B9D","#FFD700"];
    for(let li=0;li<4;li++){
      const lw=4+(fc*0.25+li*7+seatTile.tx)%14|0;
      ctx.globalAlpha=0.8+0.2*Math.sin(fc*0.08+li);ctx.fillStyle=lc[li%4];ctx.fillRect(mx+6,my+6+li*5,lw,2);
    }
    ctx.globalAlpha=1;
    if(Math.floor(fc/15)%2===0){ctx.fillStyle="#00FF41";ctx.fillRect(mx+6,my+mh-10,2,3);}
  }else{
    ctx.fillStyle="#0a0a14";ctx.fillRect(mx+5,my+4,mw-10,mh-8);
    ctx.globalAlpha=0.4+0.3*Math.sin(fc*0.04+seatTile.tx*0.5);
    ctx.fillStyle="#3a6abf";ctx.beginPath();
    ctx.arc(mx+mw/2,my+mh/2,3+Math.sin(fc*0.03+seatTile.ty)*2,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=1;
  }
  const kx=dsx+RT*0.6,ky=dsy+RT*0.55,kw=RT*1.8,kh=RT*0.28;
  ctx.fillStyle="#8a8a8a";rr(ctx,kx,ky,kw,kh,2);ctx.fill();
  ctx.fillStyle="#6a6a6a";
  for(let ki=0;ki<6;ki++)for(let kj=0;kj<2;kj++)ctx.fillRect(kx+3+ki*(kw/6-1),ky+3+kj*6,kw/6-3,4);
  ctx.fillStyle="#888";rr(ctx,dsx+RT*2.6,dsy+RT*0.55,10,14,3);ctx.fill();
  ctx.fillStyle="#555";ctx.fillRect(dsx+RT*2.6+4,dsy+RT*0.55,2,6);
  const chairY=seatTile.ty*RT+4;
  const chairX=seatTile.tx*RT+RT/2-RT*0.6,chairW=RT*1.2,chairH=RT*0.55;
  ctx.fillStyle=P.wood3;ctx.fillRect(chairX+4,chairY+chairH,5,10);ctx.fillRect(chairX+chairW-9,chairY+chairH,5,10);
  ctx.fillStyle=P.chair;rr(ctx,chairX,chairY,chairW,chairH,4);ctx.fill();
  ctx.strokeStyle=P.chairDk;ctx.lineWidth=1.5;ctx.stroke();
  ctx.fillStyle=P.chairDk;ctx.fillRect(chairX+chairW/2-1,chairY+3,2,chairH-6);ctx.fillRect(chairX+3,chairY+chairH/2-1,chairW-6,2);
}
function drawPlant(ctx:CanvasRenderingContext2D,px:number,py:number,fc:number,idx:number){
  const sway=Math.sin(fc*0.02+idx)*1.5;
  ctx.fillStyle=P.potDk;ctx.fillRect(px-9,py-10,18,12);
  ctx.fillStyle=P.pot;ctx.fillRect(px-7,py-14,14,10);
  ctx.fillStyle=P.potDk;ctx.fillRect(px-9,py-14,18,3);
  ctx.fillStyle="#5D8A3C";ctx.fillRect(px-2,py-28,4,18);
  const leaf=(ox:number,oy:number,ow:number,oh:number,angle:number)=>{
    ctx.save();ctx.translate(px+sway,py-20);ctx.rotate(angle+sway*0.05);
    ctx.fillStyle=P.plant;ctx.beginPath();ctx.ellipse(ox,oy,ow,oh,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=P.plantDk;ctx.beginPath();ctx.moveTo(ox,oy-oh);ctx.lineTo(ox,oy+oh);ctx.stroke();ctx.restore();
  };
  ctx.strokeStyle=P.plantDk;ctx.lineWidth=1;
  leaf(-14,-8,10,5,-0.4);leaf(14,-8,10,5,0.4);leaf(0,-16,8,12,0);leaf(-8,-14,7,4,-0.7);leaf(8,-14,7,4,0.7);
}
function drawBoxes(ctx:CanvasRenderingContext2D,bx:number,by:number){
  ctx.fillStyle="#C8A54A";ctx.fillRect(bx-16,by-14,32,18);
  ctx.strokeStyle="#9B7A2A";ctx.lineWidth=1.5;ctx.strokeRect(bx-16,by-14,32,18);
  ctx.fillStyle="#9B7A2A";ctx.fillRect(bx-16,by-14,32,3);ctx.fillRect(bx,by-14,2,18);
  ctx.fillStyle="#D4B055";ctx.fillRect(bx-10,by-28,22,14);
  ctx.strokeStyle="#A88530";ctx.strokeRect(bx-10,by-28,22,14);
  ctx.fillStyle="#A88530";ctx.fillRect(bx-10,by-28,22,3);ctx.fillRect(bx,by-28,2,14);
}
function drawNameBadge(ctx:CanvasRenderingContext2D,ag:AgentRT,fc:number){
  const sx=Math.round(ag.ax*SCALE);
  const sy=Math.round(ag.ay*SCALE);
  const label=`${ag.def.name} · ${ag.def.role}`;
  ctx.font="bold 8px monospace";
  const tw=ctx.measureText(label).width;
  const bx=Math.max(4,Math.min(W-tw-14,sx-tw/2-5));
  const by=sy-CHAR_H*SCALE-18;
  rr(ctx,bx,by,tw+10,14,2);
  ctx.fillStyle="rgba(10,10,20,0.9)";ctx.fill();
  ctx.strokeStyle=ag.def.shirtColor;ctx.lineWidth=1.5;ctx.stroke();
  ctx.fillStyle=ag.def.shirtColor;ctx.fillText(label,bx+5,by+10);
  if(ag.busy){
    ctx.fillStyle="#22c55e";ctx.beginPath();ctx.arc(bx+tw+10,by+7,3,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=0.4+0.4*Math.sin(fc*0.15);ctx.strokeStyle="#22c55e";ctx.lineWidth=1.5;
    ctx.beginPath();ctx.arc(bx+tw+10,by+7,5,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;
  }
}
function drawScene(ctx:CanvasRenderingContext2D,agents:AgentRT[],sprites:(HTMLImageElement|null)[],fc:number){
  drawFloor(ctx);drawWalls(ctx);drawBookshelves(ctx);
  for(let i=0;i<15;i++)drawDeskStation(ctx,SEATS[i],i<10,agents[i],fc);
  drawPlant(ctx,RT+RT/2,H-RT-2,fc,0);drawPlant(ctx,W-RT-RT/2,H-RT-2,fc,1);
  drawBoxes(ctx,RT+RT*2,RT*2+RT/2);drawPlant(ctx,W-RT-RT/2,RT*2+8,fc,2);
  const sorted=[...agents].sort((a,b)=>a.ay-b.ay);
  for(const ag of sorted)drawChar(ctx,sprites,ag,Math.round(ag.ax*SCALE),Math.round(ag.ay*SCALE),fc);
  for(const ag of agents)if(ag.bubble)drawBubble(ctx,ag,ag.bubble,Math.round(ag.ax*SCALE),Math.round(ag.ay*SCALE));
  for(const ag of agents)drawNameBadge(ctx,ag,fc);
}
function drawChar(ctx:CanvasRenderingContext2D,sprites:(HTMLImageElement|null)[],ag:AgentRT,sx:number,sy:number,fc:number){
  const sprite=sprites[ag.si];
  if(sprite&&sprite.complete&&sprite.naturalWidth>0){
    const row=ag.dir===UP?DOWN:ag.dir,col=ag.state==="type"?4+ag.animF%2:ag.state==="walk"?ag.animF%4:0;
    ctx.drawImage(sprite,col*CHAR_W,row*CHAR_H,CHAR_W,CHAR_H,sx-CHAR_W*SCALE/2,sy-CHAR_H*SCALE,CHAR_W*SCALE,CHAR_H*SCALE);
  }else drawFallback(ctx,ag,sx,sy,fc);
}
function drawFallback(ctx:CanvasRenderingContext2D,ag:AgentRT,sx:number,sy:number,fc:number){
  const S=SCALE,{def,state}=ag,px=sx-8*S,py=sy-32*S;
  const bob=state==="idle"?Math.sin(fc*0.04)*S*0.4:0,pyA=py+bob;
  const lOff=state==="walk"?Math.sin(ag.animF*1.5)*2*S:0;
  ctx.fillStyle="rgba(0,0,0,0.2)";ctx.beginPath();ctx.ellipse(sx,sy+2,6*S,2*S,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#2C3E50";ctx.fillRect(px+4*S,pyA+25*S+lOff,4*S,6*S);ctx.fillRect(px+8*S,pyA+25*S-lOff,4*S,6*S);
  ctx.fillStyle="#1a252f";ctx.fillRect(px+3*S,pyA+31*S+lOff,6*S,2*S);ctx.fillRect(px+7*S,pyA+31*S-lOff,6*S,2*S);
  ctx.fillStyle=def.shirtColor;ctx.fillRect(px+2*S,pyA+14*S,12*S,12*S);
  ctx.fillStyle="rgba(255,255,255,0.3)";ctx.fillRect(px+6*S,pyA+14*S,4*S,3*S);
  const aOff=state==="type"?Math.sin(fc*0.25)*S:state==="walk"?Math.sin(ag.animF*1.5)*2*S:0;
  ctx.fillStyle=def.shirtColor;ctx.fillRect(px,pyA+15*S+aOff,2*S,8*S);ctx.fillRect(px+14*S,pyA+15*S-aOff,2*S,8*S);
  ctx.fillStyle="#D4A574";ctx.fillRect(px,pyA+23*S+aOff,2*S,2*S);ctx.fillRect(px+14*S,pyA+23*S-aOff,2*S,2*S);
  ctx.fillStyle="#D4A574";ctx.fillRect(px+3*S,pyA+4*S,10*S,11*S);ctx.fillRect(px+5*S,pyA+14*S,6*S,2*S);
  ctx.fillStyle=def.hairColor;ctx.fillRect(px+3*S,pyA+4*S,10*S,4*S);ctx.fillRect(px+3*S,pyA+7*S,2*S,3*S);ctx.fillRect(px+11*S,pyA+7*S,2*S,3*S);
  ctx.fillStyle="#fff";ctx.fillRect(px+5*S,pyA+9*S,3*S,2*S);ctx.fillRect(px+8*S,pyA+9*S,3*S,2*S);
  ctx.fillStyle="#1a1a1a";ctx.fillRect(px+6*S,pyA+10*S,1*S,1*S);ctx.fillRect(px+9*S,pyA+10*S,1*S,1*S);
  ctx.fillStyle=state==="idle"?"#c0392b":"#922b21";ctx.fillRect(px+6*S,pyA+12*S,4*S,state==="idle"?2*S:1*S);
  if(state==="idle"){
    const cupX=sx+14,cupY=sy-8*S;
    ctx.fillStyle="#8B4513";rr(ctx,cupX,cupY,10,12,2);ctx.fill();
    ctx.fillStyle="#6B3410";ctx.fillRect(cupX,cupY,10,3);
    ctx.globalAlpha=0.5+0.5*Math.sin(fc*0.07);ctx.strokeStyle="#ddd";ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(cupX+3,cupY-2);ctx.quadraticCurveTo(cupX+1,cupY-7,cupX+3,cupY-11);ctx.stroke();
    ctx.beginPath();ctx.moveTo(cupX+7,cupY-2);ctx.quadraticCurveTo(cupX+9,cupY-7,cupX+7,cupY-11);ctx.stroke();
    ctx.globalAlpha=1;
  }
}
function drawBubble(ctx:CanvasRenderingContext2D,ag:AgentRT,text:string,sx:number,sy:number){
  const pad=7,lh=13,maxW=150;
  ctx.font="bold 9px 'Courier New', monospace";
  const words=text.split(" "),lines:string[]=[];let cur="";
  for(const w of words){
    const t=cur?`${cur} ${w}`:w;
    if(ctx.measureText(t).width>maxW-pad*2){if(cur)lines.push(cur);cur=w;}else cur=t;
    if(lines.length>=3)break;
  }
  if(cur&&lines.length<3)lines.push(cur);
  const bw=Math.max(...lines.map(l=>ctx.measureText(l).width))+pad*2+4,bh=lines.length*lh+pad*2;
  const bx=Math.max(4,Math.min(W-bw-4,sx-bw/2)),charTop=sy-CHAR_H*SCALE-4,by=Math.max(4,charTop-bh-10);
  ctx.fillStyle="rgba(0,0,0,0.3)";rr(ctx,bx+2,by+2,bw,bh,5);ctx.fill();
  rr(ctx,bx,by,bw,bh,5);ctx.fillStyle="#FFFFF0";ctx.fill();ctx.strokeStyle=ag.def.shirtColor;ctx.lineWidth=2;ctx.stroke();
  const tx=Math.max(bx+10,Math.min(bx+bw-10,sx));
  ctx.fillStyle="#FFFFF0";ctx.beginPath();ctx.moveTo(tx-5,by+bh);ctx.lineTo(tx+5,by+bh);ctx.lineTo(tx,charTop);ctx.closePath();ctx.fill();
  ctx.strokeStyle=ag.def.shirtColor;ctx.lineWidth=1.5;
  ctx.beginPath();ctx.moveTo(tx-5,by+bh);ctx.lineTo(tx,charTop);ctx.stroke();
  ctx.beginPath();ctx.moveTo(tx+5,by+bh);ctx.lineTo(tx,charTop);ctx.stroke();
  ctx.fillStyle="#1a1a1a";
  for(let i=0;i<lines.length;i++)ctx.fillText(lines[i],bx+pad,by+pad+9+i*lh);
}

type ChatMsg = {role:"user"|"model"|"system"; text:string; githubActions?:string[]; ts?:number};
function fmtTime(ts?:number){if(!ts)return"";const d=new Date(ts);return d.toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"});}

interface MobileLayoutProps {
  agents: AgentDef[];
  chatHistories: Record<string,ChatMsg[]>;
  sending: boolean;
  sendingIds: Set<string>;
  onSend: (agentId: string, msg: string, history: ChatMsg[]) => Promise<void>;
  setChatHistories: React.Dispatch<React.SetStateAction<Record<string,ChatMsg[]>>>;
  githubToken: string;
  lastSeen: Record<string,number>;
  onMarkSeen: (id:string)=>void;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{position:"relative",margin:"6px 0",borderRadius:8,overflow:"hidden",background:"#0d0d1a",border:"1px solid #2a1a4a"}}>
      {lang && <div style={{padding:"3px 10px",background:"#1a1035",fontSize:9,color:"#7a6090",borderBottom:"1px solid #2a1a4a"}}>{lang}</div>}
      <pre style={{margin:0,padding:"10px 12px",overflowX:"auto",fontSize:12,lineHeight:1.5,color:"#c4b5fd",fontFamily:"'Courier New',monospace",whiteSpace:"pre"}}>
        {code}
      </pre>
      <button onClick={()=>{navigator.clipboard.writeText(code);setCopied(true);setTimeout(()=>setCopied(false),1500);}}
        style={{position:"absolute",top:lang?28:6,right:6,background:"#2a1a4a",border:"none",borderRadius:4,padding:"3px 8px",fontSize:9,color:copied?"#22c55e":"#7a6090",cursor:"pointer",fontFamily:"inherit"}}>
        {copied?"✓ скопировано":"копировать"}
      </button>
    </div>
  );
}

function MessageText({ text }: { text: string }) {
  const parts: {type:"text"|"code"; content:string; lang?:string}[] = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({type:"text", content: text.slice(last, m.index)});
    parts.push({type:"code", content: m[2].trim(), lang: m[1]||undefined});
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({type:"text", content: text.slice(last)});
  return (
    <>{parts.map((p,i) => p.type==="code"
      ? <CodeBlock key={i} code={p.content} lang={p.lang}/>
      : <span key={i} style={{whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{p.content}</span>
    )}</>
  );
}

function MobileLayout({ agents, chatHistories, sending, sendingIds, onSend, setChatHistories, githubToken, lastSeen, onMarkSeen }: MobileLayoutProps) {
  const [tab, setTab] = useState<"agents"|"team">("agents");
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [inputText, setInputText] = useState("");
  const [localSending, setLocalSending] = useState(false);
  const [teamTopic, setTeamTopic] = useState("");
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamDiscussion, setTeamDiscussion] = useState<{agentId:string;agentName:string;role:string;text:string}[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const teamEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { teamEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [teamDiscussion]);

  async function startTeamDiscussion() {
    if (!teamTopic.trim() || teamLoading) return;
    setTeamLoading(true); setTeamDiscussion([]);
    try {
      const res = await fetch('/api/team', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({topic:teamTopic}) });
      const data = await res.json();
      if (data.messages) setTeamDiscussion(data.messages);
    } catch {}
    setTeamLoading(false);
  }

  const selAgent = agents.find(a => a.id === selectedId);
  const chatHist = selectedId ? chatHistories[selectedId] || [] : [];

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    if (selectedId) onMarkSeen(selectedId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatHist, selectedId]);

  // Pull-to-refresh
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullStartY = useRef(0);
  const pullListRef = useRef<HTMLDivElement>(null);
  function onPullStart(e: React.TouchEvent) {
    if ((pullListRef.current?.scrollTop ?? 0) > 0) return;
    pullStartY.current = e.touches[0].clientY;
  }
  function onPullMove(e: React.TouchEvent) {
    if ((pullListRef.current?.scrollTop ?? 0) > 0) { setPullY(0); return; }
    const dy = e.touches[0].clientY - pullStartY.current;
    if (dy > 0) setPullY(Math.min(dy * 0.45, 70));
  }
  async function onPullEnd() {
    if (pullY >= 55 && !refreshing) {
      setRefreshing(true); setPullY(0);
      try {
        const res = await fetch('/api/history');
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data === 'object') {
            setChatHistories((prev: Record<string,ChatMsg[]>) => {
              const merged = { ...prev };
              for (const [id, msgs] of Object.entries(data) as [string,ChatMsg[]][]) {
                if (msgs.length >= (prev[id]||[]).length) merged[id] = msgs;
              }
              return merged;
            });
          }
        }
      } catch {}
      setRefreshing(false);
    } else {
      setPullY(0);
    }
  }

  async function sendMessage() {
    if (!inputText.trim() || !selectedId || localSending || (!!selectedId && sendingIds.has(selectedId))) return;
    const msg = inputText.trim();
    setInputText("");
    setLocalSending(true);
    const history = chatHistories[selectedId] || [];
    setChatHistories(p => ({ ...p, [selectedId!]: [...(p[selectedId!] || []), { role: "user", text: msg, ts: Date.now() }] }));
    onMarkSeen(selectedId);
    await onSend(selectedId, msg, history);
    setLocalSending(false);
  }

  function openChat(id: string) {
    setSelectedId(id);
    onMarkSeen(id);
  }

  function clearHistory(agentId: string) {
    setChatHistories(p => { const n = { ...p }; delete n[agentId]; return n; });
    fetch("/api/history", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId }) }).catch(() => {});
  }

  if (selAgent) {
    const isBusy = localSending || sendingIds.has(selAgent.id);
    return (
      <div style={{display:"flex",flexDirection:"column",height:"100dvh",background:"#0d0d1a",fontFamily:"'Courier New',monospace",color:"#e2e8f0"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#13102a",borderBottom:`2px solid ${selAgent.shirtColor}55`,flexShrink:0}}>
          <button onClick={() => setSelectedId(null)}
            style={{background:"none",border:"none",color:selAgent.shirtColor,fontSize:20,cursor:"pointer",padding:"0 4px",lineHeight:1}}>
            ←
          </button>
          <div style={{width:34,height:34,borderRadius:"50%",background:selAgent.shirtColor,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:"bold",fontSize:14,color:"#fff",flexShrink:0,
            boxShadow:isBusy?`0 0 10px ${selAgent.shirtColor}88`:"none"}}>
            {selAgent.name.charAt(0)}
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:"bold",fontSize:14,color:selAgent.shirtColor}}>{selAgent.name}</div>
            <div style={{fontSize:10,color:"#7a6090"}}>{selAgent.role}{isBusy?" · думает…":""}</div>
          </div>
          {chatHist.length > 0 && (
            <button onClick={() => clearHistory(selAgent.id)}
              style={{background:"#2a1020",border:"1px solid #5a2040",borderRadius:6,padding:"4px 8px",color:"#f87171",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>
              🗑
            </button>
          )}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"12px 16px",display:"flex",flexDirection:"column",gap:8}}>
          {chatHist.length === 0 && (
            <div style={{color:"#3a2a5a",fontSize:12,textAlign:"center",marginTop:60,lineHeight:2}}>
              <div style={{fontSize:28,marginBottom:8}}>{selAgent.name.charAt(0)}</div>
              <div style={{color:"#5a4a7a"}}>Напиши задание для <span style={{color:selAgent.shirtColor}}>{selAgent.name}</span></div>
              <div style={{color:"#3a2a5a",marginTop:8,fontSize:10}}>Можно вставить код, ссылки, задачи</div>
            </div>
          )}
          {chatHist.map((m, i) => (
            <div key={i}>
              {m.role === "system" ? (
                <div style={{fontSize:10,color:"#5a8a5a",textAlign:"center",padding:"4px 8px",background:"#0a1a0a",borderRadius:6,border:"1px solid #2a4a2a"}}>{m.text}</div>
              ) : (
                <div style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",alignItems:"flex-end",gap:6}}>
                  {m.role==="model" && <div style={{width:24,height:24,borderRadius:"50%",background:selAgent.shirtColor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:"bold",color:"#fff",flexShrink:0}}>{selAgent.name.charAt(0)}</div>}
                  <div style={{maxWidth:"88%"}}>
                    <div style={{padding:"8px 12px",borderRadius:12,fontSize:13,lineHeight:1.6,
                      background:m.role==="user"?"#2a1a4a":"#1a1035",
                      border:m.role==="model"?`1px solid ${selAgent.shirtColor}33`:"none",
                      color:m.role==="user"?"#c4a8f0":"#d4c8f0",
                      borderBottomRightRadius:m.role==="user"?2:12,
                      borderBottomLeftRadius:m.role==="model"?2:12}}>
                      <MessageText text={m.text}/>
                    </div>
                    {m.githubActions && m.githubActions.length > 0 && (
                      <div style={{marginTop:4,padding:"6px 10px",background:"#0a1a0a",border:"1px solid #2a5a2a",borderRadius:8,fontSize:10,color:"#5aaa5a"}}>
                        {m.githubActions.map((a,j) => (<div key={j} style={{padding:"1px 0"}}>⚡ {a.slice(0,100)}</div>))}
                      </div>
                    )}
                    {m.ts && <div style={{fontSize:9,color:"#3a2a5a",marginTop:2,textAlign:m.role==="user"?"right":"left"}}>{fmtTime(m.ts)}</div>}
                  </div>
                </div>
              )}
            </div>
          ))}
          {isBusy && <div style={{display:"flex",gap:6,alignItems:"center",padding:"4px 0"}}>
            <div style={{width:24,height:24,borderRadius:"50%",background:selAgent.shirtColor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:"bold",color:"#fff",flexShrink:0}}>{selAgent.name.charAt(0)}</div>
            <div style={{background:"#1a1035",border:`1px solid ${selAgent.shirtColor}33`,borderRadius:12,borderBottomLeftRadius:2,padding:"10px 16px",fontSize:16,letterSpacing:4,color:selAgent.shirtColor}}>•••</div>
          </div>}
          <div ref={chatEndRef}/>
        </div>
        <div style={{padding:"8px 12px",borderTop:`1px solid ${selAgent.shirtColor}22`,background:"#13102a",flexShrink:0}}>
          <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
            <textarea value={inputText} onChange={e => setInputText(e.target.value)}
              onKeyDown={e => { if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendMessage(); } }}
              placeholder={`Сообщение для ${selAgent.name}…\nShift+Enter — новая строка`}
              disabled={isBusy} rows={1}
              style={{flex:1,background:"#1a1035",border:`1px solid ${selAgent.shirtColor}44`,borderRadius:12,padding:"10px 14px",
                color:"#d4c8f0",fontSize:14,outline:"none",fontFamily:"'Courier New',monospace",resize:"none",
                minHeight:44,maxHeight:140,overflowY:"auto",lineHeight:1.5}}/>
            <button onClick={sendMessage} disabled={isBusy || !inputText.trim()}
              style={{background:selAgent.shirtColor,border:"none",borderRadius:12,padding:"10px 16px",
                color:"#fff",fontWeight:"bold",fontSize:18,cursor:isBusy||!inputText.trim()?"default":"pointer",
                opacity:isBusy||!inputText.trim()?0.4:1,flexShrink:0,height:44}}>
              {isBusy ? "…" : "↑"}
            </button>
          </div>
          {githubToken && <div style={{fontSize:9,color:"#22c55e",textAlign:"center",marginTop:4}}>● GitHub подключён</div>}
        </div>
      </div>
    );
  }

  const TAB_STYLE = (active: boolean) => ({
    flex:1, background:"none", border:"none", color: active ? "#a78bfa" : "#5a4a7a",
    fontSize:11, fontWeight: active ? "bold" as const : "normal" as const,
    padding:"10px 0", cursor:"pointer", fontFamily:"inherit",
    borderTop: active ? "2px solid #a78bfa" : "2px solid transparent",
  });

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100dvh",background:"#0d0d1a",fontFamily:"'Courier New',monospace",color:"#e2e8f0"}}>
      {showSettings && (
        <div style={{position:"fixed",inset:0,background:"#000000cc",zIndex:100,display:"flex",flexDirection:"column",justifyContent:"flex-end"}}
          onClick={e => { if(e.target===e.currentTarget) setShowSettings(false); }}>
          <div style={{background:"#13102a",borderRadius:"20px 20px 0 0",padding:"20px 20px 40px",border:"1px solid #2a1a4a"}}>
            <div style={{width:40,height:4,background:"#3a2a5a",borderRadius:2,margin:"0 auto 20px"}}/>
            <div style={{fontSize:16,fontWeight:"bold",color:"#a78bfa",marginBottom:20}}>⚙️ Настройки</div>
            <div style={{padding:"14px",background:"#0a1a0a",border:"1px solid #1a4a1a",borderRadius:12,marginBottom:16}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:"#22c55e",boxShadow:"0 0 8px #22c55e",flexShrink:0}}/>
                <span style={{fontSize:14,fontWeight:"bold",color:"#22c55e"}}>GitHub подключён</span>
              </div>
              <div style={{fontSize:11,color:"#4a7a4a",lineHeight:1.7}}>
                <div>✦ Создание репозиториев и веток</div>
                <div>✦ Запись и обновление файлов</div>
                <div>✦ Создание задач (issues)</div>
                <div>✦ Просмотр кода</div>
              </div>
            </div>
            <div style={{padding:"14px",background:"#0d0d1a",border:"1px solid #2a1a4a",borderRadius:12,marginBottom:20}}>
              <div style={{fontSize:11,color:"#7a6090",marginBottom:8,fontWeight:"bold"}}>ИИ модели</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:12,color:"#a78bfa"}}>Gemini 2.0 Flash</span>
                  <span style={{fontSize:10,color:"#5a4a7a",background:"#1a1035",borderRadius:4,padding:"2px 6px"}}>основной</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:12,color:"#60a5fa"}}>Groq llama-3.3-70b</span>
                  <span style={{fontSize:10,color:"#5a4a7a",background:"#1a1035",borderRadius:4,padding:"2px 6px"}}>резерв</span>
                </div>
              </div>
            </div>
            <button onClick={() => setShowSettings(false)}
              style={{width:"100%",background:"#7c3aed",border:"none",borderRadius:10,padding:"12px",color:"#fff",fontWeight:"bold",fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>
              Закрыть
            </button>
          </div>
        </div>
      )}
      <div style={{padding:"12px 16px 8px",background:"#13102a",borderBottom:"1px solid #2a1a4a",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:16,fontWeight:"bold",letterSpacing:1,color:"#a78bfa"}}>Dev Office</span>
          <div style={{display:"flex",gap:3,flexWrap:"wrap",flex:1}}>
            {agents.map(a => (
              <div key={a.id} style={{width:6,height:6,borderRadius:"50%",background:a.shirtColor,
                boxShadow:sendingIds.has(a.id) ? `0 0 5px ${a.shirtColor}` : "none"}}/>
            ))}
          </div>
          {githubToken && <span style={{fontSize:9,color:"#22c55e"}}>● GitHub</span>}
          <button onClick={() => setShowSettings(true)}
            style={{background:"none",border:"1px solid #3a2a5a",borderRadius:8,padding:"5px 10px",color:"#7a6090",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
            ⚙️
          </button>
        </div>
      </div>
      <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
        {tab === "agents" ? (
          <div ref={pullListRef} style={{flex:1,overflowY:"auto",position:"relative"}}
            onTouchStart={onPullStart} onTouchMove={onPullMove} onTouchEnd={onPullEnd}>
            {(pullY > 0 || refreshing) && (
              <div style={{display:"flex",justifyContent:"center",alignItems:"center",height:pullY||40,
                color:"#7a6090",fontSize:12,transition:pullY>0?"none":"height 0.3s",overflow:"hidden"}}>
                {refreshing ? "Обновляем…" : pullY >= 55 ? "↑ Отпустите" : "↓ Потяните для обновления"}
              </div>
            )}
            {agents.map((agent) => {
              const hist = chatHistories[agent.id] || [];
              const lastMsg = hist.filter(m=>m.role!=="system").at(-1);
              const isBusy = sendingIds.has(agent.id);
              const seenCount = lastSeen[agent.id] || 0;
              const unreadCount = Math.max(0, hist.length - seenCount);
              const hasUnread = unreadCount > 0;
              return (
                <div key={agent.id} onClick={() => openChat(agent.id)}
                  style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                    borderBottom:"1px solid #1a1530",cursor:"pointer",
                    background:hasUnread?"#16122e":"transparent",
                    transition:"background 0.15s"}}
                  onTouchStart={e=>(e.currentTarget.style.background="#1e1a35")}
                  onTouchEnd={e=>(e.currentTarget.style.background=hasUnread?"#16122e":"transparent")}>
                  <div style={{position:"relative",flexShrink:0}}>
                    <div style={{width:46,height:46,borderRadius:"50%",background:agent.shirtColor,
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontWeight:"bold",fontSize:18,color:"#fff",
                      boxShadow:isBusy?`0 0 12px ${agent.shirtColor}99`:`0 0 0 2px ${agent.shirtColor}33`}}>
                      {agent.name.charAt(0)}
                    </div>
                    {isBusy && <div style={{position:"absolute",bottom:1,right:1,width:12,height:12,borderRadius:"50%",
                      background:"#22c55e",border:"2px solid #0d0d1a",boxShadow:"0 0 6px #22c55e"}}/> }
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:2}}>
                      <span style={{fontWeight:"bold",fontSize:14,color:agent.shirtColor}}>{agent.name}</span>
                      <span style={{fontSize:9,color:"#3a2a5a",flexShrink:0,marginLeft:8}}>{agent.role}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                      <div style={{fontSize:12,color:"#5a4a7a",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",flex:1}}>
                        {isBusy ? <span style={{color:"#22c55e"}}>печатает…</span>
                          : lastMsg ? <><span style={{color: lastMsg.role==="user"?"#3a2a5a":"#7a6a9a"}}>{lastMsg.role==="user"?"Вы: ":""}</span><span style={{fontWeight:hasUnread&&lastMsg.role!=="user"?"bold":"normal",color:hasUnread?"#c4b8f0":"#5a4a7a"}}>{lastMsg.text.replace(/```[\s\S]*?```/g,"[код]").slice(0,50)}{lastMsg.text.length>50?"…":""}</span></>
                          : <span style={{color:"#2a1a3a",fontStyle:"italic"}}>нет сообщений</span>}
                      </div>
                      {lastMsg?.ts && <span style={{fontSize:9,color:"#3a2a5a",marginLeft:6,flexShrink:0}}>{fmtTime(lastMsg.ts)}</span>}
                    </div>
                  </div>
                  {hasUnread && (
                    <div style={{background:agent.shirtColor,borderRadius:12,minWidth:22,height:22,
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontSize:11,fontWeight:"bold",color:"#fff",padding:"0 6px",flexShrink:0,
                      boxShadow:`0 0 8px ${agent.shirtColor}88`}}>
                      {unreadCount}
                    </div>
                  )}
                  <span style={{color:"#2a1a3a",fontSize:14,flexShrink:0}}>›</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div style={{padding:"10px 14px",borderBottom:"1px solid #2a1a4a",background:"#13102a",flexShrink:0,display:"flex",gap:8}}>
              <input value={teamTopic} onChange={e=>setTeamTopic(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&startTeamDiscussion()}
                placeholder="Тема для обсуждения всей командой…" disabled={teamLoading}
                style={{flex:1,background:"#1a1035",border:"1px solid #5a3a8a",borderRadius:8,padding:"8px 12px",
                  color:"#d4b8f0",fontSize:12,outline:"none",fontFamily:"inherit"}}/>
              <button onClick={startTeamDiscussion} disabled={teamLoading||!teamTopic.trim()}
                style={{background:"#7c3aed",border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",
                  fontWeight:"bold",fontSize:14,cursor:teamLoading?"wait":"pointer",
                  opacity:teamLoading||!teamTopic.trim()?0.5:1,flexShrink:0,fontFamily:"inherit"}}>
                {teamLoading?"…":"→"}
              </button>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"12px 14px",display:"flex",flexDirection:"column",gap:10}}>
              {teamDiscussion.length===0&&!teamLoading&&(
                <div style={{color:"#3a2a5a",fontSize:12,textAlign:"center",marginTop:60,lineHeight:1.8}}>
                  Напиши тему — вся команда обсудит её вместе
                </div>
              )}
              {teamLoading&&<div style={{color:"#7a5a9a",fontSize:11,textAlign:"center",marginTop:40}}>Команда обсуждает…</div>}
              {teamDiscussion.map((m,i)=>{
                const ag=agents.find(a=>a.id===m.agentId);
                const color=ag?.shirtColor||"#a78bfa";
                return (
                  <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                    <div style={{width:30,height:30,borderRadius:"50%",background:color,display:"flex",alignItems:"center",
                      justifyContent:"center",fontWeight:"bold",fontSize:12,color:"#fff",flexShrink:0}}>
                      {m.agentName.charAt(0)}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:9,color:color,fontWeight:"bold",marginBottom:2}}>{m.agentName} · {m.role}</div>
                      <div style={{background:"#13102a",border:`1px solid ${color}33`,borderRadius:10,borderTopLeftRadius:2,
                        padding:"8px 10px",fontSize:12,color:"#d4c8f0",lineHeight:1.55,wordBreak:"break-word"}}>{m.text}</div>
                    </div>
                  </div>
                );
              })}
              <div ref={teamEndRef}/>
            </div>
          </div>
        )}
      </div>
      <div style={{display:"flex",background:"#13102a",borderTop:"2px solid #2a1a4a",flexShrink:0}}>
        <button style={TAB_STYLE(tab==="agents")} onClick={()=>setTab("agents")}>👤 Агенты</button>
        <button style={TAB_STYLE(tab==="team")} onClick={()=>setTab("team")}>
          💬 Команда{teamDiscussion.length>0?` (${teamDiscussion.length})`:""}
        </button>
      </div>
    </div>
  );
}

function loadFromStorage<T>(key:string,fallback:T):T{
  if(typeof window==="undefined")return fallback;
  try{const s=localStorage.getItem(key);return s?JSON.parse(s):fallback;}catch{return fallback;}
}

const IDB_DB = 'dev-office-v1';
const IDB_STORE = 'tasks';

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = e => {
      (e.target as IDBOpenDBRequest).result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = e => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(task: object) {
  const db = await idbOpen();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put(task);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function idbGetAll(): Promise<Record<string, unknown>[]> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(id: string) {
  const db = await idbOpen();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export default function Home(){
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const agentsRef=useRef<AgentRT[]>([]);
  const spritesRef=useRef<(HTMLImageElement|null)[]>([]);
  const rafRef=useRef<number>(0);
  const lastTRef=useRef<number>(0);
  const resumedRef=useRef(false);
  const sendingRef=useRef<Set<string>>(new Set());
  const desktopChatEndRef=useRef<HTMLDivElement>(null);

  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [chatHistories,setChatHistories]=useState<Record<string,ChatMsg[]>>(
    ()=>loadFromStorage("dev_office_history",{})
  );
  const [inputText,setInputText]=useState("");
  const [sending,setSending]=useState(false);
  const [githubToken,setGithubToken]=useState<string>(
    ()=>loadFromStorage("dev_office_github","")
  );
  const [showSettings,setShowSettings]=useState(false);
  const [tokenInput,setTokenInput]=useState("");
  const [showTeamChat,setShowTeamChat]=useState(false);
  const [teamDiscussion,setTeamDiscussion]=useState<{agentId:string;agentName:string;role:string;text:string}[]>([]);
  const [teamTopic,setTeamTopic]=useState("");
  const [teamLoading,setTeamLoading]=useState(false);
  const [isMobile,setIsMobile]=useState(false);
  const [sendingIds,setSendingIds]=useState<Set<string>>(new Set());
  const [lastSeen,setLastSeen]=useState<Record<string,number>>(
    ()=>loadFromStorage("dev_office_seen",{})
  );

  useEffect(()=>{
    const check=()=>setIsMobile(window.innerWidth<768);
    check();
    window.addEventListener('resize',check);
    return()=>window.removeEventListener('resize',check);
  },[]);

  // Track which (agentId, msgIndex) pairs have already been auto-dispatched
  const dispatchedRef = useRef<Set<string>>(new Set());

  useEffect(()=>{
    async function fetchHistories(){
      try{
        const res=await fetch('/api/history');
        if(!res.ok)return;
        const data=await res.json();
        if(data&&typeof data==='object'){
          const toAutoDispatch: {id:string; msg:string; hist:ChatMsg[]}[]=[];
          setChatHistories(prev=>{
            const merged={...prev};
            for(const [id,msgs] of Object.entries(data) as [string,ChatMsg[]][]){
              const localLen=(prev[id]||[]).length;
              // API is authoritative: always apply if empty (cleared) or longer than local
              if(!sendingRef.current.has(id) && (msgs.length === 0 || msgs.length >= localLen)){
                merged[id]=msgs;
              }
              // Auto-dispatch any user message at the end that hasn't been dispatched yet
              const last=msgs[msgs.length-1];
              const key=`${id}:${msgs.length-1}`;
              if(last?.role==="user" && !sendingRef.current.has(id) && !dispatchedRef.current.has(key)){
                dispatchedRef.current.add(key);
                toAutoDispatch.push({id, msg:last.text, hist:msgs.slice(0,-1)});
              }
            }
            return merged;
          });
          // Dispatch outside setState to avoid closure issues
          toAutoDispatch.forEach(({id,msg,hist},i)=>{
            setTimeout(()=>dispatchTask(id,msg,hist), i*600);
          });
        }
      }catch{}
    }
    fetchHistories();
    const iv=setInterval(fetchHistories,3_000);
    return()=>clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(()=>{ try{localStorage.setItem("dev_office_history",JSON.stringify(chatHistories));}catch{} },[chatHistories]);
  useEffect(()=>{ try{localStorage.setItem("dev_office_github",githubToken);}catch{} },[githubToken]);
  useEffect(()=>{ try{localStorage.setItem("dev_office_seen",JSON.stringify(lastSeen));}catch{} },[lastSeen]);

  useEffect(()=>{
    spritesRef.current=SPRITE_URLS.map(()=>null);
    SPRITE_URLS.forEach((url,i)=>{
      const img=new Image();
      img.onload=()=>{spritesRef.current[i]=img;};
      img.onerror=()=>{spritesRef.current[i]=null;};
      img.src=url;
    });
  },[]);

  useEffect(()=>{
    agentsRef.current=AGENTS.map((def,i)=>{
      const seat=SEATS[i];
      return{def,si:i%6,ax:seat.tx*TILE+TILE/2,ay:seat.ty*TILE+TILE/2,
        tileX:seat.tx,tileY:seat.ty,path:[],state:"idle" as AState,dir:seat.dir,
        animT:0,animF:0,seatI:i,bubble:null,bubbleT:0,onPathEnd:null,busy:false};
    });
  },[]);

  useEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const rawCtx=canvas.getContext("2d");if(!rawCtx)return;
    const ctx:CanvasRenderingContext2D=rawCtx;
    let fc=0;
    function updateAgent(ag:AgentRT,dt:number){
      ag.animT+=dt;
      const fps=ag.state==="walk"?8:ag.state==="type"?4:2;
      const frames=ag.state==="walk"?4:ag.state==="type"?2:2;
      if(ag.animT>=1/fps){ag.animT=0;ag.animF=(ag.animF+1)%frames;}
      if(ag.bubbleT>0){ag.bubbleT-=dt;if(ag.bubbleT<=0)ag.bubble=null;}
      if(ag.path.length>0){
        const next=ag.path[0];
        const nax=next.x*TILE+TILE/2,nay=next.y*TILE+TILE/2;
        const dx=nax-ag.ax,dy=nay-ag.ay,dist=Math.sqrt(dx*dx+dy*dy),step=WALK_SPD*dt;
        ag.dir=dirBetween(ag.ax,ag.ay,nax,nay);
        if(dist<=step+0.01){
          ag.ax=nax;ag.ay=nay;ag.tileX=next.x;ag.tileY=next.y;ag.path.shift();
          if(ag.path.length===0){const cb=ag.onPathEnd;ag.onPathEnd=null;if(cb)cb();}
        }else{ag.ax+=dx/dist*step;ag.ay+=dy/dist*step;}
      }
    }
    function loop(ts:number){
      const dt=Math.min((ts-lastTRef.current)/1000,0.1);
      lastTRef.current=ts;fc++;
      for(const ag of agentsRef.current)updateAgent(ag,dt);
      ctx.clearRect(0,0,W,H);
      drawScene(ctx,agentsRef.current,spritesRef.current,fc);
      rafRef.current=requestAnimationFrame(loop);
    }
    rafRef.current=requestAnimationFrame(loop);
    return()=>cancelAnimationFrame(rafRef.current);
  },[]);

  function walkTo(ag:AgentRT,tx:number,ty:number,onEnd:()=>void){
    const path=bfs(ag.tileX,ag.tileY,tx,ty);
    if(path.length===0){onEnd();return;}
    ag.path=path;ag.state="walk";ag.onPathEnd=onEnd;
  }
  function returnToSeat(ag:AgentRT,thenState:AState="idle"){
    const seat=SEATS[ag.seatI];
    walkTo(ag,seat.tx,seat.ty,()=>{
      ag.state=thenState;ag.dir=seat.dir;ag.animF=0;
      if(thenState==="idle")ag.busy=false;
    });
  }

  const dispatchTask = useCallback(async(agentId:string, msg:string, history:ChatMsg[])=>{
    if(sendingRef.current.has(agentId))return;
    sendingRef.current.add(agentId);
    setSendingIds(s=>{const n=new Set(s);n.add(agentId);return n;});
    const ag=agentsRef.current.find(a=>a.def.id===agentId);
    if(ag){ag.state="type";ag.dir=SEATS[ag.seatI].dir;ag.busy=true;ag.bubble=null;}
    const apiHistory=history.filter(m=>m.role==="user"||m.role==="model").map(m=>({role:m.role as "user"|"model",text:m.text}));
    const autoRetry=async(waitSecs:number)=>{
      let secs=waitSecs;
      setChatHistories(p=>({...p,[agentId]:[...(p[agentId]||[]),{role:"system",text:`⏳ Лимит запросов. Авто-повтор через ${secs} сек…`}]}));
      sendingRef.current.delete(agentId);
      setSendingIds(s=>{const n=new Set(s);n.delete(agentId);return n;});
      if(agentId===selectedId)setSending(false);
      const countId=setInterval(()=>{
        secs--;
        setChatHistories(p=>{
          const hist=p[agentId]||[];
          const last=hist[hist.length-1];
          if(last?.role==="system"&&last.text.startsWith("⏳")){
            return{...p,[agentId]:[...hist.slice(0,-1),{role:"system",text:`⏳ Лимит запросов. Авто-повтор через ${secs} сек…`}]};
          }
          return p;
        });
        if(secs<=0)clearInterval(countId);
      },1000);
      await new Promise(r=>setTimeout(r,waitSecs*1000));
      clearInterval(countId);
      setChatHistories(p=>({...p,[agentId]:(p[agentId]||[]).filter(m=>!(m.role==="system"&&m.text.startsWith("⏳")))}));
      dispatchTask(agentId,msg,history);
    };
    try{
      const res=await fetch("/api/agent",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({message:msg,agentId,history:apiHistory,githubToken})});
      let data:Record<string,unknown>;
      try{data=await res.json();}catch{data={error:`HTTP ${res.status}`};}
      if(res.status===429&&data.retryAfter){
        await autoRetry(Math.min(data.retryAfter as number,120));
        return;
      }
      const reply=(data.text as string)||(data.error?`⚠️ Ошибка: ${data.error}`:"⚠️ Нет ответа от агента");
      const acts:string[]|undefined=data.githubActions as string[]|undefined;
      const showReply=()=>{
        setChatHistories(p=>{
          const prev=p[agentId]||[];
          return{...p,[agentId]:[...prev,{role:"model",text:reply,ts:Date.now(),...(acts?{githubActions:acts}:{})}]};
        });
        if(ag){
          ag.bubble=reply.slice(0,60);ag.bubbleT=6;
          setTimeout(()=>{
            if(ag.tileX===SEATS[ag.seatI].tx&&ag.tileY===SEATS[ag.seatI].ty){
              ag.state="idle";ag.dir=SEATS[ag.seatI].dir;ag.busy=false;
            }else returnToSeat(ag,"idle");
          },5000);
        }
      };
      showReply();
      // If consult_agent was called, immediately refresh those agents' histories
      if(acts && acts.length>0){
        const consultedIds=[...new Set(
          acts.filter(a=>a.startsWith("👥")).map(a=>a.replace(/^👥\s*/,"").split(":")[0].trim())
        )];
        if(consultedIds.length>0){
          try{
            const hres=await fetch('/api/history');
            if(hres.ok){
              const hdata=await hres.json();
              if(hdata&&typeof hdata==='object'){
                setChatHistories(prev=>{
                  const merged={...prev};
                  for(const id of consultedIds){
                    const fresh=hdata[id] as ChatMsg[]|undefined;
                    if(fresh && fresh.length>(prev[id]||[]).length) merged[id]=fresh;
                  }
                  return merged;
                });
              }
            }
          }catch{}
        }
      }
    }catch{
      await autoRetry(20);
      return;
    }finally{
      sendingRef.current.delete(agentId);
      setSendingIds(s=>{const n=new Set(s);n.delete(agentId);return n;});
      if(agentId===selectedId)setSending(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[githubToken,selectedId]);

  useEffect(()=>{
    if(resumedRef.current)return;
    resumedRef.current=true;
    const toResume=Object.entries(chatHistories).filter(([,hist])=>hist.length>0&&hist[hist.length-1].role==="user");
    toResume.forEach(([agentId,hist],i)=>{
      setTimeout(()=>dispatchTask(agentId,hist[hist.length-1].text,hist.slice(0,-1)),600+i*400);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  async function sendMessage(){
    if(!inputText.trim()||!selectedId||sending||sendingRef.current.has(selectedId))return;
    const msg=inputText.trim();setInputText("");setSending(true);
    const history=chatHistories[selectedId]||[];
    setChatHistories(p=>({...p,[selectedId!]:[...(p[selectedId!]||[]),{role:"user",text:msg,ts:Date.now()}]}));
    await dispatchTask(selectedId,msg,history);
  }

  function markSeen(agentId:string){
    const hist=chatHistories[agentId]||[];
    setLastSeen(p=>({...p,[agentId]:hist.length}));
  }

  function handleCanvasClick(e:React.MouseEvent<HTMLCanvasElement>){
    const canvas=canvasRef.current;if(!canvas)return;
    const rect=canvas.getBoundingClientRect();
    const mx=(e.clientX-rect.left)*(W/rect.width),my=(e.clientY-rect.top)*(H/rect.height);
    let found:AgentRT|null=null;
    for(const ag of agentsRef.current){
      const sx=ag.ax*SCALE,sy=ag.ay*SCALE;
      if(mx>=sx-CHAR_W*SCALE/2&&mx<=sx+CHAR_W*SCALE/2&&my>=sy-CHAR_H*SCALE&&my<=sy){found=ag;break;}
    }
    if(found) markSeen(found.def.id);
    setSelectedId(found?found.def.id:null);
  }

  function clearHistory(agentId:string){
    setChatHistories(p=>{const n={...p};delete n[agentId];return n;});
    fetch("/api/history",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentId})}).catch(()=>{});
  }

  async function startTeamDiscussion(){
    if(!teamTopic.trim()||teamLoading)return;
    setTeamLoading(true);setTeamDiscussion([]);
    try{
      const res=await fetch('/api/team',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:teamTopic})});
      const data=await res.json();
      if(data.messages)setTeamDiscussion(data.messages);
    }catch{}
    setTeamLoading(false);
  }

  const selAgent=AGENTS.find(a=>a.id===selectedId);
  const chatHist=selectedId?chatHistories[selectedId]||[]:[];
  const hasGithub=!!githubToken;

  // Scroll to bottom when agent selected or new message arrives
  useEffect(()=>{
    desktopChatEndRef.current?.scrollIntoView({ behavior:"instant" });
  },[chatHist,selectedId]);
  const totalMsgs=Object.values(chatHistories).reduce((s,h)=>s+h.length,0);

  if(isMobile){
    return <MobileLayout agents={AGENTS} chatHistories={chatHistories} sending={sending} sendingIds={sendingIds} onSend={dispatchTask} setChatHistories={setChatHistories} githubToken={githubToken} lastSeen={lastSeen} onMarkSeen={id=>{const h=chatHistories[id]||[];setLastSeen(p=>({...p,[id]:h.length}));}}/>;
  }

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#12120f",fontFamily:"'Courier New',monospace",color:"#e2e8f0",overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"5px 12px",background:"#1a1a0e",borderBottom:"2px solid #3a3010",flexShrink:0}}>
        <span style={{fontSize:13,fontWeight:"bold",letterSpacing:1,color:"#D4A843"}}>Dev Office</span>
        <div style={{display:"flex",gap:4,marginLeft:6,flexWrap:"wrap"}}>
          {AGENTS.map(a=>(
            <div key={a.id} title={`${a.name} (${a.role})`}
              style={{width:10,height:10,borderRadius:"50%",background:a.shirtColor,
                border:selectedId===a.id?"2px solid #fff":"2px solid transparent",cursor:"pointer",
                boxShadow:chatHistories[a.id]?.length?`0 0 4px ${a.shirtColor}88`:"none"}}
              onClick={()=>setSelectedId(selectedId===a.id?null:a.id)}/>
          ))}
        </div>
        {totalMsgs>0&&<span style={{fontSize:9,color:"#5a8a3a",marginLeft:4}}>💾 {totalMsgs} сообщ.</span>}
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          <span style={{fontSize:9,color:"#22c55e"}}>● GitHub</span>
          <button onClick={()=>setShowTeamChat(!showTeamChat)}
            style={{background:showTeamChat?"#2a1a3a":"#1a0a2a",border:"1px solid #5a3a8a",borderRadius:4,padding:"2px 8px",color:"#c084fc",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>Команда</button>
        </div>
      </div>
      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",padding:4}}>
          <canvas ref={canvasRef} width={W} height={H} onClick={handleCanvasClick}
            style={{maxWidth:"100%",maxHeight:"100%",imageRendering:"pixelated",cursor:"crosshair",
              border:"3px solid #3a3010",boxShadow:"0 0 20px rgba(0,0,0,0.5)"}}/>
        </div>
        {showTeamChat&&(
          <div style={{width:340,display:"flex",flexDirection:"column",background:"#120a1e",borderLeft:"3px solid #5a3a8a",flexShrink:0}}>
            <div style={{padding:"8px 12px",borderBottom:"2px solid #3a2060",background:"#1a0a2a",display:"flex",alignItems:"center",gap:8}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:"bold",fontSize:13,color:"#c084fc"}}>Командный чат</div>
                <div style={{fontSize:9,color:"#7a5a9a"}}>Обсуждение всей командой</div>
              </div>
              <button onClick={()=>setShowTeamChat(false)}
                style={{background:"#2a1a3a",border:"1px solid #5a3a8a",borderRadius:3,padding:"2px 6px",color:"#c084fc",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
            </div>
            <div style={{padding:8,borderBottom:"1px solid #3a2060",display:"flex",gap:6}}>
              <input value={teamTopic} onChange={e=>setTeamTopic(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&startTeamDiscussion()}
                placeholder="Тема для обсуждения..." disabled={teamLoading}
                style={{flex:1,background:"#1a0a2a",border:"1px solid #5a3a8a",borderRadius:5,padding:"5px 9px",color:"#d4b8f0",fontSize:11,outline:"none",fontFamily:"inherit"}}/>
              <button onClick={startTeamDiscussion} disabled={teamLoading||!teamTopic.trim()}
                style={{background:"#5a3a8a",border:"none",borderRadius:5,padding:"5px 11px",color:"#fff",fontWeight:"bold",fontSize:12,
                  cursor:teamLoading?"wait":"pointer",opacity:teamLoading||!teamTopic.trim()?0.5:1,fontFamily:"inherit"}}>
                {teamLoading?"…":"→"}</button>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:8,display:"flex",flexDirection:"column",gap:6}}>
              {teamDiscussion.length===0&&!teamLoading&&(
                <div style={{color:"#4a2a6a",fontSize:10,textAlign:"center",marginTop:40,lineHeight:1.6}}>
                  Введи тему и вся команда обсудит её<br/><span style={{color:"#6a4a8a"}}>на русском языке</span>
                </div>
              )}
              {teamLoading&&<div style={{color:"#7a5a9a",fontSize:10,textAlign:"center",marginTop:40}}>Команда обсуждает...</div>}
              {teamDiscussion.map((m,i)=>{
                const color=AGENTS.find(a=>a.id===m.agentId)?.shirtColor||"#c084fc";
                return(
                  <div key={i} style={{display:"flex",flexDirection:"column",gap:2}}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:color,flexShrink:0}}/>
                      <span style={{fontSize:9,color,fontWeight:"bold"}}>{m.agentName}</span>
                      <span style={{fontSize:8,color:"#5a4a7a"}}>{m.role}</span>
                    </div>
                    <div style={{padding:"5px 9px",borderRadius:6,fontSize:11,lineHeight:1.5,
                      background:"#1a0a2a",border:`1px solid ${color}44`,color:"#d4b8f0",
                      whiteSpace:"pre-wrap",wordBreak:"break-word",marginLeft:13}}>{m.text}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {selAgent&&!showTeamChat&&(
          <div style={{width:310,display:"flex",flexDirection:"column",background:"#1a1208",borderLeft:`3px solid ${selAgent.shirtColor}`,flexShrink:0}}>
            <div style={{padding:"8px 12px",borderBottom:`2px solid ${selAgent.shirtColor}44`,background:"#221a0a",display:"flex",alignItems:"center",gap:8}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:"bold",fontSize:13,color:selAgent.shirtColor}}>{selAgent.name}</div>
                <div style={{fontSize:9,color:"#7a6830"}}>{selAgent.role}</div>
              </div>
              {chatHist.length>0&&(
                <button onClick={()=>clearHistory(selAgent.id)}
                  style={{background:"#3a1a1a",border:"1px solid #5a2a2a",borderRadius:3,padding:"2px 6px",color:"#f87171",fontSize:9,cursor:"pointer",fontFamily:"inherit"}}>очистить</button>
              )}
            </div>
            <div style={{flex:1,overflowY:"auto",padding:8,display:"flex",flexDirection:"column",gap:6}}>
              {chatHist.length===0&&(
                <div style={{color:"#4a3a10",fontSize:10,textAlign:"center",marginTop:40,lineHeight:1.6}}>
                  Дай задание {selAgent.name}
                  {hasGithub&&<><br/><span style={{color:"#3a6a3a"}}>GitHub подключён</span></>}
                </div>
              )}
              {chatHist.map((m,i)=>(
                <div key={i}>
                  {m.role==="system"?(
                    <div style={{fontSize:9,color:"#5a8a5a",textAlign:"center",padding:"2px 6px",background:"#0a1a0a",borderRadius:4,border:"1px solid #2a4a2a"}}>{m.text}</div>
                  ):(
                    <div style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                      <div style={{maxWidth:"88%"}}>
                        <div style={{padding:"5px 9px",borderRadius:6,fontSize:11,lineHeight:1.5,
                          background:m.role==="user"?"#3a2a05":"#221a0a",
                          border:m.role==="model"?`1px solid ${selAgent.shirtColor}55`:"1px solid #3a2a05",
                          color:m.role==="user"?"#f0d070":"#d4c090",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{m.text}</div>
                        {m.githubActions&&m.githubActions.length>0&&(
                          <div style={{marginTop:3,padding:"3px 6px",background:"#0a1a0a",border:"1px solid #2a5a2a",borderRadius:4,fontSize:9,color:"#5aaa5a"}}>
                            {m.githubActions.map((a,j)=>(<div key={j} style={{marginBottom:1}}>⚡ {a.slice(0,80)}</div>))}
                          </div>
                        )}
                        {m.ts&&<div style={{fontSize:8,color:"#4a3a10",marginTop:1,textAlign:m.role==="user"?"right":"left"}}>{fmtTime(m.ts)}</div>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div ref={desktopChatEndRef}/>
            <div style={{padding:8,borderTop:`2px solid ${selAgent.shirtColor}44`,display:"flex",gap:6}}>
              <input value={inputText} onChange={e=>setInputText(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendMessage()}
                placeholder={`Задание для ${selAgent.name}…`} disabled={sending}
                style={{flex:1,background:"#221a0a",border:`1px solid ${selAgent.shirtColor}55`,borderRadius:5,padding:"5px 9px",color:"#d4c090",fontSize:11,outline:"none",fontFamily:"inherit"}}/>
              <button onClick={sendMessage} disabled={sending||!inputText.trim()}
                style={{background:selAgent.shirtColor,border:"none",borderRadius:5,padding:"5px 11px",
                  color:"#1a1208",fontWeight:"bold",fontSize:12,cursor:sending?"wait":"pointer",
                  opacity:sending||!inputText.trim()?0.5:1,fontFamily:"inherit"}}>
                {sending?"…":"→"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
