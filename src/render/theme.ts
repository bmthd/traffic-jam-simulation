/* ================= 昼夜テーマ(nightMixで連続補間) ================= */
import * as THREE from 'three';
import { scene, hemiLight, sun } from './scene';
import {
  headlightMaterial,
  glassMaterial,
  lampHeadMaterial,
  delineatorMaterial,
  starMaterial,
  moonMaterial,
  haloMaterial,
  lampGlowMaterial,
  bulbMaterial,
  beamMaterial,
  signGlowMaterial,
  mountainFarMaterial,
  mountainNearMaterial,
  cloudMaterial,
} from './materials';
import { nightGroup, nightDome } from './night';

export interface EnvSpec {
  background: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  headEmissive: number;
  glassEmissive: number;
  tailIdle: number;
  lampEmissive: number;
  delineator: number;
  mountainFar: number;
  mountainNear: number;
}

export const ENV: Record<'day' | 'night', EnvSpec> = {
  day: {
    background: 0xeef4f6,
    fogColor: 0xdfeef5,
    fogNear: 140,
    fogFar: 420,
    hemiSky: 0xeaf4ff,
    hemiGround: 0x55694f,
    hemiIntensity: 0.85,
    sunColor: 0xfff3df,
    sunIntensity: 0.95,
    headEmissive: 0x6b6346,
    glassEmissive: 0x000000,
    tailIdle: 0x4a0b0b,
    lampEmissive: 0x000000,
    delineator: 0x9aa3ad,
    mountainFar: 0xb9cbd9,
    mountainNear: 0x93aabf,
  },
  night: {
    background: 0x141d33,
    fogColor: 0x161f36,
    fogNear: 100,
    fogFar: 360,
    hemiSky: 0x32415f,
    hemiGround: 0x0a100e,
    hemiIntensity: 0.32,
    sunColor: 0x9fb6e8,
    sunIntensity: 0.3,
    headEmissive: 0xffe9a8,
    glassEmissive: 0x332912,
    tailIdle: 0x7a1212,
    lampEmissive: 0xffc36b,
    delineator: 0xffb054,
    mountainFar: 0x101a2e,
    mountainNear: 0x0b1322,
  },
};

// 描画側で共有する昼夜の状態。mix は 0(昼)〜1(夜) の連続値
export interface ThemeState {
  mix: number;
  target: number;
  tailIdleHex: number;
}
export const themeState: ThemeState = {
  mix: 0,
  target: 0,
  tailIdleHex: ENV.day.tailIdle,
};

const _colorFrom = new THREE.Color(),
  _colorTo = new THREE.Color();
function lerpColor(target: THREE.Color, fromHex: number, toHex: number, t: number): void {
  _colorFrom.setHex(fromHex);
  _colorTo.setHex(toHex);
  target.copy(_colorFrom).lerp(_colorTo, t);
}

export function applyEnv(): void {
  const day = ENV.day,
    night = ENV.night,
    mix = themeState.mix;
  const fog = scene.fog as THREE.Fog;
  lerpColor(scene.background as THREE.Color, day.background, night.background, mix);
  lerpColor(fog.color, day.fogColor, night.fogColor, mix);
  fog.near = day.fogNear + (night.fogNear - day.fogNear) * mix;
  fog.far = day.fogFar + (night.fogFar - day.fogFar) * mix;
  lerpColor(hemiLight.color, day.hemiSky, night.hemiSky, mix);
  lerpColor(hemiLight.groundColor, day.hemiGround, night.hemiGround, mix);
  hemiLight.intensity = day.hemiIntensity + (night.hemiIntensity - day.hemiIntensity) * mix;
  lerpColor(sun.color, day.sunColor, night.sunColor, mix);
  sun.intensity = day.sunIntensity + (night.sunIntensity - day.sunIntensity) * mix;
  lerpColor(headlightMaterial.emissive, day.headEmissive, night.headEmissive, mix);
  lerpColor(glassMaterial.emissive, day.glassEmissive, night.glassEmissive, mix);
  lerpColor(lampHeadMaterial.emissive, day.lampEmissive, night.lampEmissive, mix);
  lerpColor(delineatorMaterial.color, day.delineator, night.delineator, mix);
  lerpColor(mountainFarMaterial.color, day.mountainFar, night.mountainFar, mix);
  lerpColor(mountainNearMaterial.color, day.mountainNear, night.mountainNear, mix);
  cloudMaterial.opacity = 0.9 * (1 - mix); // 雲は夜には見えない
  _colorFrom.setHex(day.tailIdle);
  _colorTo.setHex(night.tailIdle);
  themeState.tailIdleHex = _colorFrom.lerp(_colorTo, mix).getHex();
  // 夜専用アセットはまとめてフェード
  nightDome.material.opacity = mix;
  nightGroup.visible = mix > 0.02;
  starMaterial.opacity = mix;
  moonMaterial.opacity = mix;
  haloMaterial.opacity = mix * 0.9;
  lampGlowMaterial.opacity = mix;
  bulbMaterial.opacity = mix;
  beamMaterial.opacity = mix;
  signGlowMaterial.opacity = mix;
}

// 目標値を設定する(instant = クロスフェードなしで即時反映)
export function setNightTarget(on: boolean, instant: boolean): void {
  themeState.target = on ? 1 : 0;
  if (instant) {
    themeState.mix = themeState.target;
    applyEnv();
  }
}

// 毎フレーム呼ぶ: 夕暮れ/夜明けのクロスフェード(約1.6秒)
export function tickTheme(deltaTime: number): void {
  if (themeState.mix === themeState.target) return;
  themeState.mix =
    themeState.target > themeState.mix
      ? Math.min(themeState.target, themeState.mix + deltaTime / 1.6)
      : Math.max(themeState.target, themeState.mix - deltaTime / 1.6);
  applyEnv();
}
