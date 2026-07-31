/* ============================================================
   シミュレーションコアの依存初期化（合成ルート）
   （DOM / THREE 非依存・テスト対象）

   Vehicle / World は協調相手の実体をここ経由で受け取る。
   各モジュールから実体への import をこのモジュールへ集約することで、
   vehicle → controller / world → vehicle の import cycle を作らずに
   依存を差し替え可能にする（Issue #120）。

   ここは実体を import する側なので、逆向き（world.ts など）から値として
   import されるモジュールを値 import してはならない（型 import のみ可）。
   ============================================================ */
import { LaneChangeController } from './lane-change-controller';
import { LongitudinalController } from './longitudinal-controller';
import { MergeCoordinator } from './merge-coordinator';
import { Vehicle } from './vehicle';
import type { VehicleDeps, VehicleFactory } from './vehicle';
import type { WorldDeps } from './world';

/**
 * 車両が使うコントローラ群の初期化。
 * overrides に渡した依存だけを差し替える（テストでは偽物を注入できる）。
 */
export function createVehicleDeps(overrides: Partial<VehicleDeps> = {}): VehicleDeps {
  return {
    createLaneChangeController: (vehicle) => new LaneChangeController(vehicle),
    createLongitudinalController: (vehicle) => new LongitudinalController(vehicle),
    createMergeCoordinator: (vehicle) => new MergeCoordinator(vehicle),
    ...overrides,
  };
}

/**
 * 既定の車両生成。deps は素通しで渡し、省略時の既定値は Vehicle 側の
 * デフォルト引数 (= 生成元 World の車両依存) の一箇所に委ねる。
 */
export const createVehicle: VehicleFactory = (
  world,
  section,
  lane,
  z,
  typeName,
  desiredSpeed,
  deps,
) => new Vehicle(world, section, lane, z, typeName, desiredSpeed, deps);

/**
 * World が持つ依存の初期化。
 * overrides に渡した依存だけを差し替える（車両生成そのものを偽物にもできる）。
 */
export function createWorldDeps(overrides: Partial<WorldDeps> = {}): WorldDeps {
  return {
    createVehicle,
    vehicleDeps: createVehicleDeps(),
    ...overrides,
  };
}
