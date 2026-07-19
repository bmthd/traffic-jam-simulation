/* ================= カメラ操作（回転・ズーム） ================= */
import * as THREE from 'three';
import { clamp } from '../core';
import { camera, renderer } from './scene';

export interface CameraController {
  theta: number;
  phi: number;
  radius: number;
  target: THREE.Vector3;
}
export const cameraController: CameraController = {
  theta: 0,
  phi: 1.06,
  radius: 105,
  target: new THREE.Vector3(0, 0, 0),
};

export function updateCamera(): void {
  const controller = cameraController;
  camera.position.set(
    controller.target.x + controller.radius * Math.sin(controller.phi) * Math.sin(controller.theta),
    controller.target.y + controller.radius * Math.cos(controller.phi),
    controller.target.z + controller.radius * Math.sin(controller.phi) * Math.cos(controller.theta),
  );
  camera.lookAt(controller.target);
}

export function setupCameraControls(): void {
  const dom = renderer.domElement;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  dom.addEventListener('pointerdown', function (e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dom.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const points = Array.from(pointers.values());
      pinchDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }
  });
  dom.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    const previous = pointers.get(e.pointerId)!;
    const deltaX = e.clientX - previous.x,
      deltaY = e.clientY - previous.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      cameraController.theta -= deltaX * 0.005;
      cameraController.phi = clamp(cameraController.phi - deltaY * 0.004, 0.25, 1.45);
    } else if (pointers.size === 2) {
      const points = Array.from(pointers.values());
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (pinchDistance > 0)
        cameraController.radius = clamp(
          cameraController.radius * (pinchDistance / distance),
          30,
          240,
        );
      pinchDistance = distance;
    }
  });
  function release(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    pinchDistance = 0;
  }
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);
  dom.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      cameraController.radius = clamp(cameraController.radius * (1 + e.deltaY * 0.0011), 30, 240);
    },
    { passive: false },
  );
}
