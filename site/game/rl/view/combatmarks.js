// Read-only combat silhouettes. One reusable blade and a bounded contact pool;
// dimensions come from the same swing snapshot used by inWeaponReach.
import { PLAYER_TIMING } from '../actorstate.js';
import { COMBAT_HEIGHT, LAYER } from './layers.js';

const COLORS = [0xffad8b, 0x93dfff, 0xf1d49b, 0xb2edc3, 0xd4b5ff, 0xffe6a7];
const VERTEX = `varying vec2 uvLocal;
    void main(){uvLocal=uv*2.-1.;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
export function createCombatMarks(scene, THREE, camera) {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
        transparent:true, depthWrite:false, depthTest:false, side:THREE.DoubleSide, toneMapped:false,
        uniforms:{tint:{value:new THREE.Color()}, phase:{value:0}, opacity:{value:1},
            arc:{value:1}, width:{value:.1}, thrust:{value:0}, art:{value:null}, hasArt:{value:0}},
        vertexShader:VERTEX,
        fragmentShader:`varying vec2 uvLocal; uniform vec3 tint;
            uniform float phase,opacity,arc,width,thrust,hasArt; uniform sampler2D art;
            void main(){
                vec2 p=uvLocal;float r=length(p),a=atan(p.y,p.x);
                float edge=1.-smoothstep(.98,1.,r);
                float sector=1.-smoothstep(arc*.5-.018,arc*.5,abs(a));
                float ring=smoothstep(.60,.94,r)*edge;
                float sweep=exp(-pow((a/arc+.5-phase)*4.,2.));
                float filament=exp(-pow((r-.93)*55.,2.));
                float alpha=sector*edge*(.09+ring*(.28+.36*sweep)+filament*.4);
                vec2 texUV=vec2(clamp(r,0.,1.),a/arc+.5);
                if(thrust>.5){
                    float axis=clamp(p.x,0.,1.-width);
                    float d=length(p-vec2(axis,0.))/width;
                    float core=1.-smoothstep(.1,1.,d);
                    float spine=exp(-abs(p.y/width)*16.);
                    float ribs=pow(max(0.,cos((p.x-phase)*30.)),14.)*exp(-abs(p.y/width)*3.);
                    alpha=core*(.16+.28*exp(-pow((p.x-phase)*3.,2.)))+core*spine*.6+core*ribs*.2;
                    texUV=vec2(clamp(p.x,0.,1.),p.y/width*.5+.5);
                }
                float detail=mix(1.,.65+texture2D(art,texUV).r*.55,hasArt);
                alpha*=opacity*detail;if(alpha<.012)discard;
                gl_FragColor=vec4(mix(tint,vec3(1.),.35+sweep*.25),alpha);
            }`
    });
    const blade = new THREE.Mesh(geometry, material);
    blade.name='player-attack-reach';blade.visible=false;blade.userData.rlOverlay=true;
    blade.renderOrder=LAYER.vfx+1;scene.add(blade);
    const contacts=[];
    const contactMaterial=new THREE.ShaderMaterial({
        transparent:true,depthWrite:false,depthTest:false,toneMapped:false,
        uniforms:{tint:{value:new THREE.Color()},life:{value:0}},vertexShader:VERTEX,
        fragmentShader:`varying vec2 uvLocal;uniform vec3 tint;uniform float life;
            void main(){vec2 p=uvLocal;float r=length(p);
                float ring=(1.-smoothstep(.025,.1,abs(r-(.2+life*.6))))*(1.-life);
                float ray=exp(-abs(p.x*p.y)*130.)*(1.-smoothstep(.12,.75,r));
                float alpha=(ring*.7+ray)*(1.-life);
                if(alpha<.015)discard;gl_FragColor=vec4(mix(tint,vec3(1.),.65),alpha);}`
    });
    let swing=null;
    function cast(unit, texture) {
        const profile=unit.swingProfile||unit.weaponProfile;
        if(!profile||!['slash','thrust'].includes(profile.kind))return false;
        swing={unit,id:unit.swingId,profile,tail:0};
        const u=material.uniforms;
        u.tint.value.setHex(COLORS[unit.element]||COLORS[5]);
        u.arc.value=profile.arc||1;
        u.thrust.value=Number(profile.kind==='thrust');u.art.value=texture||null;u.hasArt.value=texture?1:0;
        const extent=profile.range+(profile.kind==='thrust'?profile.width:0);
        u.width.value=(profile.width||.3)/extent;
        blade.scale.setScalar(extent);blade.visible=true;
        return true;
    }
    function impact(x,y,element,crit) {
        let mark=contacts.find(m=>!m.mesh.visible);
        if(!mark&&contacts.length<20){
            const mesh=new THREE.Mesh(geometry,contactMaterial.clone());
            mesh.name='hit-contact';mesh.userData.rlOverlay=true;mesh.renderOrder=LAYER.vfx+2;
            scene.add(mesh);mark={mesh,age:0};contacts.push(mark);
        }
        if(!mark)mark=contacts.reduce((a,b)=>a.age>b.age?a:b);
        mark.age=0;mark.mesh.visible=true;mark.mesh.position.set(x,COMBAT_HEIGHT,y);
        mark.mesh.scale.setScalar(crit?.62:.42);
        mark.mesh.material.uniforms.tint.value.setHex(COLORS[element]||COLORS[5]);
        mark.mesh.material.uniforms.life.value=0;
        if(camera)mark.mesh.quaternion.copy(camera.quaternion);
    }
    function update(dt,positionOf) {
        if(swing){
            const {unit,id}=swing,at=positionOf?positionOf(unit):unit;
            const active=unit.swingId===id&&unit.sm.state==='attack'&&!unit.dead
                &&unit.sm.stateTime<=PLAYER_TIMING.attackHitEnd;
            if(!active)swing.tail+=dt;
            const u=material.uniforms;
            u.phase.value=Math.min(1,Math.max(0,(unit.sm.stateTime-PLAYER_TIMING.attackHitStart)
                /(PLAYER_TIMING.attackHitEnd-PLAYER_TIMING.attackHitStart)));
            u.opacity.value=active?1:Math.max(0,1-swing.tail/.1);
            blade.position.set(at.x,COMBAT_HEIGHT,at.y);blade.rotation.set(-Math.PI/2,0,-unit.facing);
            if(swing.tail>=.1){swing=null;blade.visible=false;}
        }
        for(const mark of contacts){
            if(!mark.mesh.visible)continue;
            mark.age+=dt;mark.mesh.visible=mark.age<.24;
            mark.mesh.material.uniforms.life.value=Math.min(1,mark.age/.24);
            if(camera)mark.mesh.quaternion.copy(camera.quaternion);
        }
    }
    function clear(){swing=null;blade.visible=false;contacts.forEach(m=>{m.mesh.visible=false;});}
    return {cast,impact,update,clear,
        dispose(){blade.removeFromParent();material.dispose();contactMaterial.dispose();geometry.dispose();
            contacts.forEach(m=>{m.mesh.removeFromParent();m.mesh.material.dispose();});}
    };
}
