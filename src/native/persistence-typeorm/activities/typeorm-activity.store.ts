import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type {
  ActivityRecord,
  ActivityState,
} from '../../../core/application/activities/activity.model';
import type { ActivityStore } from '../../../core/application/activities/activity-store.port';
import type { JobErrorCode } from '../../../core/application/execution/job-failure';
import { PERSISTENCE_DATA_SOURCE } from '../persistence-typeorm.module';

interface ActivityRow {
  id: string;
  type: string;
  state: ActivityState;
  attempts: number;
  last_error_code: JobErrorCode | null;
  correlation_id: string;
  subject_id: string;
  tenant_id: string | null;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

function toRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    correlationId: row.correlation_id,
    subjectId: row.subject_id,
    tenantId: row.tenant_id,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
  };
}

/**
 * ActivityStore sobre PostgreSQL. `save` só avança: uma escrita com `attempts`
 * menor que o gravado é ignorada, então um executor obsoleto não regride o estado.
 */
@Injectable()
export class TypeOrmActivityStore implements ActivityStore {
  constructor(
    @Inject(PERSISTENCE_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  async insertIfAbsent(record: ActivityRecord): Promise<boolean> {
    const result: unknown = await this.dataSource.query(
      `INSERT INTO "activities"
         ("id", "type", "state", "attempts", "last_error_code", "correlation_id",
          "subject_id", "tenant_id", "created_at_ms", "updated_at_ms", "version")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"`,
      [
        record.id,
        record.type,
        record.state,
        record.attempts,
        record.lastErrorCode,
        record.correlationId,
        record.subjectId,
        record.tenantId,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return Array.isArray(result) && result.length > 0;
  }

  async save(record: ActivityRecord): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "activities"
         ("id", "type", "state", "attempts", "last_error_code", "correlation_id",
          "subject_id", "tenant_id", "created_at_ms", "updated_at_ms", "version")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
       ON CONFLICT ("id") DO UPDATE SET
         "state" = EXCLUDED."state",
         "attempts" = EXCLUDED."attempts",
         "last_error_code" = EXCLUDED."last_error_code",
         "updated_at_ms" = EXCLUDED."updated_at_ms",
         "version" = "activities"."version" + 1
       WHERE "activities"."attempts" <= EXCLUDED."attempts"`,
      [
        record.id,
        record.type,
        record.state,
        record.attempts,
        record.lastErrorCode,
        record.correlationId,
        record.subjectId,
        record.tenantId,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async find(
    id: string,
    tenantId: string | null,
  ): Promise<ActivityRecord | null> {
    const rows: ActivityRow[] = await this.dataSource.query(
      `SELECT * FROM "activities"
        WHERE "id" = $1 AND "tenant_id" IS NOT DISTINCT FROM $2`,
      [id, tenantId],
    );
    const [row] = rows;
    return row === undefined ? null : toRecord(row);
  }
}
