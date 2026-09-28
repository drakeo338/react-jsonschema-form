import { ITEMS_KEY, PROPERTIES_KEY } from '../constants.ts';
import deepEquals from '../deepEquals.ts';
import { resolveAnyOrOneOfSchemas, retrieveSchemaInternal } from '../schema/retrieveSchema.ts';
import type { FormContextType, RJSFSchema, SchemaContext, SchemaParserOptions, StrictRJSFSchema } from '../types.ts';
import type { SchemaMap } from './ParserValidator.ts';
import ParserValidator from './ParserValidator.ts';

/** Recursive function used to parse the given `schema` belonging to the `rootSchema`. The context's `validator` is used
 * to capture the sub-schemas that the `isValid()` function is called with. For each schema returned by the
 * `retrieveSchemaInternal()`, the `resolveAnyOrOneOfSchemas()` function is called. The `properties` and `items` of that
 * schema and of each of the schemas returned from THAT call are then recursively parsed.
 *
 * @param context - The `SchemaContext` whose `ParserValidator` captures the `isValid()` calls made during parsing
 * @param recurseList - The list of schemas returned from the `retrieveSchemaInternal`, preventing infinite recursion
 * @param rootSchema - The root schema from which the schema parsing began
 * @param schema - The current schema element being parsed
 */
function parseSchema<T = any, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = any>(
  context: Readonly<SchemaContext<T, S, F>>,
  recurseList: S[],
  rootSchema: S,
  schema: S,
) {
  const schemas = retrieveSchemaInternal<T, S, F>(context, schema, rootSchema, undefined, true);
  schemas.forEach((localSchema) => {
    const sameSchemaIndex = recurseList.findIndex((item) => deepEquals(item, localSchema));
    if (sameSchemaIndex === -1) {
      recurseList.push(localSchema);
      const allOptions = resolveAnyOrOneOfSchemas<T, S, F>(context, localSchema, rootSchema, true);
      // The form renders the schema's own subschemas as well as those of the selected option, and merging an option
      // into the schema can replace one of the schema's own (a property's `oneOf`, say), so both are parsed
      new Set([localSchema, ...allOptions]).forEach((s) => {
        if (PROPERTIES_KEY in s && s[PROPERTIES_KEY]) {
          for (const value of Object.values(s[PROPERTIES_KEY])) {
            parseSchema<T, S, F>(context, recurseList, rootSchema, value as S);
          }
        }
        if (ITEMS_KEY in s && !Array.isArray(s.items) && typeof s.items !== 'boolean') {
          parseSchema<T, S, F>(context, recurseList, rootSchema, s.items as S);
        }
      });
    }
  });
}

/** Parses the given `rootSchema` to extract out all the sub-schemas that maybe contained within it. Returns a map of
 * the hash of the schema to schema/sub-schema.
 *
 * @param rootSchema - The root schema to parse for sub-schemas used by `isValid()` calls
 * @param [options={}] - The `SchemaParserOptions` to parse with; pass the same `customMergeAllOf` the form uses, so the
 *        parsed sub-schemas match the ones the form validates against
 * @returns - The `SchemaMap` of all schemas that were parsed
 */
export default function schemaParser<T = any, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = any>(
  rootSchema: S,
  options: SchemaParserOptions<S> = {},
): SchemaMap<S> {
  const validator = new ParserValidator<T, S, F>(rootSchema);
  const recurseList: S[] = [];

  parseSchema({ ...options, validator }, recurseList, rootSchema, rootSchema);

  return validator.getSchemaMap();
}
