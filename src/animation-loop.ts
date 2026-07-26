export interface AnimationFaultState {
  readonly error: unknown;
}

export const FIXED_SIMULATION_DELTA_TIME = 1 / 60;

export interface FixedStepAccumulator {
  advance(elapsedTime: number, step: (deltaTime: number) => void): number;
  reset(): void;
}

export interface AnimationFaultBoundary {
  readonly fault: AnimationFaultState | null;
  runFrame(update: () => void, render: () => void, prepareRender?: () => void): void;
  reset(): void;
}

/**
 * 可変の描画間隔を固定の物理 tick へ変換する。
 * 端数は次フレームへ持ち越し、証明時と実行時の deltaTime を常に一致させる。
 */
export function createFixedStepAccumulator(
  stepDuration = FIXED_SIMULATION_DELTA_TIME,
): FixedStepAccumulator {
  if (!(stepDuration > 0) || !Number.isFinite(stepDuration))
    throw new RangeError('固定物理tickは有限の正数である必要があります');
  let accumulator = 0;
  return {
    advance(elapsedTime, step) {
      if (elapsedTime < 0 || !Number.isFinite(elapsedTime))
        throw new RangeError('経過時間は有限の非負数である必要があります');
      accumulator += elapsedTime;
      let steps = 0;
      while (accumulator + Number.EPSILON >= stepDuration) {
        step(stepDuration);
        accumulator = Math.max(0, accumulator - stepDuration);
        steps++;
      }
      return steps;
    },
    reset() {
      accumulator = 0;
    },
  };
}

/**
 * 更新例外を一度だけ報告して停止し、描画と明示リセットだけを生かす。
 * fault 中は update を再試行しないため、壊れた状態を進め続けない。
 */
export function createAnimationFaultBoundary(
  report: (error: unknown) => void,
  reportPresentation: (error: unknown) => void = (error) => console.error('描画更新エラー', error),
): AnimationFaultBoundary {
  let fault: AnimationFaultState | null = null;
  return {
    get fault() {
      return fault;
    },
    runFrame(update, render, prepareRender) {
      if (fault === null) {
        try {
          update();
        } catch (error) {
          fault = { error };
          report(error);
        }
      }
      if (prepareRender) {
        try {
          prepareRender();
        } catch (error) {
          reportPresentation(error);
        }
      }
      try {
        render();
      } catch (error) {
        reportPresentation(error);
      }
    },
    reset() {
      fault = null;
    },
  };
}
