export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level: string | undefined): Logger {
  const resolved: LogLevel =
    level === "debug" || level === "info" || level === "warn" || level === "error"
      ? level
      : "info";
  const threshold = LEVEL_ORDER[resolved];

  function enabled(l: LogLevel) {
    return LEVEL_ORDER[l] >= threshold;
  }

  return {
    debug: (...args) => {
      if (enabled("debug")) console.debug(...args);
    },
    info: (...args) => {
      if (enabled("info")) console.info(...args);
    },
    warn: (...args) => {
      if (enabled("warn")) console.warn(...args);
    },
    error: (...args) => {
      if (enabled("error")) console.error(...args);
    },
  };
}

export function createLevelFilteredLogger(base: Logger, level: string | undefined): Logger {
  const resolved: LogLevel =
    level === "debug" || level === "info" || level === "warn" || level === "error"
      ? level
      : "info";
  const threshold = LEVEL_ORDER[resolved];

  function enabled(l: LogLevel) {
    return LEVEL_ORDER[l] >= threshold;
  }

  return {
    debug: (...args) => {
      if (enabled("debug")) base.debug(...args);
    },
    info: (...args) => {
      if (enabled("info")) base.info(...args);
    },
    warn: (...args) => {
      if (enabled("warn")) base.warn(...args);
    },
    error: (...args) => {
      if (enabled("error")) base.error(...args);
    },
  };
}
