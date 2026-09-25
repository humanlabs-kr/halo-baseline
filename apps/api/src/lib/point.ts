import { desc, eq, pointLogs, type Database, type PointSourceType } from '@halo/database';
import KSUID from 'ksuid';

/**
 * A transaction handle as drizzle hands it to `db.transaction(...)`. Derived
 * from `Database` so the generic soup (PgTransaction, the query-result HKT, the
 * relation map) stays inside the database package.
 */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface InsertPointLogParams {
  userAddress: string;
  diff: number;
  sourceType: PointSourceType;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export const PointService = {
  /**
   * Current balance for a wallet.
   *
   * Read off the newest log row rather than summed: every row already carries
   * the balance as of that movement.
   */
  async getUserPoint(db: Database, userAddress: string) {
    const latest = await db.query.pointLogs.findFirst({
      where: eq(pointLogs.userAddress, userAddress),
      orderBy: [desc(pointLogs.createdAt)],
    });

    return {
      afterBalance: latest?.afterBalance ?? 0,
      accumulatedBalance: latest?.accumulatedBalance ?? 0,
    };
  },

  /**
   * Appends a point movement.
   *
   * Takes a transaction, not a connection: the running balance is read and then
   * written, so a concurrent spend outside the same transaction would let a
   * wallet go negative.
   */
  async insertPointLog(tx: Transaction, params: InsertPointLogParams) {
    const latest = await tx.query.pointLogs.findFirst({
      where: eq(pointLogs.userAddress, params.userAddress),
      orderBy: [desc(pointLogs.createdAt)],
    });

    const afterBalance = latest?.afterBalance ?? 0;
    const accumulatedBalance = latest?.accumulatedBalance ?? 0;

    if (params.diff < 0 && afterBalance + params.diff < 0) {
      throw new Error('Insufficient point');
    }

    const [createdPointLog] = await tx
      .insert(pointLogs)
      .values({
        id: KSUID.randomSync().string,
        userAddress: params.userAddress,
        diff: params.diff,
        afterBalance: afterBalance + params.diff,
        // Lifetime total counts earnings only, so a spend leaves it untouched.
        accumulatedBalance: params.diff < 0 ? accumulatedBalance : accumulatedBalance + params.diff,
        sourceType: params.sourceType,
        sourceId: params.sourceId ?? null,
        metadata: params.metadata ?? {},
      })
      .returning();

    if (!createdPointLog) {
      throw new Error('Failed to insert point log');
    }

    return createdPointLog;
  },
};
