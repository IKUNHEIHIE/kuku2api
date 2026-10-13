// Local validation, never fetch remote $refs or execute schema-supplied code.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'enum', 'const',
  'anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs', 'definitions', 'title', 'description', 'default', 'examples',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', '$schema', '$id', '$comment', 'nullable']);
function invalid(message) { throw Object.assign(new Error(message), { status: 400, code: 'invalid_tool_schema' }); }
function reference(root, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('#/')) invalid('Only local JSON Schema references are supported');
  let value = root;
  for (const part of pointer.slice(2).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!object(value) || !Object.hasOwn(value, part)) invalid('Unresolved local tool schema reference');
    value = value[part];
  }
  return value;
}
export function checkToolSchema(root, strict = false) {
  const visited = new Set();
  function walk(schema, depth = 0) {
    if (schema === true || schema === false) return;
    if (!object(schema) || depth > 64) invalid('Invalid or excessively nested tool schema');
    if (visited.has(schema)) return;
    visited.add(schema);
    if (strict && Object.keys(schema).some(key => !supported.has(key))) invalid('strict tools use an unsupported JSON Schema keyword');
    const type = schema.type;
    if (type != null && (!(Array.isArray(type) ? type : [type]).length || !(Array.isArray(type) ? type : [type]).every(t => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t)))) invalid('Invalid tool schema type');
    for (const key of ['uniqueItems', 'nullable']) if (schema[key] != null && typeof schema[key] !== 'boolean') invalid(`${key} must be boolean`);
    if (schema.required != null && (!Array.isArray(schema.required) || !schema.required.every(v => typeof v === 'string'))) invalid('required must be a string array');
    if (schema.enum != null && !Array.isArray(schema.enum)) invalid('enum must be an array');
    if (schema.pattern != null) { try { if (typeof schema.pattern !== 'string') throw new Error(); new RegExp(schema.pattern, 'u'); } catch { invalid('Invalid tool schema pattern'); } }
    for (const key of ['properties', '$defs', 'definitions']) if (schema[key] != null) {
      if (!object(schema[key])) invalid(`${key} must be an object`);
      for (const child of Object.values(schema[key])) walk(child, depth + 1);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) if (schema[key] != null) {
      if (!Array.isArray(schema[key]) || !schema[key].length) invalid(`${key} must be a non-empty schema array`);
      for (const child of schema[key]) walk(child, depth + 1);
    }
    for (const key of ['items', 'additionalProperties', 'not']) if (schema[key] != null) walk(schema[key], depth + 1);
    if (schema.$ref != null) walk(reference(root, schema.$ref), depth + 1);
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
      if (schema[key] != null && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) || (key.startsWith('min') || key.startsWith('max') ? /Length|Items|Properties/.test(key) && (!Number.isInteger(schema[key]) || schema[key] < 0) : key === 'multipleOf' && schema[key] <= 0))) invalid(`Invalid ${key}`);
    }
  }
  walk(root);
}

export function matchesToolSchema(value, root) {
  const equal = (a, b) => {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
    return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  };
  function valid(v, s, depth = 0) {
    if (depth > 64 || s === false) return false;
    if (s === true) return true;
    if (s.nullable && v === null) return true;
    if (s.$ref && !valid(v, reference(root, s.$ref), depth + 1)) return false;
    if (s.type != null && !(Array.isArray(s.type) ? s.type : [s.type]).some(t => t === 'null' ? v === null : t === 'object' ? object(v) : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isInteger(v) : typeof v === t)) return false;
    if (s.enum && !s.enum.some(x => equal(v, x))) return false;
    if (Object.hasOwn(s, 'const') && !equal(v, s.const)) return false;
    if (s.anyOf && !s.anyOf.some(x => valid(v, x, depth + 1))) return false;
    if (s.oneOf && s.oneOf.filter(x => valid(v, x, depth + 1)).length !== 1) return false;
    if (s.allOf && !s.allOf.every(x => valid(v, x, depth + 1))) return false;
    if (s.not && valid(v, s.not, depth + 1)) return false;
    if (typeof v === 'number') {
      if ((s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum) || (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) || (s.exclusiveMaximum != null && v >= s.exclusiveMaximum)) return false;
      if (s.multipleOf != null && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) return false;
    }
    if (typeof v === 'string') {
      const length = [...v].length;
      if ((s.minLength != null && length < s.minLength) || (s.maxLength != null && length > s.maxLength) || (s.pattern != null && !new RegExp(s.pattern, 'u').test(v))) return false;
    }
    if (Array.isArray(v)) {
      if ((s.minItems != null && v.length < s.minItems) || (s.maxItems != null && v.length > s.maxItems)) return false;
      if (s.uniqueItems && v.some((item, i) => v.slice(0, i).some(prev => equal(item, prev)))) return false;
      for (const [i, item] of v.entries()) if (!valid(item, s.prefixItems?.[i] ?? s.items ?? true, depth + 1)) return false;
    }
    if (object(v)) {
      if ((s.minProperties != null && Object.keys(v).length < s.minProperties) || (s.maxProperties != null && Object.keys(v).length > s.maxProperties) || s.required?.some(k => !Object.hasOwn(v, k))) return false;
      for (const [key, item] of Object.entries(v)) {
        const schema = Object.hasOwn(s.properties ?? {}, key) ? s.properties[key] : s.additionalProperties ?? true;
        if (!valid(item, schema, depth + 1)) return false;
      }
    }
    return true;
  }
  return valid(value, root);
}
