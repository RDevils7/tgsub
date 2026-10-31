import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.logLevel,
  base: { app: "tgsub" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
