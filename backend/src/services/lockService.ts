import redisClient from '../config/redis';

const LOCK_TTL = 5;
const RETRY_DELAY = 200;
const MAX_RETRIES = 5;

export class LockService {

    async acquireLock(row: number, col: string, owner: string): Promise<boolean> {
        const lockKey = `lock:${row}:${col}`;
        let retries = 0;

        while (retries < MAX_RETRIES) {
            const acquired = await redisClient.set(
                lockKey,
                owner,
                'EX', LOCK_TTL,
                'NX'
            );

            if (acquired === 'OK') {
                return true;
            }

            retries++;
            console.log(`⏳ [${owner}] Waiting for lock on ${col}${row}... (retry ${retries}/${MAX_RETRIES})`);
            await this.delay(RETRY_DELAY);
        }

        return false;
    }

    async releaseLock(row: number, col: string, owner: string): Promise<boolean> {
        const lockKey = `lock:${row}:${col}`;

        const script = `
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            else
                return 0
            end
        `;

        const result = await redisClient.eval(script, 1, lockKey, owner);
        return result === 1;
    }

    async isLocked(row: number, col: string): Promise<{ locked: boolean; owner?: string }> {
        const lockKey = `lock:${row}:${col}`;
        const owner = await redisClient.get(lockKey);

        return {
            locked: owner !== null,
            owner: owner || undefined,
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default new LockService();