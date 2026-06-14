type Fields = Record<string, unknown>;

function write(level: string, message: string, fields: Fields = {}): void {
  const entry = { time: new Date().toISOString(), level, message, ...fields };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
