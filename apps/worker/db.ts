/** Bind values, never interpolate values into SQL. Convert booleans to 0/1 explicitly. */
export type DbValue = string | number | null | ArrayBuffer | Uint8Array;

export interface DbResult<Row> {
  rows: Row[];
  /** SQL execution is not proof of a business transition: zero changes is valid. */
  changes: number;
  meta: D1Result<Row>['meta'];
}

const nativeStatement = Symbol('nativeStatement');
const databaseOwner = Symbol('databaseOwner');

function result<Row>(value: D1Result<Row>): DbResult<Row> {
  return { rows: value.results, changes: value.meta.changes, meta: value.meta };
}

/** Row describes the selected columns; this layer does not validate SQL row schemas. */
export class DbStatement<Row = Record<string, unknown>> {
  readonly [databaseOwner]: D1Database;
  readonly [nativeStatement]: D1PreparedStatement;

  constructor(database: D1Database, statement: D1PreparedStatement) {
    this[databaseOwner] = database;
    this[nativeStatement] = statement;
  }

  /** Returns a newly bound statement, leaving reusable prepared statements intact. */
  bind(...values: DbValue[]): DbStatement<Row> {
    return new DbStatement(this[databaseOwner], this[nativeStatement].bind(...values));
  }

  async all(): Promise<DbResult<Row>> {
    return result(await this[nativeStatement].all<Row>());
  }

  async first(): Promise<Row | null> {
    return this[nativeStatement].first<Row>();
  }

  /** Executes a write and retains RETURNING rows and changes, including zero. */
  async run(): Promise<DbResult<Row>> {
    // all() preserves RETURNING data for writes as well as SELECT rows.
    return this.all();
  }
}

export function prepare<Row = Record<string, unknown>>(
  database: D1Database,
  sql: string,
  values: readonly DbValue[] = [],
): DbStatement<Row> {
  const statement = new DbStatement<Row>(database, database.prepare(sql));
  return values.length === 0 ? statement : statement.bind(...values);
}

export type BatchResults<Statements extends readonly DbStatement<unknown>[]> = {
  -readonly [Index in keyof Statements]: Statements[Index] extends DbStatement<infer Row> ? DbResult<Row> : never;
};

/**
 * One native D1 atomic batch, in input order. SQL errors reject and roll back.
 * A statement affecting zero rows is NOT an SQL error and does NOT roll back;
 * callers must inspect each result and enforce business invariants in SQL.
 * No transaction spans application callbacks or upstream network operations.
 */
export async function batch<const Statements extends readonly DbStatement<unknown>[]>(
  database: D1Database,
  statements: Statements,
): Promise<BatchResults<Statements>> {
  if (statements.some((statement) => statement[databaseOwner] !== database)) {
    throw new TypeError('All batch statements must belong to the supplied D1 database.');
  }
  if (statements.length === 0) return [] as BatchResults<Statements>;
  const values = await database.batch<unknown>(statements.map((statement) => statement[nativeStatement]));
  // D1 returns one result per statement, in the same order; each row type comes
  // from that statement's caller-supplied SQL projection type.
  return values.map(result) as BatchResults<Statements>;
}
