"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { AGENTS, AgentDef } from "@/lib/agents";

const TILE  = 16;
const SCALE = 3;
const RT    = TILE * SCALE;
const COLS  = 20;
const ROWS  = 11;
const W     = COLS * RT;
const H     = ROWS * RT;
const WALK_SPD = 48;

type Dir    = 0 | 1 | 2 | 3;
const DOWN = 0, LEFT = 1, RIGHT = 2, UP = 3;
type AState = "idle" | "type" | "walk" | "talk";

const CHAR_W = 16, CHAR_H = 32;
const SPRITE_URLS = [0,1,2,3,4,5].map(
  i => `https://raw.githubusercontent.com/pablodelucca/pixel-agents/main/webview-ui/public/assets/characters/char_${i}.png`
);

const SEATS = [
  {tx:2, ty:3, dir:UP   as Dir},
  {tx:5, ty:3, dir:UP   as Dir},
  {tx:8, ty:3, dir:UP   as Dir},
  {tx:11,ty:3, dir:UP   as Dir},
  {tx:14,ty:3, dir:UP   as Dir},
  {tx:2, ty:7, dir:DOWN as Dir},
  {tx:5, ty:7, dir:DOWN as Dir},
  {tx:8, ty:7, dir:DOWN as Dir},
  {tx:11,ty:7, dir:DOWN as Dir},
  {tx:14,ty:7, dir:DOWN as Dir},
];
const DESK_OBS = [
  {tx:2,ty:2},{tx:5,ty:2},{tx:8,ty:2},{tx:11,ty:2},{tx:14,ty:2},
  {tx:2,ty:8},{tx:5,ty:8},{tx:8,ty:8},{tx:11,ty:8},{tx:14,ty:8},
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
  const chairY=isTop?dsy+RT+2:dsy-RT*0.6,chairX=seatTile.tx*RT+RT/2-RT*0.6,chairW=RT*1.2,chairH=RT*0.55;
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
  const seat=SEATS[ag.seatI],isTop=ag.seatI<5;
  const bx=seat.tx*RT+RT/2,by=isTop?seat.ty*RT+RT+8:seat.ty*RT-18;
  const label=`${ag.def.name} · ${ag.def.role}`;
  ctx.font="bold 8px monospace";
  const tw=ctx.measureText(label).width;
  rr(ctx,bx-tw/2-5,by,tw+10,12,2);
  ctx.fillStyle="rgba(10,10,20,0.85)";ctx.fill();
  ctx.strokeStyle=ag.def.shirtColor;ctx.lineWidth=1;ctx.stroke();
  ctx.fillStyle=ag.def.shirtColor;ctx.fillText(label,bx-tw/2,by+9);
  if(ag.busy){
    ctx.fillStyle="#22c55e";ctx.beginPath();ctx.arc(bx+tw/2+7,by+6,3,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=0.4+0.4*Math.sin(fc*0.15);ctx.strokeStyle="#22c55e";ctx.lineWidth=1.5;
    ctx.beginPath();ctx.arc(bx+tw/2+7,by+6,5,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;
  }
}
function drawScene(ctx:CanvasRenderingContext2D,agents:AgentRT[],sprites:(HTMLImageElement|null)[],fc:number){
  drawFloor(ctx);drawWalls(ctx);drawBookshelves(ctx);
  for(let i=0;i<10;i++)drawDeskStation(ctx,SEATS[i],i<5,agents[i],fc);
  drawPlant(ctx,RT+RT/2,H-RT-2,fc,0);drawPlant(ctx,W-RT-RT/2,H-RT-2,fc,1);
  drawBoxes(ctx,RT+RT*2,RT*2+RT/2);drawPlant(ctx,W-RT-RT/2,RT*2+8,fc,2);
  for(const ag of agents)drawNameBadge(ctx,ag,fc);
  const sorted=[...agents].sort((a,b)=>a.ay-b.ay);
  for(const ag of sorted)drawChar(ctx,sprites,ag,Math.round(ag.ax*SCALE),Math.round(ag.ay*SCALE),fc);
  for(const ag of agents)if(ag.bubble)drawBubble(ctx,ag,ag.bubble,Math.round(ag.ax*SCALE),Math.round(ag.ay*SCALE));
}
function drawChar(ctx:CanvasRenderingContext2D,sprites:(HTMLImageElement|null)[],ag:AgentRT,sx:number,sy:number,fc:number){
  const sprite=sprites[ag.si];
  if(sprite&&sprite.complete&&sprite.naturalWidth>0){
    const row=ag.dir,col=ag.state==="type"?4+ag.animF%2:ag.state==="walk"?ag.animF%4:0;
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

type ChatMsg = {role:"user"|"model"|"system"; text:string; githubActions?:string[]};

function loadFromStorage<T>(key:string,fallback:T):T{
  if(typeof window==="undefined")return fallback;
  try{const s=localStorage.getItem(key);return s?JSON.parse(s):fallback;}catch{return fallback;}
}

export default function Home(){
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const agentsRef=useRef<AgentRT[]>([]);
  const spritesRef=useRef<(HTMLImageElement|null)[]>([]);
  const rafRef=useRef<number>(0);
  const lastTRef=useRef<number>(0);
  const resumedRef=useRef(false);
  const sendingRef=useRef<Set<string>>(new Set());

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

  // Persist chat histories
  useEffect(()=>{
    try{localStorage.setItem("dev_office_history",JSON.stringify(chatHistories));}catch{}
  },[chatHistories]);

  // Persist github token
  useEffect(()=>{
    try{localStorage.setItem("dev_office_github",githubToken);}catch{}
  },[githubToken]);

  // Load sprites
  useEffect(()=>{
    spritesRef.current=SPRITE_URLS.map(()=>null);
    SPRITE_URLS.forEach((url,i)=>{
      const img=new Image();img.crossOrigin="anonymous";
      img.onload=()=>{spritesRef.current[i]=img;};
      img.onerror=()=>{spritesRef.current[i]=null;};
      img.src=url;
    });
  },[]);

  // Init agents
  useEffect(()=>{
    agentsRef.current=AGENTS.map((def,i)=>{
      const seat=SEATS[i];
      return{def,si:i%6,ax:seat.tx*TILE+TILE/2,ay:seat.ty*TILE+TILE/2,
        tileX:seat.tx,tileY:seat.ty,path:[],state:"idle" as AState,dir:seat.dir,
        animT:0,animF:0,seatI:i,bubble:null,bubbleT:0,onPathEnd:null,busy:false};
    });
  },[]);

  // Game loop
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
    const ag=agentsRef.current.find(a=>a.def.id===agentId);
    if(ag){ag.state="type";ag.dir=SEATS[ag.seatI].dir;ag.busy=true;ag.bubble=null;}

    const willConsult=ag&&Math.random()<0.3;
    let consultTarget:AgentRT|null=null;
    let consultDone=false;
    if(willConsult&&ag){
      const others=agentsRef.current.filter(o=>o.def.id!==ag.def.id&&!o.busy);
      if(others.length>0){
        consultTarget=others[Math.floor(Math.random()*others.length)];
        const ts=SEATS[consultTarget.seatI];
        const adj=[{x:ts.tx+1,y:ts.ty},{x:ts.tx-1,y:ts.ty},{x:ts.tx,y:ts.ty+1},{x:ts.tx,y:ts.ty-1}]
          .filter(p=>p.x>0&&p.y>0&&p.x<COLS-1&&p.y<ROWS-1&&WALKABLE[p.y][p.x]);
        const dest=adj.length>0?adj[0]:{x:ts.tx,y:ts.ty};
        setTimeout(()=>{
          if(!ag||!consultTarget)return;
          walkTo(ag,dest.x,dest.y,()=>{
            if(!ag||!consultTarget)return;
            ag.state="talk";ag.dir=dirBetween(ag.tileX,ag.tileY,ts.tx,ts.ty);
            ag.bubble="Нужна твоя помощь...";ag.bubbleT=3;
            consultTarget.state="type";consultTarget.busy=true;consultTarget.bubble="Смотрю!";consultTarget.bubbleT=2;
            setTimeout(()=>{if(!ag)return;returnToSeat(ag,"type");consultDone=true;},3200);
          });
        },1200);
      }
    }

    try{
      const apiHistory=history
        .filter(m=>m.role==="user"||m.role==="model")
        .map(m=>({role:m.role as "user"|"model",text:m.text}));
      const res=await fetch("/api/agent",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({message:msg,agentId,history:apiHistory,githubToken})});
      const data=await res.json();
      const reply=(data.text as string)||"...";
      const acts:string[]|undefined=data.githubActions;
      const showReply=()=>{
        setChatHistories(p=>{
          const prev=p[agentId]||[];
          const msgs:ChatMsg[]=[...prev,{role:"model",text:reply,...(acts?{githubActions:acts}:{})}];
          return{...p,[agentId]:msgs};
        });
        if(ag){
          ag.bubble=reply.slice(0,60);ag.bubbleT=6;
          setTimeout(()=>{
            if(ag.tileX===SEATS[ag.seatI].tx&&ag.tileY===SEATS[ag.seatI].ty){
              ag.state="idle";ag.dir=SEATS[ag.seatI].dir;ag.busy=false;
            }else returnToSeat(ag,"idle");
            if(consultTarget&&!consultDone){consultTarget.state="idle";consultTarget.busy=false;}
          },5000);
        }
      };
      if(willConsult&&!consultDone)setTimeout(showReply,2200);else showReply();
    }catch{
      setChatHistories(p=>({...p,[agentId]:[...(p[agentId]||[]),{role:"model",text:"Ошибка соединения..."}]}));
      if(ag){ag.state="idle";ag.busy=false;}
      if(consultTarget){consultTarget.state="idle";consultTarget.busy=false;}
    }finally{
      sendingRef.current.delete(agentId);
      if(agentId===selectedId)setSending(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[githubToken,selectedId]);

  // Auto-resume unanswered tasks on mount
  useEffect(()=>{
    if(resumedRef.current)return;
    resumedRef.current=true;
    const toResume=Object.entries(chatHistories).filter(([,hist])=>{
      if(hist.length===0)return false;
      const last=hist[hist.length-1];
      return last.role==="user";
    });
    toResume.forEach(([agentId,hist],i)=>{
      const msg=hist[hist.length-1].text;
      const prevHistory=hist.slice(0,-1);
      setTimeout(()=>dispatchTask(agentId,msg,prevHistory),600+i*400);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  async function sendMessage(){
    if(!inputText.trim()||!selectedId||sending||sendingRef.current.has(selectedId))return;
    const msg=inputText.trim();setInputText("");setSending(true);
    const history=chatHistories[selectedId]||[];
    setChatHistories(p=>({...p,[selectedId!]:[...(p[selectedId!]||[]),{role:"user",text:msg}]}));
    await dispatchTask(selectedId,msg,history);
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
    setSelectedId(found?found.def.id:null);
  }

  function clearHistory(agentId:string){
    setChatHistories(p=>{const n={...p};delete n[agentId];return n;});
  }

  const selAgent=AGENTS.find(a=>a.id===selectedId);
  const chatHist=selectedId?chatHistories[selectedId]||[]:[];
  const hasGithub=!!githubToken;
  const totalMsgs=Object.values(chatHistories).reduce((s,h)=>s+h.length,0);

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#12120f",fontFamily:"'Courier New',monospace",color:"#e2e8f0",overflow:"hidden"}}>
      {/* Nav */}
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
          <span style={{fontSize:9,color:hasGithub?"#5a9a5a":"#7a6830"}}>
            {hasGithub?"GitHub подключён":"GitHub не настроен"}
          </span>
          <button onClick={()=>{setShowSettings(!showSettings);setTokenInput(githubToken);}}
            style={{background:showSettings?"#3a3010":"#2a2008",border:"1px solid #3a3010",borderRadius:4,
              padding:"2px 8px",color:"#D4A843",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>
            Настройки
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings&&(
        <div style={{background:"#1a1505",borderBottom:"2px solid #3a3010",padding:"10px 14px",display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:11,color:"#D4A843",minWidth:100}}>GitHub Token:</span>
          <input value={tokenInput} onChange={e=>setTokenInput(e.target.value)}
            placeholder="ghp_xxxxxxxxxxxx (classic token с repo scope)"
            type="password"
            style={{flex:1,minWidth:240,background:"#221a0a",border:"1px solid #5a4a10",borderRadius:4,
              padding:"4px 8px",color:"#d4c090",fontSize:11,outline:"none",fontFamily:"inherit"}}/>
          <button onClick={()=>{setGithubToken(tokenInput);setShowSettings(false);}}
            style={{background:"#3a7a3a",border:"none",borderRadius:4,padding:"4px 12px",
              color:"#fff",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Сохранить</button>
          {githubToken&&<button onClick={()=>{setGithubToken("");setTokenInput("");setShowSettings(false);}}
            style={{background:"#7a2a2a",border:"none",borderRadius:4,padding:"4px 10px",
              color:"#fff",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Отключить</button>}
          <span style={{fontSize:9,color:"#7a6830",maxWidth:300}}>
            Создай token на github.com/settings/tokens с правами: repo, workflow
          </span>
        </div>
      )}

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",padding:4}}>
          <canvas ref={canvasRef} width={W} height={H} onClick={handleCanvasClick}
            style={{maxWidth:"100%",maxHeight:"100%",imageRendering:"pixelated",cursor:"crosshair",
              border:"3px solid #3a3010",boxShadow:"0 0 20px rgba(0,0,0,0.5)"}}/>
        </div>

        {selAgent&&(
          <div style={{width:310,display:"flex",flexDirection:"column",background:"#1a1208",
            borderLeft:`3px solid ${selAgent.shirtColor}`,flexShrink:0}}>
            <div style={{padding:"8px 12px",borderBottom:`2px solid ${selAgent.shirtColor}44`,background:"#221a0a",display:"flex",alignItems:"center",gap:8}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:"bold",fontSize:13,color:selAgent.shirtColor}}>{selAgent.name}</div>
                <div style={{fontSize:9,color:"#7a6830"}}>{selAgent.role} Engineer</div>
              </div>
              {chatHist.length>0&&(
                <button onClick={()=>clearHistory(selAgent.id)}
                  title="Очистить историю"
                  style={{background:"#3a1a1a",border:"1px solid #5a2a2a",borderRadius:3,
                    padding:"2px 6px",color:"#f87171",fontSize:9,cursor:"pointer",fontFamily:"inherit"}}>очистить</button>
              )}
            </div>
            <div style={{flex:1,overflowY:"auto",padding:8,display:"flex",flexDirection:"column",gap:6}}>
              {chatHist.length===0&&(
                <div style={{color:"#4a3a10",fontSize:10,textAlign:"center",marginTop:40,lineHeight:1.6}}>
                  Дай задание {selAgent.name}<br/>
                  {hasGithub&&<span style={{color:"#3a6a3a"}}>GitHub подключён — он может создавать репо и файлы</span>}
                </div>
              )}
              {chatHist.map((m,i)=>(
                <div key={i}>
                  {m.role==="system"?(
                    <div style={{fontSize:9,color:"#5a8a5a",textAlign:"center",padding:"2px 6px",
                      background:"#0a1a0a",borderRadius:4,border:"1px solid #2a4a2a"}}>{m.text}</div>
                  ):(
                    <div style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                      <div style={{maxWidth:"88%"}}>
                        <div style={{padding:"5px 9px",borderRadius:6,fontSize:11,lineHeight:1.5,
                          background:m.role==="user"?"#3a2a05":"#221a0a",
                          border:m.role==="model"?`1px solid ${selAgent.shirtColor}55`:"1px solid #3a2a05",
                          color:m.role==="user"?"#f0d070":"#d4c090",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>
                          {m.text}
                        </div>
                        {m.githubActions&&m.githubActions.length>0&&(
                          <div style={{marginTop:3,padding:"3px 6px",background:"#0a1a0a",
                            border:"1px solid #2a5a2a",borderRadius:4,fontSize:9,color:"#5aaa5a"}}>
                            {m.githubActions.map((a,j)=>(
                              <div key={j} style={{marginBottom:1}}>⚡ {a.slice(0,80)}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{padding:8,borderTop:`2px solid ${selAgent.shirtColor}44`,display:"flex",gap:6}}>
              <input value={inputText} onChange={e=>setInputText(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendMessage()}
                placeholder={hasGithub?`Задание для ${selAgent.name} (можно попросить создать репо)…`:`Задание для ${selAgent.name}…`}
                disabled={sending}
                style={{flex:1,background:"#221a0a",border:`1px solid ${selAgent.shirtColor}55`,borderRadius:5,
                  padding:"5px 9px",color:"#d4c090",fontSize:11,outline:"none",fontFamily:"inherit"}}/>
              <button onClick={sendMessage} disabled={sending||!inputText.trim()}
                style={{background:selAgent.shirtColor,border:"none",borderRadius:5,padding:"5px 11px",
                  color:"#1a1208",fontWeight:"bold",fontSize:12,cursor:sending?"wait":"pointer",
                  opacity:sending||!inputText.trim()?0.5:1,fontFamily:"inherit"}}>
                {sending?"…":"→"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
