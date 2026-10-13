import test from 'node:test';
import assert from 'node:assert/strict';
import { stableToolDefinitions } from '../src/tool-definitions.mjs';
import { checkToolSchema, matchesToolSchema } from '../src/tool-schema.mjs';

test('nested JSON object key order is stable without changing arrays, strings or the caller object', () => {
  const original = [{ name: 'z_tool', description: '空白 \r\n  must stay\t', inputSchema: {
    required: ['z', 'a'], type: 'object', properties: { z: { enum: ['z', 'a'], type: 'string' }, a: { default: { z: null, a: false }, type: 'object' } },
    examples: [{ z: 'z', a: { z: null, a: false } }], additionalProperties: false,
  } }, { name: 'a_tool', inputSchema: { type: 'object', properties: {} } }];
  const before = JSON.stringify(original), normalized = stableToolDefinitions(original);
  assert.deepEqual(normalized, original);
  assert.notEqual(normalized, original);
  assert.notEqual(normalized[0].inputSchema, original[0].inputSchema);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(Object.keys(normalized[0]), ['description', 'inputSchema', 'name']);
  assert.deepEqual(Object.keys(normalized[0].inputSchema.properties), ['a', 'z']);
  assert.deepEqual(normalized.map(t => t.name), ['z_tool', 'a_tool']);
  assert.deepEqual(normalized[0].inputSchema.required, ['z', 'a']);
  assert.deepEqual(normalized[0].inputSchema.properties.z.enum, ['z', 'a']);
  assert.equal(normalized[0].description, original[0].description);
  assert.equal(JSON.stringify(stableToolDefinitions(normalized)), JSON.stringify(normalized));
});

test('literal prototype-like property names remain own data properties without pollution', () => {
  const input = JSON.parse('[{"name":"special","inputSchema":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"},"toString":{"type":"boolean"}},"required":["__proto__","constructor","toString"],"additionalProperties":false}}]');
  const normalized = stableToolDefinitions(input);
  assert.deepEqual(normalized, input);
  const schema = normalized[0].inputSchema;
  assert.equal(Object.getPrototypeOf(schema.properties), Object.prototype);
  assert.equal(Object.hasOwn(schema.properties, '__proto__'), true);
  checkToolSchema(schema, true);
  assert(matchesToolSchema(JSON.parse('{"__proto__":"literal","constructor":42,"toString":true}'), schema));
  assert(!matchesToolSchema(JSON.parse('{"__proto__":42,"constructor":42,"toString":true}'), schema));
});

test('local references, tuple schemas, boolean schemas, union and enum contents preserve validation results', () => {
  const schema = { additionalProperties: false, required: ['value', 'tuple'], properties: {
    value: { $ref: '#/$defs/value' }, tuple: { items: false, prefixItems: [{ type: 'integer' }, { type: 'string' }], type: 'array' },
  }, type: 'object', $defs: { value: { anyOf: [{ type: 'null' }, { type: 'string', enum: ['z', 'a'] }] } } };
  const normalized = stableToolDefinitions([{ inputSchema: schema }])[0].inputSchema;
  checkToolSchema(normalized, true);
  for (const value of [{ value: 'z', tuple: [2, 'x'] }, { value: null, tuple: [2, 'x'] }, { value: 'missing', tuple: [2, 'x'] },
    { value: 'a', tuple: ['wrong', 2] }, { value: 'a', tuple: [2, 'x', true] }, { value: 'z', tuple: [2, 'x'], extra: true }]) {
    assert.equal(matchesToolSchema(value, normalized), matchesToolSchema(value, schema));
  }
});

test('deep annotation objects do not acquire a new recursion limit', () => {
  const example = {}; let current = example;
  for (let i = 0; i < 10000; i++) current = current.next = {};
  current.value = 'tail';
  const normalized = stableToolDefinitions([{ inputSchema: { type: 'object', default: example } }]);
  current = normalized[0].inputSchema.default;
  for (let i = 0; i < 10000; i++) current = current.next;
  assert.equal(current.value, 'tail');
});
