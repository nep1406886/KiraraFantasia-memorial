// Room-owned shaders keep static scenery merged per atlas. No per-prop frame loop.
export function sceneryMotion(THREE, geometry, entry, flat) {
    const foliage=!flat&&/tree|leaf|grass|flower|plant|bush|sakura|palm|bamboo/i.test(entry?.name||'');
    const water=flat&&entry?.category==='water';
    geometry.computeBoundingBox();
    const box=geometry.boundingBox,pos=geometry.getAttribute('position');
    const values=new Float32Array(pos.count*3),height=Math.max(.1,box.max.y-box.min.y);
    const phase=(box.min.x*.73+box.min.z*.47)%6.28;
    for(let i=0;i<pos.count;i++){
        const weight=foliage?Math.pow(Math.max(0,(pos.getY(i)-box.min.y)/height),2)*Math.min(.18,height*.09):0;
        values.set([weight,water?1:0,phase],i*3);
    }
    geometry.setAttribute('gardenMotion',new THREE.BufferAttribute(values,3));
}
export function createGardenMotion() {
    const time={value:0},strength={value:1},materials=new Set();
    function scenery(source) {
        const material=source.clone();materials.add(material);
        material.onBeforeCompile=shader=>{
            shader.uniforms.gardenTime=time;shader.uniforms.gardenStrength=strength;
            shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
                attribute vec3 gardenMotion;uniform float gardenTime,gardenStrength;varying float waterMotion;`)
                .replace('#include <begin_vertex>',`#include <begin_vertex>
                    float breeze=sin(gardenTime*1.65+gardenMotion.z)+.3*sin(gardenTime*2.7+gardenMotion.z);
                    transformed.x+=breeze*gardenMotion.x*gardenStrength;
                    transformed.z+=cos(gardenTime*1.1+gardenMotion.z)*gardenMotion.x*.35*gardenStrength;
                    waterMotion=gardenMotion.y;`);
            shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
                uniform float gardenTime,gardenStrength;varying float waterMotion;`)
                .replace('#include <dithering_fragment>',`#include <dithering_fragment>
                    float ripple=sin(vMapUv.x*96.+vMapUv.y*40.+gardenTime*2.2);
                    gl_FragColor.rgb+=waterMotion*gardenStrength*pow(max(0.,ripple),10.)*.12;`);
        };
        material.customProgramCacheKey=()=> 'garden-scenery-v1';
        return material;
    }
    function surface(material) {
        material.onBeforeCompile=shader=>{
            shader.uniforms.gardenTime=time;shader.uniforms.gardenStrength=strength;
            shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
                varying vec2 landscape;`).replace('#include <begin_vertex>',`#include <begin_vertex>
                landscape=position.xy;`);
            shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
                varying vec2 landscape;uniform float gardenTime,gardenStrength;`)
                .replace('#include <dithering_fragment>',`#include <dithering_fragment>
                    vec2 p=landscape+vec2(gardenTime*.13,gardenTime*.07)*gardenStrength;
                    float shade=sin(p.x*.47+sin(p.y*.6))*cos(p.y*.38+p.x*.16);
                    gl_FragColor.rgb*=.97+shade*.065;`);
        };
        material.customProgramCacheKey=()=> 'garden-ground-v1';
    }
    return {scenery,surface,time,strength,
        update(dt,reduced){strength.value=reduced?0:1;if(!reduced)time.value+=Math.max(0,dt||0);},
        dispose(){materials.forEach(material=>material.dispose());materials.clear();}
    };
}
