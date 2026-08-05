import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { assertSchemaVersionV2, type CommandLogV2 } from '@tokenbrawl/contracts';
import commandLogV2Schema from '../../../docs/contracts/command-log.v2.schema.json';

/**
 * Story 8.1: the v2-only Command Log validator. Mirrors `command-log.ts`'s
 * Ajv2020 setup exactly, but compiles the v2 schema and never accepts a v1
 * document -- a v1 doc must fail `assertSchemaVersionV2`'s exact-match check
 * before Ajv ever runs, same fail-fast shape as v1's `validateCommandLog`.
 *
 * `Ajv2020`, not the default `Ajv` export: the schema's `$schema` is
 * `https://json-schema.org/draft/2020-12/schema`, and Ajv's default export
 * only understands draft-07.
 */
const ajv = new Ajv2020({ allErrors: true, strictRequired: false });
addFormats(ajv);
const validate = ajv.compile(commandLogV2Schema);

/**
 * Validates and returns an untrusted candidate as a `CommandLogV2`.
 * `schemaVersion` is checked via `assertSchemaVersionV2` BEFORE Ajv ever
 * runs, so an unknown version (including a v1 document) is always a hard
 * fail with zero partial parsing.
 *
 * This function handles v2 only -- it must never be widened to also accept
 * v1, per this story's boundaries.
 */
export function validateCommandLogV2(candidate: unknown): CommandLogV2 {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(`validateCommandLogV2: expected an object, got ${typeof candidate}`);
  }

  assertSchemaVersionV2(candidate as { schemaVersion?: unknown });

  if (!validate(candidate)) {
    throw new Error(
      `validateCommandLogV2: schema validation failed: ${ajv.errorsText(validate.errors)}`,
    );
  }

  return candidate as unknown as CommandLogV2;
}
