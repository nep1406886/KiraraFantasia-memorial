// Authored terrain under original scenery: one opaque texture and one draw call.
// Seeded detail is generated only on room load; mapview owns every resource.
import { roomSize } from '../dungeon.js';
import { createRandom, hash32 } from '../random.js';

const P = 48;
const PALETTES = {
    1: { joint:'#d8c8bf', stone:['#f2e6da','#e9d9cc','#f6eae1'], foliage:'#aaada0', petal:'#e9adb9' },
    2: { joint:'#c1a784', stone:['#e8d5b4','#efddc2','#e4cda9'], foliage:'#a6a273', petal:'#f3d0a3' },
    3: { joint:'#a9a28b', stone:['#d7d4b4','#e2dfc5','#ccd1af'], foliage:'#5e884e', petal:'#eec9d6' },
    4: { joint:'#9e7d6b', stone:['#cdb59c','#dec6ab','#c6aa8c'], foliage:'#9b9479', petal:'#e4bd9c' },
    5: { joint:'#74738b', stone:['#a9a3b9','#bcb4c8','#9b98b0'], foliage:'#637b74', petal:'#d9c4e5' }
};
function canvas(size) {
    const c=document.createElement('canvas');c.width=size.w*P;c.height=size.h*P;return c;
}
function rect(ctx,x,y,w,h,r) {ctx.beginPath();ctx.roundRect(x,y,w,h,r);}
function patch(ctx,x,y,rx,ry,color,rng) {
    ctx.fillStyle=color;ctx.beginPath();
    for(let i=0;i<=24;i++) {
        const a=i/24*Math.PI*2,r=.88+rng()*.12;
        const px=x+Math.cos(a)*rx*r,py=y+Math.sin(a)*ry*r;
        if(!i)ctx.moveTo(px,py);else ctx.lineTo(px,py);
    }
    ctx.closePath();ctx.fill();
}
function road(ctx,path) {
    const pts=path.points||[{x:path.x1,y:path.y1},{x:path.x2,y:path.y2}];
    ctx.beginPath();ctx.moveTo(pts[0].x*P,pts[0].y*P);
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x*P,pts[i].y*P);
    ctx.lineWidth=path.width*P;ctx.stroke();
}
export function createRoomSurface(THREE,cfg,layout,room,volume) {
    const size=roomSize(room),c=canvas(size),ctx=c.getContext('2d');
    const colors=PALETTES[volume]||PALETTES[1],rng=createRandom(hash32('garden:'+room.seed+':'+cfg.biome));
    ctx.fillStyle=cfg.ground.base;ctx.fillRect(0,0,c.width,c.height);
    for(let i=0;i<80;i++) {
        const x=rng()*c.width,y=rng()*c.height,r=(1.5+rng()*3)*P;
        const wash=ctx.createRadialGradient(x,y,0,x,y,r);
        wash.addColorStop(0,(i%3?cfg.ground.mottle:'#fff3e3')+'38');
        wash.addColorStop(1,cfg.ground.base+'00');ctx.fillStyle=wash;ctx.fillRect(x-r,y-r,r*2,r*2);
    }
    for(let i=0;i<size.w*size.h*7;i++) {
        const x=rng()*c.width,y=rng()*c.height;
        ctx.strokeStyle=i%4?colors.foliage+'25':'#fff8e840';ctx.lineWidth=.6+rng();
        ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+2,y-2,x+4+rng()*6,y-1);ctx.stroke();
    }
    for(const bed of layout.beds) {
        const x=bed.x*P,y=bed.y*P;
        const wash=ctx.createRadialGradient(x,y,bed.radius*P*.2,x,y,bed.radius*P*1.2);
        wash.addColorStop(0,colors.foliage+'80');wash.addColorStop(1,colors.foliage+'00');
        ctx.fillStyle=wash;ctx.fillRect(x-bed.radius*P*1.2,y-bed.radius*P*1.2,bed.radius*P*2.4,bed.radius*P*2.4);
        patch(ctx,x,y,bed.radius*P*.85,bed.radius*P*.68,colors.foliage+'38',rng);
        // Irregular stones settle the original scenery into a planted bed.
        for(let i=0;i<18;i++) {
            const a=i/18*Math.PI*2,r=bed.radius*P*(.79+rng()*.08);
            const px=x+Math.cos(a)*r,py=y+Math.sin(a)*r*.78;
            ctx.fillStyle=colors.joint+'70';ctx.beginPath();ctx.ellipse(px+1,py+2,6,3,a,0,Math.PI*2);ctx.fill();
            ctx.fillStyle=colors.stone[i%3]+'b0';ctx.beginPath();ctx.ellipse(px,py,4+rng()*3,2+rng()*2,a,0,Math.PI*2);ctx.fill();
        }
        for(let i=0;i<85;i++) {
            const a=rng()*Math.PI*2,r=Math.sqrt(rng())*bed.radius*P*1.15;
            const px=x+Math.cos(a)*r,py=y+Math.sin(a)*r*.78;
            ctx.fillStyle=i%4?colors.foliage+'55':colors.petal+'a0';
            ctx.beginPath();ctx.ellipse(px,py,2+rng()*4,1+rng()*2,a,0,Math.PI*2);ctx.fill();
        }
    }
    const wild=room.type==='battle'||room.type==='chest';
    const mask=canvas(size),m=mask.getContext('2d');
    m.fillStyle=m.strokeStyle='#fff';m.lineCap=m.lineJoin='round';layout.paths.forEach(path=>road(m,path));
    const plaza=layout.plaza||{...layout.center,hw:3.3,hh:2.7};
    if(!wild) {rect(m,(plaza.x-plaza.hw)*P,(plaza.y-plaza.hh)*P,plaza.hw*P*2,plaza.hh*P*2,P*1.2);m.fill();}
    for(const area of [layout.court,layout.camp?.area].filter(Boolean)) {
        rect(m,(area.x-area.hw)*P,(area.y-area.hh)*P,area.hw*P*2,area.hh*P*2,P*.8);m.fill();
    }
    // Curb and inset paving share a union mask: no seams at road junctions.
    if(!wild) {ctx.save();ctx.shadowColor=colors.joint+'68';ctx.shadowBlur=10;ctx.drawImage(mask,0,0);ctx.restore();}
    const paving=canvas(size),t=paving.getContext('2d');t.fillStyle=colors.joint;t.fillRect(0,0,c.width,c.height);
    const tw=P*(volume===4?1.2:.48),th=P*(volume===4?.2:.35);
    for(let row=-1;row<c.height/th+1;row++)for(let col=-1;col<c.width/tw+1;col++) {
        const x=(col+(row%2?.5:0))*tw,y=row*th,gap=.65;
        t.fillStyle=colors.stone[Math.floor(rng()*colors.stone.length)];
        rect(t,x+gap,y+gap,tw-gap*2,th-gap*2,volume===4?1:2+rng()*2);t.fill();
        t.strokeStyle='#ffffff35';t.lineWidth=1;t.beginPath();t.moveTo(x+7,y+4);t.lineTo(x+tw-8,y+4);t.stroke();
        if(rng()<.18) {
            t.strokeStyle=colors.joint+'45';t.beginPath();t.moveTo(x+tw*.6,y+2);
            t.lineTo(x+tw*.48,y+th*.3);t.lineTo(x+tw*.5,y+th*.6);t.stroke();
        }
    }
    // Quiet rectangular mosaics, distinct from saturated combat telegraphs.
    const x=(plaza.x-plaza.hw+.45)*P,y=(plaza.y-plaza.hh+.45)*P,w=(plaza.hw-.45)*2*P,h=(plaza.hh-.45)*2*P;
    if(!wild) {
        t.fillStyle=colors.stone[0]+'a0';rect(t,x,y,w,h,P*.8);t.fill();
        t.strokeStyle=colors.joint+'88';t.lineWidth=2;rect(t,x+5,y+5,w-10,h-10,P*.7);t.stroke();
        for(const [cx,cy] of [[x+20,y+20],[x+w-20,y+20],[x+20,y+h-20],[x+w-20,y+h-20]]) {
            t.save();t.translate(cx,cy);t.rotate(Math.PI/4);t.fillStyle=colors.petal+'88';t.fillRect(-6,-6,12,12);t.restore();
        }
    }
    t.globalCompositeOperation='destination-in';t.drawImage(mask,0,0);
    ctx.globalAlpha=wild?.55:1;ctx.drawImage(paving,0,0);ctx.globalAlpha=1;
    // Small illustrated tufts stay outside travel space; no extra map meshes.
    for(let i=0;i<size.w*size.h*.7;i++) {
        const wx=rng()*size.w,wy=rng()*size.h;
        if(layout.isProtected(wx,wy,.2))continue;
        const x=wx*P,y=wy*P;ctx.strokeStyle=colors.foliage+'68';ctx.lineWidth=1.2;
        for(let leaf=0;leaf<3;leaf++){
            ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+leaf*3-3,y-4,x+leaf*5-5,y-6-rng()*5);ctx.stroke();
        }
        if(i%5===0){
            for(let petal=0;petal<5;petal++){
                const a=petal*Math.PI*.4;ctx.fillStyle=colors.petal+'c0';ctx.beginPath();
                ctx.ellipse(x+Math.cos(a)*3,y-6+Math.sin(a)*2,2.5,1.6,a,0,Math.PI*2);ctx.fill();
            }
            ctx.fillStyle='#fff5c8';ctx.fillRect(x-1,y-7,2,2);
        }
    }
    for(let i=0;i<160;i++) {
        const x=rng()*c.width,y=rng()*c.height;
        ctx.fillStyle=colors.petal+'65';ctx.beginPath();ctx.ellipse(x,y,1.7+rng()*3,.9+rng()*1.4,rng()*Math.PI,0,Math.PI*2);ctx.fill();
    }
    if(cfg.night) {ctx.fillStyle='#28243928';ctx.fillRect(0,0,c.width,c.height);}
    const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=8;
    let material,geometry;
    try {
        material=new THREE.MeshBasicMaterial({map:texture});geometry=new THREE.PlaneGeometry(size.w,size.h);
        const mesh=new THREE.Mesh(geometry,material);mesh.name='room-surface';mesh.rotation.x=-Math.PI/2;
        mesh.position.set(size.w/2,-.019,size.h/2);mesh.frustumCulled=false;
        return {root:mesh,texture,material};
    } catch(error) {geometry?.dispose();material?.dispose();texture.dispose();throw error;}
}
