"use client";
import { useEffect, useRef, useState } from "react";
import { AGENTS, AgentDef } from "@/lib/agents";

// ── Constants ─────────────────────────────────────────────────────────────────
const TILE  = 16;          // sprite-space tile px
const SCALE = 3;           // render upscale
const RT    = TILE * SCALE; // 48 screen-px per tile
const COLS  = 20;
const ROWS  = 11;
const W     = COLS * RT;   // 960
const H     = ROWS * RT;   // 528
const WALK_SPD = 48;       // sprite-px / sec

type Dir    = 0 | 1 | 2 | 3;
const DOWN = 0, LEFT = 1, RIGHT = 2, UP = 3;
type AState = "idle" | "walk" | "type";

// Character sprite: 16×32 per frame, 6 cols × 4 rows
// Rows: down, left, right, up  |  Cols 0-3: walk, 4-5: type
const CHAR_W = 16, CHAR_H = 32;
const SPRITE_URLS = [0,1,2,3,4,5].map(
  i => `https://raw.githubusercontent.com/pablodelucca/pixel-agents/main/webview-ui/public/assets/characters/char_${i}.png`
);

// ── Office layout ─────────────────────────────────────────────────────────────
const SEATS = [
  {tx:2,ty:3,dir:UP as Dir},{tx:5,ty:3,dir:UP as Dir},{tx:8,ty:3,dir:UP as Dir},{tx:11,ty:3,dir:UP as Dir},{tx:14,ty:3,dir:UP as Dir},
  {tx:2,ty:7,dir:DOWN as Dir},{tx:5,ty:7,dir:DOWN as Dir},{tx:8,ty:7,dir:DOWN as Dir},{tx:11,ty:7,dir:DOWN as Dir},{tx:14,ty:7,dir:DOWN as Dir},
];
const DESK_OBS = [
  {tx:2,ty:2},{tx:5,ty:2},{tx:8,ty:2},{tx:11,ty:2},{tx:14,ty:2},
  {tx:2,ty:8},{tx:5,ty:8},{tx:8,ty:8},{tx:11,ty:8},{tx:14,ty:8},
];

const WALKABLE: boolean[][] = Array.from({length:ROWS}, (_,r) =>
  Array.from({length:COLS}, (_,c) => r>0 && r<ROWS-1 && c>0 && c<COLS-1)
);
for (const {tx,ty} of DESK_OBS) WALKABLE[ty][tx] = false;

function bfs(
  fx: number, fy: number,
  tx: number, ty: number
): {x:number,y:number}[] {
  if (fx===tx && fy===ty) return [];
  type N = {x:number,y:number,prev:N|null};
  const vis = new Uint8Array(ROWS*COLS);
  const q: N[] = [{x:fx,y:fy,prev:null}];
  vis[fy*COLS+fx] = 1;
  while (q.length) {
    const cur = q.shift()!;
    for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]] as [number,number][]) {
      const nx=cur.x+dx, ny=cur.y+dy;
      if (nx<0||ny<0||nx>=COLS||ny>=ROWS) continue;
      if (!WALKABLE[ny][nx]||vis[ny*COLS+nx]) continue;
      vis[ny*COLS+nx]=1;
      const node:N={x:nx,y:ny,prev:cur};
      if (nx===tx&&ny===ty) {
        const path:{x:number,y:number}[]=[];
        let n:N|null=node;
        while(n){path.unshift({x:n.x,y:n.y});n=n.prev;}
        path.shift();
        return path;
      }
      q.push(node);
    }
  }
  return [];
}

function dirBetween(ax:number,ay:number,bx:number,by:number): Dir {
  const dx=bx-ax,dy=by-ay;
  if (Math.abs(dx)>=Math.abs(dy)) return dx>0?RIGHT:LEFT;
  return dy>0?DOWN:UP;
}

// ── Agent runtime ─────────────────────────────────────────────────────────────
interface AgentRT {
  def: AgentDef;
  si: number;
  ax: number;
  ay: number;
  tileX: number;
  tileY: number;
  path: {x:number,y:number}[];
  state: AState;
  dir: Dir;
  animT: number;
  animF: number;
  seatI: number;
  bubble: string|null;
  bubbleT: number;
  actionT: number;
  returning: boolean;
}

const AUTO_MSGS = ["Hey! Got a sec?","Quick question!","Check this PR!","Found a bug","Code review?","Deploy ready?","Need your input","Nice work!","Stand-up?","LGTM!"];
const AUTO_RESP = ["Sure!","On it!","Looks good!","Interesting…","Let me check","Approved!","Almost done!","Let's discuss","Cool!","Will do!"];

// ── Draw helpers ─────────────────────────────────────────────────────────────
function rr(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number) {
  ctx.beginPath();
  ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function drawScene(ctx:CanvasRenderingContext2D, agents:AgentRT[], sprites:(HTMLImageElement|null)[], fc:number) {
  ctx.fillStyle="#0a0a1a";
  ctx.fillRect(0,0,W,H);

  ctx.fillStyle="#1a0a3e";
  ctx.fillRect(0,0,W,RT);
  ctx.fillRect(0,H-RT,W,RT);
  ctx.fillRect(0,0,RT,H);
  ctx.fillRect(W-RT,0,RT,H);

  const winPositions=[3,7,11,15];
  for (const wc of winPositions) {
    const wx=wc*RT, wy=4;
    ctx.fillStyle="#0d1b4e";
    ctx.fillRect(wx,wy,RT*2,RT-8);
    ctx.strokeStyle="#3a2a7e";
    ctx.lineWidth=2;
    ctx.strokeRect(wx,wy,RT*2,RT-8);
    ctx.beginPath();ctx.moveTo(wx+RT,wy);ctx.lineTo(wx+RT,wy+RT-8);ctx.stroke();
    ctx.beginPath();ctx.moveTo(wx,wy+(RT-8)/2);ctx.lineTo(wx+RT*2,wy+(RT-8)/2);ctx.stroke();
    ctx.fillStyle="#ffffff";
    const stars=[[8,8],[20,15],[30,5],[42,18],[55,10],[15,28],[38,30],[60,22]];
    ctx.globalAlpha=0.7;
    for (const [sx,sy] of stars) ctx.fillRect(wx+sx,wy+sy,1,1);
    ctx.globalAlpha=1;
    ctx.fillStyle="#fffde7";
    ctx.beginPath();ctx.arc(wx+RT*2-10,wy+10,6,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="#0d1b4e";
    ctx.beginPath();ctx.arc(wx+RT*2-8,wy+8,5,0,Math.PI*2);ctx.fill();
  }

  for (let r=1;r<ROWS-1;r++) {
    for (let c=1;c<COLS-1;c++) {
      ctx.fillStyle=(c+r)%2===0?"#16213e":"#1a1a2e";
      ctx.fillRect(c*RT,r*RT,RT,RT);
    }
  }

  ctx.strokeStyle="#0a1020";
  ctx.lineWidth=0.5;
  for (let r=1;r<=ROWS-1;r++){ctx.beginPath();ctx.moveTo(RT,r*RT);ctx.lineTo(W-RT,r*RT);ctx.stroke();}
  for (let c=1;c<=COLS-1;c++){ctx.beginPath();ctx.moveTo(c*RT,RT);ctx.lineTo(c*RT,H-RT);ctx.stroke();}

  for (let i=0;i<10;i++) {
    const seat=SEATS[i];
    const isTop=i<5;
    const deskTy=isTop?seat.ty-1:seat.ty+1;
    const dsx=seat.tx*RT-RT;
    const dsy=deskTy*RT;

    ctx.fillStyle="#2a1f3d";
    ctx.fillRect(dsx,dsy,RT*3,RT);
    ctx.strokeStyle="#4a3f6d";
    ctx.lineWidth=1;
    ctx.strokeRect(dsx,dsy,RT*3,RT);

    const mx=seat.tx*RT+4;
    const my=dsy+4;
    const mw=RT-8, mh=RT-10;
    rr(ctx,mx,my,mw,mh,3);
    ctx.fillStyle="#111827";ctx.fill();
    ctx.strokeStyle="#374151";ctx.lineWidth=1;ctx.stroke();

    ctx.fillStyle="#0d1117";
    ctx.fillRect(mx+3,my+3,mw-6,mh-8);

    const lc=["#22c55e","#60a5fa","#f9a8d4","#fbbf24"];
    for (let li=0;li<4;li++) {
      const lw=6+(fc*0.3+i*11+li*7)%14|0;
      ctx.globalAlpha=0.65+0.35*Math.sin(fc*0.05+li*0.9+i*0.4);
      ctx.fillStyle=lc[li%4];
      ctx.fillRect(mx+5,my+5+li*6,lw,2);
    }
    ctx.globalAlpha=1;

    if (Math.floor(fc/25)%2===0){
      ctx.fillStyle="#fff";
      ctx.fillRect(mx+5,my+mh-10,2,3);
    }

    ctx.fillStyle="#1f2937";
    ctx.fillRect(dsx+RT/2,dsy+RT*0.65,RT*2,RT*0.25);
    ctx.strokeStyle="#374151";ctx.lineWidth=0.5;
    ctx.strokeRect(dsx+RT/2,dsy+RT*0.65,RT*2,RT*0.25);
    for (let ki=0;ki<6;ki++){
      for (let kj=0;kj<3;kj++){
        ctx.fillStyle="#111827";
        ctx.fillRect(dsx+RT/2+4+ki*RT*0.3,dsy+RT*0.68+kj*RT*0.07,RT*0.22,RT*0.05);
      }
    }

    const ag=agents[i];
    if (ag) {
      ctx.font="bold 9px monospace";
      const label=ag.def.name+` (${ag.def.role})`;
      const tw=ctx.measureText(label).width;
      const bx2=seat.tx*RT+RT/2-tw/2-4;
      const by2=isTop?seat.ty*RT+RT+2:seat.ty*RT-16;
      rr(ctx,bx2,by2,tw+8,13,2);
      ctx.fillStyle="#0f0f1f";ctx.fill();
      ctx.strokeStyle=ag.def.shirtColor;ctx.lineWidth=1;ctx.stroke();
      ctx.fillStyle=ag.def.shirtColor;
      ctx.fillText(label,bx2+4,by2+10);
    }
  }

  for (const [cx,cy] of [[1,1],[COLS-2,1],[1,ROWS-2],[COLS-2,ROWS-2]] as [number,number][]) {
    const px=cx*RT+RT/2, py=cy*RT+RT-4;
    ctx.fillStyle="#7c2d12";
    rr(ctx,px-10,py-12,20,12,2);ctx.fill();
    ctx.strokeStyle="#9a3412";ctx.lineWidth=1;ctx.stroke();
    ctx.fillStyle="#15803d";
    ctx.fillRect(px-2,py-28,4,16);
    ctx.fillStyle="#16a34a";
    ctx.beginPath();ctx.ellipse(px-12,py-26,10,5,Math.PI*0.3,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.ellipse(px+12,py-26,10,5,-Math.PI*0.3,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.ellipse(px,py-34,8,14,0,0,Math.PI*2);ctx.fill();
  }

  const sorted=[...agents].sort((a,b)=>a.ay-b.ay);
  for (const ag of sorted) {
    const sx=Math.round(ag.ax*SCALE);
    const sy=Math.round(ag.ay*SCALE);
    drawChar(ctx,sprites,ag,sx,sy);
  }

  for (const ag of agents) {
    if (ag.bubble) {
      const sx=Math.round(ag.ax*SCALE);
      const sy=Math.round(ag.ay*SCALE);
      drawBubble(ctx,ag,ag.bubble,sx,sy);
    }
  }
}

function drawChar(
  ctx:CanvasRenderingContext2D,
  sprites:(HTMLImageElement|null)[],
  ag:AgentRT,
  sx:number,sy:number
) {
  const sprite=sprites[ag.si];
  if (sprite&&sprite.complete&&sprite.naturalWidth>0) {
    let col:number;
    const row=ag.dir;
    if (ag.state==="type") col=4+ag.animF%2;
    else if (ag.state==="walk") col=ag.animF%4;
    else col=0;
    ctx.drawImage(sprite,col*CHAR_W,row*CHAR_H,CHAR_W,CHAR_H,
      sx-CHAR_W*SCALE/2,sy-CHAR_H*SCALE,CHAR_W*SCALE,CHAR_H*SCALE);
  } else {
    drawFallback(ctx,ag,sx,sy);
  }
}

function drawFallback(ctx:CanvasRenderingContext2D,ag:AgentRT,sx:number,sy:number) {
  const S=SCALE,{def,state,animF}=ag;
  const px=sx-8*S,py=sy-32*S;
  const lOff=state==="walk"?Math.sin(animF*1.5)*2*S:0;
  ctx.fillStyle="#1e293b";
  ctx.fillRect(px+4*S,py+26*S+lOff,3*S,5*S);
  ctx.fillRect(px+9*S,py+26*S-lOff,3*S,5*S);
  ctx.fillStyle="#111";
  ctx.fillRect(px+3*S,py+31*S+lOff,5*S,2*S);
  ctx.fillRect(px+8*S,py+31*S-lOff,5*S,2*S);
  ctx.fillStyle=def.shirtColor;
  ctx.fillRect(px+2*S,py+14*S,12*S,12*S);
  const aOff=state==="walk"?Math.sin(animF*1.5)*2*S:state==="type"?Math.sin(animF*3)*S:0;
  ctx.fillStyle=def.shirtColor;
  ctx.fillRect(px,py+15*S+aOff,2*S,8*S);
  ctx.fillRect(px+14*S,py+15*S-aOff,2*S,8*S);
  ctx.fillStyle="#d4a574";
  ctx.fillRect(px+4*S,py+5*S,8*S,10*S);
  ctx.fillStyle=def.hairColor;
  ctx.fillRect(px+4*S,py+5*S,8*S,3*S);
  ctx.fillRect(px+4*S,py+8*S,2*S,2*S);
  ctx.fillRect(px+10*S,py+8*S,2*S,2*S);
  ctx.fillStyle="#fff";
  ctx.fillRect(px+5*S,py+9*S,2*S,2*S);
  ctx.fillRect(px+9*S,py+9*S,2*S,2*S);
  ctx.fillStyle="#000";
  ctx.fillRect(px+6*S,py+10*S,1*S,1*S);
  ctx.fillRect(px+10*S,py+10*S,1*S,1*S);
  ctx.fillStyle="#7f1d1d";
  ctx.fillRect(px+6*S,py+12*S,4*S,state==="idle"?2*S:1*S);
}

function drawBubble(ctx:CanvasRenderingContext2D,ag:AgentRT,text:string,sx:number,sy:number) {
  const pad=6,lh=12,maxW=130;
  ctx.font="bold 9px monospace";
  const words=text.split(" ");
  const lines:string[]=[];
  let cur="";
  for (const w of words) {
    const t=cur?`${cur} ${w}`:w;
    if (ctx.measureText(t).width>maxW-pad*2){if(cur)lines.push(cur);cur=w;}
    else cur=t;
    if (lines.length>=3)break;
  }
  if (cur&&lines.length<3)lines.push(cur);
  const bw=Math.max(...lines.map(l=>ctx.measureText(l).width))+pad*2;
  const bh=lines.length*lh+pad*2;
  const bx=Math.max(2,Math.min(W-bw-2,sx-bw/2));
  const charTop=sy-CHAR_H*SCALE;
  const by=Math.max(2,charTop-bh-8);
  rr(ctx,bx,by,bw,bh,4);
  ctx.fillStyle="#0f0f1f";ctx.fill();
  ctx.strokeStyle=ag.def.shirtColor;ctx.lineWidth=2;ctx.stroke();
  const tx=Math.max(bx+8,Math.min(bx+bw-8,sx));
  ctx.fillStyle="#0f0f1f";
  ctx.beginPath();ctx.moveTo(tx-4,by+bh);ctx.lineTo(tx+4,by+bh);ctx.lineTo(tx,charTop-2);ctx.closePath();ctx.fill();
  ctx.strokeStyle=ag.def.shirtColor;ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(tx-4,by+bh);ctx.lineTo(tx,charTop-2);ctx.stroke();
  ctx.beginPath();ctx.moveTo(tx+4,by+bh);ctx.lineTo(tx,charTop-2);ctx.stroke();
  ctx.fillStyle="#e2e8f0";
  for (let i=0;i<lines.length;i++) ctx.fillText(lines[i],bx+pad,by+pad+9+i*lh);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Home() {
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const agentsRef=useRef<AgentRT[]>([]);
  const spritesRef=useRef<(HTMLImageElement|null)[]>([]);
  const rafRef=useRef<number>(0);
  const lastTRef=useRef<number>(0);

  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [chatHistories,setChatHistories]=useState<Record<string,{role:"user"|"model";text:string}[]>>({});
  const [inputText,setInputText]=useState("");
  const [sending,setSending]=useState(false);

  useEffect(()=>{
    spritesRef.current=SPRITE_URLS.map(()=>null);
    SPRITE_URLS.forEach((url,i)=>{
      const img=new Image();
      img.crossOrigin="anonymous";
      img.onload=()=>{spritesRef.current[i]=img;};
      img.onerror=()=>{spritesRef.current[i]=null;};
      img.src=url;
    });
  },[]);

  useEffect(()=>{
    agentsRef.current=AGENTS.map((def,i)=>{
      const seat=SEATS[i];
      const ax=seat.tx*TILE+TILE/2, ay=seat.ty*TILE+TILE/2;
      return {
        def,si:i%6,ax,ay,
        tileX:seat.tx,tileY:seat.ty,
        path:[],
        state:"type" as AState,
        dir:seat.dir,
        animT:0,animF:0,
        seatI:i,
        bubble:null,bubbleT:0,
        actionT:5+Math.random()*15,
        returning:false,
      };
    });
  },[]);

  useEffect(()=>{
    const canvas=canvasRef.current;
    if (!canvas) return;
    const ctx=canvas.getContext("2d");
    if (!ctx) return;

    let fc=0;

    function updateAgent(ag:AgentRT,dt:number) {
      ag.animT+=dt;
      const fps=ag.state==="walk"?8:ag.state==="type"?3:1;
      const frames=ag.state==="walk"?4:ag.state==="type"?2:1;
      if (ag.animT>=1/fps){ag.animT=0;ag.animF=(ag.animF+1)%frames;}

      if (ag.bubbleT>0){ag.bubbleT-=dt;if(ag.bubbleT<=0)ag.bubble=null;}

      if (ag.path.length>0) {
        const next=ag.path[0];
        const nax=next.x*TILE+TILE/2, nay=next.y*TILE+TILE/2;
        const dx=nax-ag.ax,dy=nay-ag.ay;
        const dist=Math.sqrt(dx*dx+dy*dy);
        const step=WALK_SPD*dt;
        ag.dir=dirBetween(ag.ax,ag.ay,nax,nay);
        if (dist<=step+0.01) {
          ag.ax=nax;ag.ay=nay;
          ag.tileX=next.x;ag.tileY=next.y;
          ag.path.shift();
          if (ag.path.length===0) {
            if (ag.returning) {
              ag.returning=false;
              ag.state="type";
              ag.dir=SEATS[ag.seatI].dir;
              ag.animF=0;
              ag.actionT=10+Math.random()*20;
            } else {
              ag.state="idle";
              ag.animF=0;
            }
          }
        } else {
          ag.ax+=dx/dist*step;
          ag.ay+=dy/dist*step;
        }
        return;
      }

      if (ag.state==="idle") {
        ag.actionT-=dt;
        if (ag.actionT<=0) {
          const seat=SEATS[ag.seatI];
          const path=bfs(ag.tileX,ag.tileY,seat.tx,seat.ty);
          if (path.length>0){ag.path=path;ag.state="walk";ag.returning=true;}
          else {
            ag.state="type";
            ag.dir=seat.dir;
            ag.actionT=10+Math.random()*20;
          }
        }
        return;
      }

      if (ag.state==="type") {
        ag.actionT-=dt;
        if (ag.actionT<=0) {
          if (Math.random()<0.4) {
            const candidates:{x:number,y:number}[]=[];
            for (let dy=-5;dy<=5;dy++) for (let dx=-5;dx<=5;dx++) {
              const nx=ag.tileX+dx,ny=ag.tileY+dy;
              if (nx>0&&ny>0&&nx<COLS-1&&ny<ROWS-1&&WALKABLE[ny][nx])
                candidates.push({x:nx,y:ny});
            }
            if (candidates.length>0) {
              const tgt=candidates[Math.floor(Math.random()*candidates.length)];
              const path=bfs(ag.tileX,ag.tileY,tgt.x,tgt.y);
              if (path.length>0){
                ag.path=path;ag.state="walk";ag.returning=false;
                ag.actionT=3+Math.random()*5;
              } else ag.actionT=5+Math.random()*10;
            } else ag.actionT=5+Math.random()*10;
          } else {
            const others=agentsRef.current.filter(o=>o.def.id!==ag.def.id&&o.state==="type");
            if (others.length>0) {
              const target=others[Math.floor(Math.random()*others.length)];
              const ts=SEATS[target.seatI];
              const adjOptions=[
                {x:ts.tx+1,y:ts.ty},{x:ts.tx-1,y:ts.ty},
                {x:ts.tx,y:ts.ty+1},{x:ts.tx,y:ts.ty-1},
              ].filter(p=>p.x>0&&p.y>0&&p.x<COLS-1&&p.y<ROWS-1&&WALKABLE[p.y][p.x]);
              const dest=adjOptions.length>0?adjOptions[0]:{x:ts.tx,y:ts.ty};
              const path=bfs(ag.tileX,ag.tileY,dest.x,dest.y);
              if (path.length>0) {
                ag.path=path;ag.state="walk";ag.returning=false;
                const msg=AUTO_MSGS[Math.floor(Math.random()*AUTO_MSGS.length)];
                const resp=AUTO_RESP[Math.floor(Math.random()*AUTO_RESP.length)];
                setTimeout(()=>{
                  if (ag.state==="idle"||ag.path.length===0) {
                    ag.bubble=msg;ag.bubbleT=3;ag.dir=dirBetween(ag.tileX,ag.tileY,ts.tx,ts.ty);
                    setTimeout(()=>{
                      target.bubble=resp;target.bubbleT=2.5;
                      setTimeout(()=>{
                        const seat=SEATS[ag.seatI];
                        const back=bfs(ag.tileX,ag.tileY,seat.tx,seat.ty);
                        if (back.length>0){ag.path=back;ag.state="walk";ag.returning=true;}
                        else {ag.state="type";ag.dir=seat.dir;ag.actionT=10+Math.random()*20;}
                      },2500);
                    },2000);
                  }
                },Math.max(500,(path.length*TILE/WALK_SPD*1000)+200));
              } else ag.actionT=5+Math.random()*10;
            } else ag.actionT=5+Math.random()*10;
          }
        }
      }
    }

    function loop(ts:number) {
      const dt=Math.min((ts-lastTRef.current)/1000,0.1);
      lastTRef.current=ts;
      fc++;
      for (const ag of agentsRef.current) updateAgent(ag,dt);
      ctx.clearRect(0,0,W,H);
      drawScene(ctx,agentsRef.current,spritesRef.current,fc);
      rafRef.current=requestAnimationFrame(loop);
    }

    rafRef.current=requestAnimationFrame(loop);
    return ()=>cancelAnimationFrame(rafRef.current);
  },[]);

  function handleCanvasClick(e:React.MouseEvent<HTMLCanvasElement>) {
    const canvas=canvasRef.current;
    if (!canvas) return;
    const rect=canvas.getBoundingClientRect();
    const mx=(e.clientX-rect.left)*(W/rect.width);
    const my=(e.clientY-rect.top)*(H/rect.height);
    let found:AgentRT|null=null;
    for (const ag of agentsRef.current) {
      const sx=ag.ax*SCALE, sy=ag.ay*SCALE;
      if (mx>=sx-CHAR_W*SCALE/2&&mx<=sx+CHAR_W*SCALE/2&&my>=sy-CHAR_H*SCALE&&my<=sy)
        {found=ag;break;}
    }
    setSelectedId(found?found.def.id:null);
  }

  async function sendMessage() {
    if (!inputText.trim()||!selectedId||sending) return;
    const msg=inputText.trim();
    setInputText("");setSending(true);
    const history=chatHistories[selectedId]||[];
    const newH=[...history,{role:"user" as const,text:msg}];
    setChatHistories(p=>({...p,[selectedId!]:newH}));
    try {
      const res=await fetch("/api/agent",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({message:msg,agentId:selectedId,history})});
      const data=await res.json();
      const reply=(data.text as string)||"...";
      setChatHistories(p=>({...p,[selectedId!]:[...(p[selectedId!]||[]),{role:"model" as const,text:reply}]}));
      const ag=agentsRef.current.find(a=>a.def.id===selectedId);
      if (ag){ag.bubble=reply.slice(0,60);ag.bubbleT=5;ag.dir=SEATS[ag.seatI].dir;}
    } catch {
      setChatHistories(p=>({...p,[selectedId!]:[...(p[selectedId!]||[]),{role:"model" as const,text:"Connection error…"}]}));
    } finally {setSending(false);}
  }

  const selAgent=AGENTS.find(a=>a.id===selectedId);
  const chatHist=selectedId?chatHistories[selectedId]||[]:[];

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#07071a",fontFamily:"monospace",color:"#e2e8f0",overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"6px 14px",background:"#0f0f2e",borderBottom:"2px solid #1e1e4e",flexShrink:0}}>
        <span style={{fontSize:15,fontWeight:"bold",letterSpacing:1}}>⬛ Gemini Dev Studio</span>
        <div style={{display:"flex",gap:5,marginLeft:8,flexWrap:"wrap"}}>
          {AGENTS.map(a=>(
            <div key={a.id} title={`${a.name} (${a.role})`}
              style={{width:9,height:9,borderRadius:"50%",background:a.shirtColor,
                border:selectedId===a.id?"2px solid #fff":"2px solid transparent",cursor:"pointer"}}
              onClick={()=>setSelectedId(selectedId===a.id?null:a.id)}/>
          ))}
        </div>
        <span style={{marginLeft:"auto",fontSize:10,color:"#64748b"}}>Click an agent to chat • agents auto-interact</span>
      </div>

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",padding:6}}>
          <canvas ref={canvasRef} width={W} height={H} onClick={handleCanvasClick}
            style={{maxWidth:"100%",maxHeight:"100%",imageRendering:"pixelated",cursor:"crosshair",border:"2px solid #1e1e4e"}}/>
        </div>

        {selAgent&&(
          <div style={{width:300,display:"flex",flexDirection:"column",background:"#0c0c24",borderLeft:`3px solid ${selAgent.shirtColor}`,flexShrink:0}}>
            <div style={{padding:"10px 14px",borderBottom:`2px solid ${selAgent.shirtColor}33`,background:"#0f0f2e"}}>
              <div style={{fontWeight:"bold",fontSize:13,color:selAgent.shirtColor}}>{selAgent.name}</div>
              <div style={{fontSize:10,color:"#64748b"}}>{selAgent.role} Engineer</div>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:10,display:"flex",flexDirection:"column",gap:7}}>
              {chatHist.length===0&&(
                <div style={{color:"#334155",fontSize:10,textAlign:"center",marginTop:30}}>
                  Start a conversation with {selAgent.name}
                </div>
              )}
              {chatHist.map((m,i)=>(
                <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                  <div style={{maxWidth:"82%",padding:"5px 9px",borderRadius:7,fontSize:11,lineHeight:1.45,
                    background:m.role==="user"?"#1e3a5f":"#0f0f2e",
                    border:m.role==="model"?`1px solid ${selAgent.shirtColor}44`:"none",
                    color:m.role==="user"?"#bfdbfe":"#e2e8f0"}}>
                    {m.text}
                  </div>
                </div>
              ))}
            </div>
            <div style={{padding:10,borderTop:`2px solid ${selAgent.shirtColor}33`,display:"flex",gap:7}}>
              <input value={inputText} onChange={e=>setInputText(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&sendMessage()}
                placeholder="Type a message…" disabled={sending}
                style={{flex:1,background:"#0f0f2e",border:`1px solid ${selAgent.shirtColor}44`,borderRadius:5,
                  padding:"5px 9px",color:"#e2e8f0",fontSize:11,outline:"none"}}/>
              <button onClick={sendMessage} disabled={sending||!inputText.trim()}
                style={{background:selAgent.shirtColor,border:"none",borderRadius:5,padding:"5px 10px",
                  color:"#000",fontWeight:"bold",fontSize:11,cursor:sending?"wait":"pointer",
                  opacity:sending||!inputText.trim()?0.5:1}}>
                {sending?"…":"Send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}