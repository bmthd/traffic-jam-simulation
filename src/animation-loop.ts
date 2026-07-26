export interface AnimationFaultState {
  readonly error: unknown;
}

export interface AnimationFaultBoundary {
  readonly fault: AnimationFaultState | null;
  runFrame(update: () => void, render: () => void): void;
  reset(): void;
}

/**
 * 更新例外を一度だけ報告して停止し、描画と明示リセットだけを生かす。
 * fault 中は update を再試行しないため、壊れた状態を進め続けない。
 */
export function createAnimationFaultBoundary(
  report: (error: unknown) => void,
): AnimationFaultBoundary {
  let fault: AnimationFaultState | null = null;
  return {
    get fault() {
      return fault;
    },
    runFrame(update, render) {
      if (fault === null) {
        try {
          update();
        } catch (error) {
          fault = { error };
          report(error);
        }
      }
      render();
    },
    reset() {
      fault = null;
    },
  };
}
