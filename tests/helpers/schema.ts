/**
 * Minimal JSON-Schema (draft-07 subset) validator for tests — no external
 * dependencies. Supports exactly the keywords used by schemas/*.schema.json:
 * type (incl. ["T","null"] unions), required, properties, items, enum,
 * const, oneOf, anyOf, allOf, $ref (relative file), and ignores
 * title/description/minimum/maximum (advisory only).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type Schema = Record<string, unknown>;

const cache = new Map<string, Schema>();

export function loadSchema(file: string): Schema {
  const full = path.join(__dirname, '..', '..', 'schemas', file);
  if (!cache.has(full)) cache.set(full, JSON.parse(fs.readFileSync(full, 'utf8')));
  return cache.get(full)!;
}

function resolveRef(ref: string, baseFile: string): { schema: Schema; file: string } {
  // relative file refs only (that's all our schemas use)
  const baseDir = path.dirname(path.join(__dirname, '..', '..', 'schemas', baseFile));
  const file = path.basename(ref);
  const full = path.join(baseDir, file);
  if (!cache.has(full)) cache.set(full, JSON.parse(fs.readFileSync(full, 'utf8')));
  return { schema: cache.get(full)!, file };
}

export interface ValidationError {
  path: string;
  message: string;
}

export function validate(instance: unknown, schema: Schema, file = 'root'): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof schema.$ref === 'string') {
    const { schema: target, file: targetFile } = resolveRef(schema.$ref, file);
    return validate(instance, target, targetFile);
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword] as Schema[] | undefined;
    if (!Array.isArray(branches)) continue;
    const results = branches.map((b) => validate(instance, b, file));
    if (keyword === 'allOf') {
      for (const r of results) errors.push(...r);
    } else {
      const ok = results.some((r) => r.length === 0);
      if (!ok) {
        errors.push({
          path: '',
          message: `${keyword}: no branch matched — first branch issues: ${JSON.stringify(results[0]?.slice(0, 3))}`,
        });
      }
    }
  }

  if (schema.enum !== undefined) {
    const ok = (schema.enum as unknown[]).some((v) => JSON.stringify(v) === JSON.stringify(instance));
    if (!ok) errors.push({ path: '', message: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(instance)}` });
    return errors;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(instance)) {
    errors.push({ path: '', message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}` });
    return errors;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const actual = instance === null ? 'null' : Array.isArray(instance) ? 'array' : typeof instance;
    const map: Record<string, string> = { integer: 'number', number: 'number', boolean: 'boolean', string: 'string', object: 'object', array: 'array', null: 'null' };
    const ok = types.some((t) => (t === 'integer' ? Number.isInteger(instance) : map[t] === actual && (t !== 'number' || !Number.isInteger(instance) || t === 'number')));
    if (!ok) {
      errors.push({ path: '', message: `expected type ${types.join('|')}, got ${actual} (${JSON.stringify(instance)?.slice(0, 40)})` });
      return errors;
    }
  }

  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (!(key in (instance as Record<string, unknown>))) {
        errors.push({ path: key, message: `missing required property "${key}"` });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      const value = (instance as Record<string, unknown>)[key];
      if (value !== undefined) {
        errors.push(...validate(value, sub, file).map((e) => ({ path: e.path ? `${key}.${e.path}` : key, message: e.message })));
      }
    }
  }

  if (Array.isArray(instance) && schema.items !== undefined) {
    instance.forEach((item, i) => {
      errors.push(...validate(item, schema.items as Schema, file).map((e) => ({ path: e.path ? `[${i}].${e.path}` : `[${i}]`, message: e.message })));
    });
  }

  return errors;
}

export function expectValid(instance: unknown, schemaFile: string): void {
  const errors = validate(instance, loadSchema(schemaFile), schemaFile);
  if (errors.length) {
    throw new Error(`schema ${schemaFile} violations:\n${errors.map((e) => `  .${e.path}: ${e.message}`).join('\n')}`);
  }
}
