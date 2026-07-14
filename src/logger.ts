// Minimal logging seam so sync modules do not depend on @actions/core directly.
export interface Logger {
  info(message: string): void;
  warning(message: string): void;
  startGroup(name: string): void;
  endGroup(): void;
}

/** A logger that discards output, for tests. */
export const nullLogger: Logger = {
  info() {},
  warning() {},
  startGroup() {},
  endGroup() {},
};
