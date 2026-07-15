/* ================= 昼夜テーマ(nightMixで連続補間) ================= */
import * as THREE from 'three';
import { scene, hemi, sun } from './scene.js';
import {
  headMat, glassMat, lampHeadMat, delinMat,
  starMat, moonMat, haloMat, lampGlowMat, bulbMat, beamMat, signGlowMat
} from './materials.js';
import { nightGroup, nightDome } from './night.js';

export const ENV = {
  day:   { bg: 0xeef4f6, fogColor: 0xdfeef5, fogNear: 140, fogFar: 420,
           hemiSky: 0xeaf4ff, hemiGround: 0x55694f, hemiInt: 0.85,
           sunColor: 0xfff3df, sunInt: 0.95,
           headEmissive: 0x6b6346, glassEmissive: 0x000000,
           tailIdle: 0x4a0b0b, lampEmissive: 0x000000, delin: 0x9aa3ad },
  night: { bg: 0x141d33, fogColor: 0x161f36, fogNear: 100, fogFar: 360,
           hemiSky: 0x32415f, hemiGround: 0x0a100e, hemiInt: 0.32,
           sunColor: 0x9fb6e8, sunInt: 0.30,
           headEmissive: 0xffe9a8, glassEmissive: 0x332912,
           tailIdle: 0x7a1212, lampEmissive: 0xffc36b, delin: 0xffb054 }
};

// 描画側で共有する昼夜の状態。mix は 0(昼)〜1(夜) の連続値
export const themeState = {
  mix: 0,
  target: 0,
  tailIdleHex: ENV.day.tailIdle
};

const _ca = new THREE.Color(), _cb = new THREE.Color();
function lerpColor(target, a, b, t){
  _ca.setHex(a); _cb.setHex(b);
  target.copy(_ca).lerp(_cb, t);
}

export function applyEnv(){
  const d = ENV.day, n = ENV.night, t = themeState.mix;
  lerpColor(scene.background, d.bg, n.bg, t);
  lerpColor(scene.fog.color, d.fogColor, n.fogColor, t);
  scene.fog.near = d.fogNear + (n.fogNear - d.fogNear) * t;
  scene.fog.far  = d.fogFar  + (n.fogFar  - d.fogFar)  * t;
  lerpColor(hemi.color, d.hemiSky, n.hemiSky, t);
  lerpColor(hemi.groundColor, d.hemiGround, n.hemiGround, t);
  hemi.intensity = d.hemiInt + (n.hemiInt - d.hemiInt) * t;
  lerpColor(sun.color, d.sunColor, n.sunColor, t);
  sun.intensity = d.sunInt + (n.sunInt - d.sunInt) * t;
  lerpColor(headMat.emissive, d.headEmissive, n.headEmissive, t);
  lerpColor(glassMat.emissive, d.glassEmissive, n.glassEmissive, t);
  lerpColor(lampHeadMat.emissive, d.lampEmissive, n.lampEmissive, t);
  lerpColor(delinMat.color, d.delin, n.delin, t);
  _ca.setHex(d.tailIdle); _cb.setHex(n.tailIdle);
  themeState.tailIdleHex = _ca.lerp(_cb, t).getHex();
  // 夜専用アセットはまとめてフェード
  nightDome.material.opacity = t;
  nightGroup.visible = t > 0.02;
  starMat.opacity = t;
  moonMat.opacity = t;
  haloMat.opacity = t * 0.9;
  lampGlowMat.opacity = t;
  bulbMat.opacity = t;
  beamMat.opacity = t;
  signGlowMat.opacity = t;
}

// 目標値を設定する(instant = クロスフェードなしで即時反映)
export function setNightTarget(on, instant){
  themeState.target = on ? 1 : 0;
  if (instant) {
    themeState.mix = themeState.target;
    applyEnv();
  }
}

// 毎フレーム呼ぶ: 夕暮れ/夜明けのクロスフェード(約1.6秒)
export function tickTheme(dt){
  if (themeState.mix === themeState.target) return;
  themeState.mix = themeState.target > themeState.mix
    ? Math.min(themeState.target, themeState.mix + dt / 1.6)
    : Math.max(themeState.target, themeState.mix - dt / 1.6);
  applyEnv();
}
