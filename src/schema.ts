import type { OutputSchema } from './types.ts';

/**
 * Derive a JSON Schema from a user-supplied output schema.
 *
 * Supports an explicit `{ jsonSchema }`, Zod v4 schemas (converted with
 * `z.toJSONSchema`), and anything exposing a `toJSONSchema()` method.
 */
export async function toJsonSchema(schema: OutputSchema<unknown>): Promise<Record<string, unknown>> {
  return stripDialect(await generate(schema));
}

async function generate(schema: OutputSchema<unknown>): Promise<Record<string, unknown>> {
  const candidate = schema as Record<string, any>;

  if (candidate.jsonSchema && typeof candidate.jsonSchema === 'object') {
    return candidate.jsonSchema as Record<string, unknown>;
  }
  if (candidate._zod || candidate._def) {
    const zod = await import('zod').catch(() => null);
    if (zod && typeof (zod as any).toJSONSchema === 'function') {
      // `io: 'output'` makes defaulted fields required in the emitted schema.
      return (zod as any).toJSONSchema(candidate, { io: 'output' }) as Record<string, unknown>;
    }
  }
  if (typeof candidate.toJSONSchema === 'function') {
    return candidate.toJSONSchema() as Record<string, unknown>;
  }
  // Fall back to an unconstrained object: the node still validates the result
  // afterwards, it just cannot steer the model with a schema up front.
  return { type: 'object', additionalProperties: true };
}

/**
 * Remove `$schema` markers, recursively.
 *
 * The CLI compiles the schema it is given and cannot resolve a remote dialect
 * meta-reference, so a generated schema that advertises its draft is rejected
 * outright. The keyword carries no constraints, so dropping it is lossless.
 */
function stripDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema;
  for (const [key, value] of Object.entries(rest)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rest[key] = stripDialect(value as Record<string, unknown>);
    }
  }
  return rest;
}

/** Validate a value against the schema, throwing a readable error on mismatch. */
export async function validateOutput<T>(schema: OutputSchema<T>, value: unknown): Promise<T> {
  const candidate = schema as Record<string, any>;

  const standard = candidate['~standard'];
  if (standard && typeof standard.validate === 'function') {
    const result = await standard.validate(value);
    if ('issues' in result && result.issues) {
      throw new Error(`output did not match schema: ${formatIssues(result.issues)}`);
    }
    return (result as { value: T }).value;
  }

  if (typeof candidate.parse === 'function') return candidate.parse(value) as T;

  return value as T;
}

function formatIssues(issues: readonly unknown[]): string {
  return issues
    .map((issue) => {
      const i = issue as { path?: unknown[]; message?: string };
      const path = i.path?.map((p) => (typeof p === 'object' && p !== null ? (p as any).key : p)).join('.') ?? '';
      return path ? `${path}: ${i.message ?? 'invalid'}` : (i.message ?? 'invalid');
    })
    .join('; ');
}
