/* ================= カメラ操作（回転・ズーム） ================= */
import * as THREE from 'three';
import { clamp } from '../core/index.js';
import { camera, renderer } from './scene.js';

export const camCtrl = { theta: 0, phi: 1.06, radius: 105, target: new THREE.Vector3(0, 0, 0) };

export function updateCamera(){
  const c = camCtrl;
  camera.position.set(
    c.target.x + c.radius * Math.sin(c.phi) * Math.sin(c.theta),
    c.target.y + c.radius * Math.cos(c.phi),
    c.target.z + c.radius * Math.sin(c.phi) * Math.cos(c.theta)
  );
  camera.lookAt(c.target);
}

export function setupCameraControls(){
  const dom = renderer.domElement;
  const pointers = new Map();
  let pinchDist = 0;
  dom.addEventListener('pointerdown', function(e){
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dom.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    }
  });
  dom.addEventListener('pointermove', function(e){
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      camCtrl.theta -= dx * 0.005;
      camCtrl.phi = clamp(camCtrl.phi - dy * 0.004, 0.25, 1.45);
    } else if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (pinchDist > 0) camCtrl.radius = clamp(camCtrl.radius * (pinchDist / d), 30, 240);
      pinchDist = d;
    }
  });
  function release(e){ pointers.delete(e.pointerId); pinchDist = 0; }
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);
  dom.addEventListener('wheel', function(e){
    e.preventDefault();
    camCtrl.radius = clamp(camCtrl.radius * (1 + e.deltaY * 0.0011), 30, 240);
  }, { passive: false });
}
