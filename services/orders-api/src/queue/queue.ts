import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

export const ordersQueue = new Queue(config.ordersQueueName, { connection });
