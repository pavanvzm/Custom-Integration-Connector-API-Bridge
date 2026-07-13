import pino from "pino";
import { config } from "../config/index.js";

const transport = config.log.prettyPrint
  ? pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    })
  : undefined;

export const logger = pino(
  {
    level: config.log.level,
    name: "api-bridge",
    serializers: {
      error: pino.stdSerializers.err,
    },
  },
  transport,
);

export type Logger = typeof logger;
