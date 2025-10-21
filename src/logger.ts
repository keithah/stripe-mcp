export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogContext {
  [key: string]: unknown;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly name: string | undefined;

  constructor(level: LogLevel = 'info', name?: string) {
    this.level = level;
    this.name = name;
  }

  child(childName: string, context?: LogContext): Logger {
    const child = new Logger(this.level, this.name ? `${this.name}:${childName}` : childName);
    if (context) {
      child.debug('Logger child created', context);
    }
    return child;
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (levelPriority[level] < levelPriority[this.level]) {
      return;
    }

    const payload: Record<string, unknown> = {
      level,
      timestamp: new Date().toISOString(),
      message,
    };

    if (this.name) {
      payload.logger = this.name;
    }

    if (context && Object.keys(context).length > 0) {
      payload.context = sanitizeContext(context);
    }

    const serialized = JSON.stringify(payload);
    switch (level) {
      case 'debug':
      case 'info':
        console.log(serialized);
        break;
      case 'warn':
        console.warn(serialized);
        break;
      case 'error':
        console.error(serialized);
        break;
      default:
        console.log(serialized);
    }
  }
}

const secretKeys = new Set(['api_key', 'apiKey', 'stripe_api_key', 'authorization', 'token', 'secret']);

function sanitizeContext(context: LogContext): LogContext {
  const sanitized: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (secretKeys.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeContext(value as LogContext);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
