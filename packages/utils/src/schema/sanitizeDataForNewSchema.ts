import { ANY_OF_KEY, CONST_KEY, DEFAULT_KEY, ONE_OF_KEY, PROPERTIES_KEY } from '../constants.ts';
import deepEquals from '../deepEquals.ts';
import getDiscriminatorFieldFromSchema from '../getDiscriminatorFieldFromSchema.ts';
import getPropertySchema from '../getPropertySchema.ts';
import isConstant from '../isConstant.ts';
import isObject from '../isObject.ts';
import { getByPath, hasByPath } from '../pathUtils.ts';
import type {
  Experimental_CustomMergeAllOf,
  FormContextType,
  GenericObjectType,
  RJSFSchema,
  StrictRJSFSchema,
  ValidatorType,
} from '../types.ts';
import { findClosestMatchingOption } from './getClosestMatchingOption.ts';
import retrieveSchema from './retrieveSchema.ts';

const NO_VALUE = Symbol('no Value');

function enumValuesForSchema<S extends StrictRJSFSchema = RJSFSchema>(schema: S): any[] | undefined {
  if (Array.isArray(schema.enum)) {
    return schema.enum;
  }

  const options = (schema.oneOf || schema.anyOf) as S[] | undefined;
  if (!Array.isArray(options)) {
    return undefined;
  }

  const values = options
    .map((option) => {
      if (CONST_KEY in option) {
        return option[CONST_KEY];
      }
      return Array.isArray(option.enum) && option.enum.length === 1 ? option.enum[0] : NO_VALUE;
    })
    .filter((value) => value !== NO_VALUE);

  return values.length > 0 ? values : undefined;
}

function replacementForInvalidEnumValue<S extends StrictRJSFSchema = RJSFSchema>(schema: S, formValue: any) {
  const enumValues = enumValuesForSchema(schema);
  if (!enumValues || enumValues.some((value) => deepEquals(value, formValue))) {
    return NO_VALUE;
  }

  const defaultValue = getByPath(schema, DEFAULT_KEY, NO_VALUE);
  if (defaultValue !== NO_VALUE && enumValues.some((value) => deepEquals(value, defaultValue))) {
    return defaultValue;
  }

  return enumValues.length === 1 ? enumValues[0] : undefined;
}

/** Returns the `anyOf` or `oneOf` options of the `schema`, looking for `anyOf` first as `SchemaField` does
 *
 * @param [schema] - The schema from which to get the options
 * @returns - The `anyOf` or `oneOf` options of the schema, or undefined when it has neither
 */
function xxxOfOptions<S extends StrictRJSFSchema = RJSFSchema>(schema?: S): S[] | undefined {
  const options = schema?.[ANY_OF_KEY] ?? schema?.[ONE_OF_KEY];
  return Array.isArray(options) ? (options as S[]) : undefined;
}

/** Returns the paths of the fields of the `option` that identify it: the discriminator field of the schema holding the
 * options, and the properties the `option` gives a `const` or a single-value `enum`, as
 * `getOptionMatchingSimpleDiscriminator()` matches on
 *
 * @param option - The option whose identifying fields are wanted
 * @param discriminator - The path of the discriminator field of the schema holding the options, if any
 * @returns - The paths of the fields that identify the `option`
 */
function identifyingFields<S extends StrictRJSFSchema = RJSFSchema>(option: S, discriminator?: string) {
  // Each property name is a single path segment, even one with a `.` in it, while the discriminator is a path
  const paths: (string | string[])[] = Object.entries({ ...option[PROPERTIES_KEY] })
    .filter(([, propertySchema]) => isObject(propertySchema) && isConstant(propertySchema as S))
    .map(([key]) => [key]);
  if (discriminator) {
    paths.push(discriminator);
  }
  return paths;
}

/** Tells whether the `data` differs from the `oldData` in a field that identifies one of the `options`, such as the
 * discriminator field of the schema holding the options. Such a change is the user switching to another option through
 * the data, by typing the value that identifies the one to leave or the one to go to, rather than a change within the
 * option that scores another option higher, which can happen mid-edit.
 *
 * @param options - The options whose identifying fields are compared, resolved against the data they come from
 * @param discriminator - The path of the discriminator field of the schema holding the options, if any
 * @param data - The form data
 * @param oldData - The form data the old schema was resolved against
 * @returns - True when a field identifying one of the `options` has another value in the `data` than in the `oldData`
 */
function changedIdentifyingField<S extends StrictRJSFSchema = RJSFSchema>(
  options: S[],
  discriminator: string | undefined,
  data: any,
  oldData: any,
): boolean {
  return options
    .flatMap((option) => identifyingFields<S>(option, discriminator))
    .some((path) => !deepEquals(getByPath(data, path), getByPath(oldData, path)));
}

/** Clears the keys of the `data` that the `oldSchema` declares in its `properties`, such as through a conditional that
 * no longer applies, unless one of the `schemas` declares them. Only the value of such a key is touched, so the other
 * fields of the `data` are kept as they are.
 *
 * @param data - The form data
 * @param oldSchema - The schema resolved against the old data, whose `properties` may be stale in the `data`
 * @param schemas - The schemas, resolved against the `data`, whose `properties` are kept
 * @returns - The `data` with the stale keys set to `undefined`, or the `data` as is when there are none
 */
function clearStaleKeys<S extends StrictRJSFSchema = RJSFSchema>(data: any, oldSchema: S | undefined, schemas: S[]) {
  const staleKeys = isObject(data)
    ? Object.keys(oldSchema?.[PROPERTIES_KEY] ?? {}).filter(
        (key) => data[key] !== undefined && !schemas.some((schema) => hasByPath(schema, [PROPERTIES_KEY, key])),
      )
    : [];
  return staleKeys.length > 0 ? { ...data, ...Object.fromEntries(staleKeys.map((key) => [key, undefined])) } : data;
}

/** Sanitizes the `data` of a `oneOf`/`anyOf` schema that has nothing of its own to sanitize against, such as a root
 * `oneOf` that is not resolved to an option, against the option that is selected. See `sanitizeDataForNewSchema()` for
 * how the selected option is worked out and what is cleared.
 *
 * @param validator - An implementation of the `ValidatorType` interface that will be used when necessary
 * @param rootSchema - The root JSON schema of the entire form
 * @param schema - The schema holding the `oneOf`/`anyOf`
 * @param options - The `oneOf`/`anyOf` options of the `schema`
 * @param data - The form data associated with the `schema`
 * @param [experimental_customMergeAllOf] - Optional function that allows for custom merging of `allOf` schemas
 * @param [oldData] - The form data the old schema was resolved against
 * @param [oldSchema] - The old schema, whose own `properties` are cleared when the selected option does not declare them
 * @returns - The `data` sanitized against the selected option, or the `data` as is when there is no `oldData`, when the
 *      selected option is not known or when it has nothing to sanitize against
 */
function sanitizeDataForSelectedOption<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(
  validator: ValidatorType<T, S, F>,
  rootSchema: S,
  schema: S,
  options: S[],
  data: any,
  experimental_customMergeAllOf?: Experimental_CustomMergeAllOf<S>,
  oldData?: any,
  oldSchema?: S,
): T {
  // Only an object, or an array an array option holds, has fields to sanitize, and nothing tells what changed without
  // the old data
  if (oldData === undefined || (!isObject(data) && !Array.isArray(data))) {
    return data;
  }
  const discriminator = getDiscriminatorFieldFromSchema<S>(schema);
  const resolveOptions = (formData: any) =>
    options.map((option) =>
      retrieveSchema<T, S, F>(validator, option, rootSchema, formData, experimental_customMergeAllOf),
    );
  const singledOutOption = (formData: any, resolvedOptions: S[]) =>
    findClosestMatchingOption<T, S, F>(
      validator,
      rootSchema,
      formData,
      resolvedOptions,
      discriminator,
      experimental_customMergeAllOf,
    ).index;
  const resolvedOptions = resolveOptions(data);
  const resolvedOldOptions = resolveOptions(oldData);
  const oldIndex = singledOutOption(oldData, resolvedOldOptions);
  const index = singledOutOption(data, resolvedOptions) ?? oldIndex;
  if (index === undefined) {
    // Whichever option is selected, the keys the old schema declares itself that no option declares are stale
    return clearStaleKeys<S>(data, oldSchema, resolvedOptions);
  }
  const newOption = resolvedOptions[index];
  const moved = oldIndex !== undefined && oldIndex !== index;
  // The fields of the option the old data singled out are cleared only when the user switched to another option by
  // changing a field that identifies the old option or the new one. Otherwise another option scoring higher, as it can
  // mid-edit, would erase what was entered for the option the user is still on, which `MultiSchemaField` shows again
  // once the score flips back
  const identifierChanged = changedIdentifyingField<S>(
    oldIndex === undefined ? [newOption] : [resolvedOldOptions[oldIndex], newOption],
    discriminator,
    data,
    oldData,
  );
  // The options kept by the final clear of the keys the old schema declares itself
  let keptOptions = [newOption];
  let result: any;
  if (moved && !identifierChanged) {
    // The score flipped, so the option the old data singled out is still shown: its fields are kept, and what its own
    // conditional declared only for the old data is stale, unless the selected option declares it too. Only those keys
    // are cleared, as sanitizing against the selected option would also replace the values it does not accept, such as
    // a const or an enum on a key both options declare, erasing what the user entered
    keptOptions = [newOption, resolvedOptions[oldIndex]];
    result = clearStaleKeys<S>(data, resolvedOldOptions[oldIndex], keptOptions);
  } else {
    // Sanitized from the option the old data singled out when the user switched to the new one, so the values the new
    // option does not accept are replaced. Within one option, or with no option to have switched from, only what the
    // conditional of the option declared for the old data is cleared and a default is filled in for a field it newly
    // declares, while a value the user entered is kept. Only an object option with `properties` or an array option whose
    // `items` the array branch handles sanitizes the data, a free-form object, a scalar option or an array with tuple
    // or no `items` has nothing to sanitize it against
    const sanitized = sanitizeDataOrNoValue<T, S, F>(
      validator,
      rootSchema,
      newOption,
      resolvedOldOptions[moved ? oldIndex : index],
      data,
      experimental_customMergeAllOf,
      oldData,
      !moved,
    );
    result = sanitized === NO_VALUE ? data : sanitized;
    if (oldIndex === undefined && identifierChanged) {
      // The old data singled out no option, but a field that identifies the new option changed, so the user switched to
      // it. Which option was left is not known, so what any option declared for the old data alone is cleared too
      result = resolvedOldOptions.reduce(
        (cleared, oldOption) => clearStaleKeys<S>(cleared, oldOption, [newOption]),
        result,
      );
    }
  }
  // The keys the old schema declares itself, such as through a conditional that no longer applies, are cleared too
  // unless the selected option, or the option that is still shown, declares them
  return clearStaleKeys<S>(result, oldSchema, keptOptions);
}

/** Sanitize the `data` associated with the `oldSchema` so it is considered appropriate for the `newSchema`. If the new
 * schema does not contain any properties, then `undefined` is returned to clear all the form data, unless it has the
 * same `oneOf`/`anyOf` options as the old schema. Due to the nature of schemas, this sanitization happens recursively
 * for nested objects of data. Also, any properties in the old schema that are non-existent in the new schema are set to
 * `undefined`. The data sanitization process has the following flow:
 *
 * - If the new schema is an object that contains a `properties` object then:
 *   - Create a `removeOldSchemaData` object, setting each key in the `oldSchema.properties` having `data` to undefined
 *   - Create an empty `nestedData` object for use in the key filtering below:
 *   - Iterate over each key in the `newSchema.properties` as follows:
 *     - Get the `formValue` of the key from the `data`
 *     - Get the `oldKeySchema` and `newKeyedSchema` for the key, defaulting to `{}` when it doesn't exist
 *     - Retrieve the schema for any refs within each `oldKeySchema` and/or `newKeySchema`
 *     - Get the types of the old and new keyed schemas and if the old doesn't exist or the old & new are the same then:
 *       - If `removeOldSchemaData` has an entry for the key, delete it since the new schema has the same property
 *       - If type of the key in the new schema is `object`:
 *         - Store the value from the recursive `sanitizeDataForNewSchema` call in `nestedData[key]`
 *       - Otherwise, check for default or const values:
 *         - Get the old and new `default` values from the schema and check:
 *           - If the new `default` value does not match the form value:
 *             - If the key is new and its form value is undefined, or the old `default` matches the form value, then:
 *               - Replace `removeOldSchemaData[key]` with the new `default`
 *               - Otherwise, if the new schema is `readOnly` then replace `removeOldSchemaData[key]` with undefined
 *         - Get the old and new `const` values from the schema and check:
 *           - If the new `const` value does not match the form value:
 *           - If the old `const` value DOES match the form value, then:
 *             - Replace `removeOldSchemaData[key]` with the new `const`
 *             - Otherwise, replace `removeOldSchemaData[key]` with undefined
 *   - Once all keys have been processed, return an object built as follows:
 *     - `{ ...data, ...removeOldSchemaData, ...nestedData }`
 * - If the new and old schema types are array and the `data` is an array then:
 *   - If the type of the old and new schema `items` are a non-array objects:
 *     - Retrieve the schema for any refs within each `oldKeySchema.items` and/or `newKeySchema.items`
 *     - If the `type`s of both items are the same (or the old does not have a type):
 *       - If the type is "object", then:
 *         - For each element in the `data` recursively sanitize the data, stopping at `maxItems` if specified
 *       - Otherwise, just return the `data` removing any values after `maxItems` if it is set
 *   - If the type of the old and new schema `items` are booleans of the same value, return `data` as is
 * - If neither of the above produced data, the new schema is not an array, the `data` is not undefined and the new
 *   schema has the same `oneOf`/`anyOf` options as the old schema, which is the case for a root `oneOf` that is not
 *   resolved to an option, then:
 *   - If there is no `oldData`, or the `data` is neither an object nor an array (such as `null` or a string), return
 *     the `data` as is, since nothing tells what changed. This is also the case for a `oneOf`/`anyOf` nested in a
 *     property or in array items, which have no `oldData`
 *   - Resolve each option against the `data` and the `oldData`, and find the option the `data` singles out by a
 *     discriminator, as the only valid option or by the best score. If there is none, use the option the `oldData`
 *     singled out instead, since `MultiSchemaField` keeps the option it had when the data does not single out one
 *   - If neither singled out an option, return the `data` as is, since which option is selected cannot be told from it,
 *     except for the keys of the `oldSchema` properties that no option declares, which are set to `undefined`
 *   - Otherwise, the `data` moved to another option than the one the `oldData` singled out when the two differ. It is a
 *     switch when a field that identifies the old or the new option changed, that is the discriminator or a property
 *     with a `const` or a single-value `enum`, as `getOptionMatchingSimpleDiscriminator()` matches on, rather than a
 *     score that flips mid-edit. Then:
 *     - On a switch, recursively sanitize the `data` from the old option, resolved against the `oldData`, to the new
 *       one, so the fields of the old option are cleared and the values the new option does not accept are replaced
 *     - On a score flip, the user is still on the old option: only the keys its conditional declared for the `oldData`
 *       alone, which neither it nor the new option declares for the `data`, are set to `undefined`, and no value is
 *       replaced, as that would erase what the user entered
 *     - When the `oldData` singled out no option, a change of a field that identifies the new option is a switch from
 *       an unknown option, so the keys that any option declared for the `oldData` alone, and the new one does not, are
 *       set to `undefined` as well
 *     - Otherwise, the same option stays selected, or there is no option to have switched from. The `data` is sanitized
 *       from the option resolved against the `oldData` to the one resolved against the `data`, so the keys that its
 *       conditional declared for the `oldData` alone are cleared and a default is filled in for a field it newly
 *       declares, but a value the user entered is kept, even when it is not an `enum` or `const` value, or is not the
 *       `default` of a `readOnly` field
 *     - An array `data` is sanitized by the array branch above, unless the score flipped
 *     - Last, the keys of the `oldSchema` properties that neither the new option nor, on a score flip, the old option
 *       declares are set to `undefined`. A selected option with nothing to sanitize against, such as a free-form
 *       object, a scalar option or an array option with tuple or no `items`, leaves the `data` as is
 * - Otherwise return `undefined`
 *
 * @param validator - An implementation of the `ValidatorType` interface that will be used when necessary
 * @param rootSchema - The root JSON schema of the entire form
 * @param [newSchema] - The new schema for which the data is being sanitized
 * @param [oldSchema] - The old schema from which the data originated
 * @param [data] - The form data associated with the schema, treated as an empty object when undefined, except that it is
 *      not sanitized against a `oneOf`/`anyOf` option
 * @param [experimental_customMergeAllOf] - Optional function that allows for custom merging of `allOf` schemas
 * @param [oldData] - The form data the `oldSchema` was resolved against. Only used to resolve a `oneOf`/`anyOf` option
 *      as it was for that data, and without it the data of such an option is returned as is
 * @returns - The new form data, with all the fields uniquely associated with the old schema set to `undefined`. Will
 *      return `undefined` if the new schema is not an object containing properties, unless it is not an array and has
 *      the same `oneOf`/`anyOf` options as the old schema
 */
export default function sanitizeDataForNewSchema<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(
  validator: ValidatorType<T, S, F>,
  rootSchema: S,
  newSchema?: S,
  oldSchema?: S,
  data?: any,
  experimental_customMergeAllOf?: Experimental_CustomMergeAllOf<S>,
  oldData?: any,
): T {
  const newFormData = sanitizeDataOrNoValue<T, S, F>(
    validator,
    rootSchema,
    newSchema,
    oldSchema,
    data,
    experimental_customMergeAllOf,
    oldData,
  );
  // By default, we will clear the form data
  return (newFormData === NO_VALUE ? undefined : newFormData) as T;
}

/** Sanitizes the `data` as `sanitizeDataForNewSchema()` does, except that it returns `NO_VALUE` rather than
 * `undefined` when neither the `properties` branch nor the array branch had anything to sanitize the `data` against,
 * such as for a free-form object, a scalar or an array with tuple or no `items`, and no `oneOf`/`anyOf` took over. An
 * `undefined` result is then the array branch choosing to clear the data, because the type of the `items` changed.
 * The parameters and the sanitizing are those of `sanitizeDataForNewSchema()`, except for `keepEntered`.
 *
 * @param [keepEntered] - When true, a value the `data` holds for a property of the `newSchema` is never cleared or
 *      replaced because it is not a `const`, an `enum` value or the `default` of a `readOnly` property, as it may be
 *      what the user entered
 */
function sanitizeDataOrNoValue<T = any, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = any>(
  validator: ValidatorType<T, S, F>,
  rootSchema: S,
  newSchema?: S,
  oldSchema?: S,
  data?: any,
  experimental_customMergeAllOf?: Experimental_CustomMergeAllOf<S>,
  oldData?: any,
  keepEntered = false,
): T | typeof NO_VALUE {
  // Until a branch below sanitizes the data, there is no sanitized data, which is not the same as clearing it
  let newFormData: any = NO_VALUE;
  const newProperties = newSchema?.[PROPERTIES_KEY];
  // If the new schema is of type object and that object contains a list of properties
  if (newProperties) {
    // Create an object containing root-level keys in the old schema, setting each key to undefined to remove the data
    const removeOldSchemaData: GenericObjectType = {};
    const oldProperties = oldSchema?.[PROPERTIES_KEY];
    if (oldProperties) {
      Object.keys(oldProperties).forEach((key) => {
        if (hasByPath(data, key)) {
          removeOldSchemaData[key] = undefined;
        }
      });
    }
    const keys: string[] = Object.keys(newProperties);
    // Create a place to store nested data that will be a side-effect of the filter
    const nestedData: GenericObjectType = {};
    keys.forEach((key) => {
      const formValue = data?.[key];
      const isNewProperty = !hasByPath(oldSchema, [PROPERTIES_KEY, key]);
      const oldRawKeyedSchema = getPropertySchema<S>(oldSchema, key);
      const newRawKeyedSchema = getPropertySchema<S>(newSchema, key);
      // Resolve refs, dependencies, if/then/else and allOf so a dependency nested inside this key
      // (not just at the root schema) is taken into account when sanitizing its data (#5250)
      const oldKeyedSchema = retrieveSchema<T, S, F>(
        validator,
        oldRawKeyedSchema,
        rootSchema,
        formValue,
        experimental_customMergeAllOf,
      );
      // The old and new raw schema for a key are usually identical (most keys aren't touched by whatever changed),
      // so skip resolving (and re-running any oneOf/dependency validity checks) a second time in that common case.
      const newKeyedSchema = deepEquals(oldRawKeyedSchema, newRawKeyedSchema)
        ? oldKeyedSchema
        : retrieveSchema<T, S, F>(validator, newRawKeyedSchema, rootSchema, formValue, experimental_customMergeAllOf);
      // Now get types and see if they are the same
      const oldSchemaTypeForKey = oldKeyedSchema.type;
      const newSchemaTypeForKey = newKeyedSchema.type;
      // Check if the old option has the same key with the same type
      if (!oldSchemaTypeForKey || oldSchemaTypeForKey === newSchemaTypeForKey) {
        if (key in removeOldSchemaData) {
          // SIDE-EFFECT: remove the undefined value for a key that has the same type between the old and new schemas
          delete removeOldSchemaData[key];
        }
        // If it is an object, we'll recurse and store the resulting sanitized data for the key
        if (newSchemaTypeForKey === 'object' || (newSchemaTypeForKey === 'array' && Array.isArray(formValue))) {
          // SIDE-EFFECT: process the new schema type of object recursively to save iterations
          const itemData = sanitizeDataForNewSchema<T, S, F>(
            validator,
            rootSchema,
            newKeyedSchema,
            isNewProperty && newSchemaTypeForKey === 'array' ? newKeyedSchema : oldKeyedSchema,
            formValue,
            experimental_customMergeAllOf,
          );
          if (itemData !== undefined || newSchemaTypeForKey === 'array') {
            // only put undefined values for the array type and not the object type
            nestedData[key] = itemData;
          }
        } else {
          // Ok, the non-object types match, let's make sure that a default or a const of a different value is replaced
          // with the new default or const. This allows the case where two schemas differ that only by the default/const
          // value to be properly selected
          const newOptionDefault = getByPath(newKeyedSchema, DEFAULT_KEY, NO_VALUE);
          const oldOptionDefault = getByPath(oldKeyedSchema, DEFAULT_KEY, NO_VALUE);
          if (newOptionDefault !== NO_VALUE && newOptionDefault !== formValue) {
            if ((isNewProperty && formValue === undefined) || oldOptionDefault === formValue) {
              // Initialize a newly entered property or replace an old default with the new default.
              removeOldSchemaData[key] = newOptionDefault;
            } else if (!keepEntered && newKeyedSchema.readOnly === true) {
              // If the new schema has the default set to read-only, treat it like a const and remove the value
              removeOldSchemaData[key] = undefined;
            }
          }

          const newOptionConst = getByPath(newKeyedSchema, CONST_KEY, NO_VALUE);
          const oldOptionConst = getByPath(oldKeyedSchema, CONST_KEY, NO_VALUE);
          if (newOptionConst !== NO_VALUE && newOptionConst !== formValue) {
            // Since this is a const, if the old value matches, replace the value with the new const otherwise clear it
            if (oldOptionConst === formValue) {
              removeOldSchemaData[key] = newOptionConst;
            } else if (!keepEntered) {
              removeOldSchemaData[key] = undefined;
            }
          }

          if (!keepEntered && hasByPath(data, key)) {
            const enumReplacement = replacementForInvalidEnumValue(newKeyedSchema, formValue);
            if (enumReplacement !== NO_VALUE) {
              removeOldSchemaData[key] = enumReplacement;
            }
          }
        }
      }
    });

    newFormData = {
      ...(typeof data === 'string' || Array.isArray(data) ? undefined : data),
      ...removeOldSchemaData,
      ...nestedData,
    };
    // First apply removing the old schema data, then apply the nested data, then apply the old data keys to keep
  } else if (oldSchema?.type === 'array' && newSchema?.type === 'array' && Array.isArray(data)) {
    let oldSchemaItems = oldSchema.items;
    let newSchemaItems = newSchema.items;
    // If any of the array types `items` are arrays (remember arrays are objects) then we'll just drop the data
    // Eventually, we may want to deal with when either of the `items` are arrays since those tuple validations
    if (
      typeof oldSchemaItems === 'object' &&
      typeof newSchemaItems === 'object' &&
      !Array.isArray(oldSchemaItems) &&
      !Array.isArray(newSchemaItems)
    ) {
      // The array branch handles the data from here on, so the data is cleared unless it is sanitized below
      newFormData = undefined;
      // Keep the raw (pre-resolution) items schema around: a conditional nested inside `items` must be
      // re-resolved per element below, against that element's own value, rather than the whole array (#5250)
      const oldSchemaItemsRaw = oldSchemaItems as S;
      const newSchemaItemsRaw = newSchemaItems as S;
      // Resolve refs, dependencies, if/then/else and allOf, not just a direct `$ref`, so the type check below
      // reflects an items schema whose object type is only reachable through one of those keywords (#5250)
      oldSchemaItems = retrieveSchema<T, S, F>(
        validator,
        oldSchemaItemsRaw,
        rootSchema,
        data as T,
        experimental_customMergeAllOf,
      );
      // The old and new raw items schema are usually identical, so skip resolving a second time in that common case
      newSchemaItems = deepEquals(oldSchemaItemsRaw, newSchemaItemsRaw)
        ? oldSchemaItems
        : retrieveSchema<T, S, F>(validator, newSchemaItemsRaw, rootSchema, data as T, experimental_customMergeAllOf);
      // Now get types and see if they are the same
      const oldSchemaType = getByPath(oldSchemaItems, 'type');
      const newSchemaType = getByPath(newSchemaItems, 'type');
      // Check if the old option has the same key with the same type
      if (!oldSchemaType || oldSchemaType === newSchemaType) {
        const maxItems = newSchema.maxItems ?? -1;
        if (newSchemaType === 'object') {
          newFormData = data.reduce((newValue, aValue) => {
            // Resolve refs, dependencies, if/then/else and allOf against this item's own value, so a conditional
            // nested inside `items` picks the branch that matches this element rather than the whole array (#5250)
            const oldItemSchema = retrieveSchema<T, S, F>(
              validator,
              oldSchemaItemsRaw,
              rootSchema,
              aValue,
              experimental_customMergeAllOf,
            );
            const newItemSchema = deepEquals(oldSchemaItemsRaw, newSchemaItemsRaw)
              ? oldItemSchema
              : retrieveSchema<T, S, F>(
                  validator,
                  newSchemaItemsRaw,
                  rootSchema,
                  aValue,
                  experimental_customMergeAllOf,
                );
            const itemValue = sanitizeDataForNewSchema<T, S, F>(
              validator,
              rootSchema,
              newItemSchema,
              oldItemSchema,
              aValue,
              experimental_customMergeAllOf,
            );
            if (itemValue !== undefined && (maxItems < 0 || newValue.length < maxItems)) {
              newValue.push(itemValue);
            }
            return newValue;
          }, []);
        } else {
          // Filter out items that are no longer valid in the new items schema (e.g., enum values that changed)
          const newItemEnumValues = enumValuesForSchema(newSchemaItems as S);
          const filteredData = newItemEnumValues
            ? data.filter((item: any) => newItemEnumValues.some((v: any) => deepEquals(v, item)))
            : data;
          newFormData = maxItems > 0 && filteredData.length > maxItems ? filteredData.slice(0, maxItems) : filteredData;
        }
      }
    } else if (typeof oldSchemaItems === 'boolean' && typeof newSchemaItems === 'boolean') {
      // If they are both booleans and have the same value just return the data as is otherwise clear it
      newFormData = oldSchemaItems === newSchemaItems ? data : undefined;
    }
    // Also probably want to deal with `prefixItems` as tuples with the latest 2020 draft
  }
  // An array schema that produced no data above is cleared, whatever its `oneOf`/`anyOf`, and so is the absence of data
  if (newFormData === NO_VALUE && newSchema?.type !== 'array' && data !== undefined) {
    // Options that are the same on both sides mean the data changed within one `oneOf`/`anyOf`, rather than an option
    // switch (which passes the two resolved options) or a schema change, so its selected option is what to keep
    const options = xxxOfOptions<S>(newSchema);
    if (options && deepEquals(options, xxxOfOptions<S>(oldSchema))) {
      return sanitizeDataForSelectedOption<T, S, F>(
        validator,
        rootSchema,
        newSchema!,
        options,
        data,
        experimental_customMergeAllOf,
        oldData,
        oldSchema,
      );
    }
  }
  return newFormData;
}
