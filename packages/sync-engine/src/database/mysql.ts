import mysql, { Pool, PoolOptions, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { EntitySchema } from '../schemas/types'

type MySQLConfig = {
  schema: string // In MySQL, this is effectively the database name
  poolConfig: PoolOptions
}

// Custom query result type to match expected interface
type QueryResult<T = any> = {
  rows: T[]
  rowCount: number
}

export class MySQLClient {
  pool: Pool

  constructor(private config: MySQLConfig) {
    // Ensure the database is included in the pool config
    this.pool = mysql.createPool({
      ...config.poolConfig,
      database: config.schema,
      namedPlaceholders: true, // Enable named placeholders like :id, :name
    })
  }

  async delete(table: string, id: string): Promise<boolean> {
    // MySQL doesn't support RETURNING clause, so we check affectedRows
    const sql = `
      DELETE FROM \`${this.config.schema}\`.\`${table}\`
      WHERE id = :id
    `

    const [result] = await this.pool.execute<ResultSetHeader>(sql, { id })
    return result.affectedRows > 0
  }

  async query(text: string, params?: any): Promise<QueryResult> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(text, params)
    return {
      rows: rows as any[],
      rowCount: rows.length,
    }
  }

  async upsertMany<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(entries: T[], table: string, tableSchema: EntitySchema): Promise<T[]> {
    if (!entries.length) return []

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5
    const results: T[][] = []

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<T[]>[] = []
      chunk.forEach((entry) => {
        // Inject the values
        const cleansed = this.cleanseArrayField(entry)
        const upsertSql = this.constructUpsertSql(this.config.schema, table, tableSchema)

        queries.push(this.executeUpsert(upsertSql, cleansed, table))
      })

      results.push(...(await Promise.all(queries)))
    }

    return results.flat()
  }

  async upsertManyWithTimestampProtection<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(entries: T[], table: string, tableSchema: EntitySchema, syncTimestamp?: string): Promise<T[]> {
    const timestamp = syncTimestamp || new Date().toISOString()

    if (!entries.length) return []

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5
    const results: T[][] = []

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<T[]>[] = []
      chunk.forEach((entry) => {
        // Inject the values
        const cleansed = this.cleanseArrayField(entry)
        // Add last_synced_at to the cleansed data for SQL parameter binding
        cleansed.last_synced_at = timestamp

        const upsertSql = this.constructUpsertWithTimestampProtectionSql(
          this.config.schema,
          table,
          tableSchema
        )

        queries.push(this.executeUpsert(upsertSql, cleansed, table))
      })

      results.push(...(await Promise.all(queries)))
    }

    return results.flat()
  }

  async findMissingEntries(table: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return []

    // MySQL uses IN clause instead of PostgreSQL's ANY
    const sql = `
      SELECT id FROM \`${this.config.schema}\`.\`${table}\`
      WHERE id IN (:ids)
    `

    const { rows } = await this.query(sql, { ids })
    const existingIds = rows.map((it) => it.id)

    const missingIds = ids.filter((it) => !existingIds.includes(it))

    return missingIds
  }

  /**
   * Execute an upsert query and return the upserted data.
   * MySQL doesn't support RETURNING clause like PostgreSQL.
   *
   * For simplicity and performance, we return the input data after successful upsert.
   * The alternative would be to SELECT after every INSERT/UPDATE, which is expensive.
   */
  private async executeUpsert<T>(sql: string, params: any, table: string): Promise<T[]> {
    await this.pool.execute<ResultSetHeader>(sql, params)

    // Return the input data wrapped in array
    // The upsert succeeded, so the data in the DB matches what we sent
    return [params as T]
  }

  /**
   * Returns a MySQL upsert query using ON DUPLICATE KEY UPDATE.
   *
   * MySQL syntax:
   *   INSERT INTO customers (`id`, `name`)
   *   VALUES (:id, :name)
   *   ON DUPLICATE KEY UPDATE
   *     `id` = VALUES(`id`),
   *     `name` = VALUES(`name`)
   */
  private constructUpsertSql(
    schema: string,
    table: string,
    tableSchema: EntitySchema,
    options?: {
      conflict?: string
    }
  ): string {
    const properties = tableSchema.properties

    return `
    INSERT INTO \`${schema}\`.\`${table}\` (
      ${properties.map((x) => `\`${x}\``).join(',')}
    )
    VALUES (
      ${properties.map((x) => `:${x}`).join(',')}
    )
    ON DUPLICATE KEY UPDATE
      ${properties.map((x) => `\`${x}\` = VALUES(\`${x}\`)`).join(',')}
    `
  }

  /**
   * Returns a MySQL upsert query with timestamp protection.
   *
   * Since MySQL doesn't support WHERE clause in ON DUPLICATE KEY UPDATE,
   * we use IF() to conditionally update based on timestamp comparison.
   *
   * MySQL syntax:
   *   INSERT INTO `stripe`.`charges` (
   *     `id`, `amount`, `created`, `last_synced_at`
   *   )
   *   VALUES (
   *     :id, :amount, :created, :last_synced_at
   *   )
   *   ON DUPLICATE KEY UPDATE
   *     `amount` = IF(
   *       `charges`.`last_synced_at` IS NULL OR `charges`.`last_synced_at` < VALUES(`last_synced_at`),
   *       VALUES(`amount`),
   *       `charges`.`amount`
   *     ),
   *     `last_synced_at` = IF(
   *       `charges`.`last_synced_at` IS NULL OR `charges`.`last_synced_at` < VALUES(`last_synced_at`),
   *       VALUES(`last_synced_at`),
   *       `charges`.`last_synced_at`
   *     )
   */
  private constructUpsertWithTimestampProtectionSql = (
    schema: string,
    table: string,
    tableSchema: EntitySchema
  ): string => {
    const properties = tableSchema.properties

    // Condition for timestamp protection
    const timestampCondition = `\`${table}\`.\`last_synced_at\` IS NULL OR \`${table}\`.\`last_synced_at\` < VALUES(\`last_synced_at\`)`

    return `
      INSERT INTO \`${schema}\`.\`${table}\` (
        ${properties.map((x) => `\`${x}\``).join(',')}, \`last_synced_at\`
      )
      VALUES (
        ${properties.map((x) => `:${x}`).join(',')}, :last_synced_at
      )
      ON DUPLICATE KEY UPDATE
        ${properties
          .filter((x) => x !== 'last_synced_at')
          .map(
            (x) => `\`${x}\` = IF(
          ${timestampCondition},
          VALUES(\`${x}\`),
          \`${table}\`.\`${x}\`
        )`
          )
          .join(',')},
        \`last_synced_at\` = IF(
          ${timestampCondition},
          VALUES(\`last_synced_at\`),
          \`${table}\`.\`last_synced_at\`
        )`
  }

  /**
   * For array object field like invoice.custom_fields
   * ex: [{"name":"Project name","value":"Test Project"}]
   *
   * we need to stringify it first because MySQL JSON columns expect strings
   */
  private cleanseArrayField(obj: {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  }): {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  } {
    const cleansed = { ...obj }
    Object.keys(cleansed).map((k) => {
      const data = cleansed[k]
      if (Array.isArray(data)) {
        cleansed[k] = JSON.stringify(data)
      }
    })
    return cleansed
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    await this.pool.end()
  }
}
