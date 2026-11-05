import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePostReferences } from './post-references.mjs';

const channel = messages => ({messages: {fetch: async id => {
  if (!messages[id]) throw new Error('Unknown message');
  return {id, author: {id: messages[id]}};
}}});

test('a missing status post does not prevent resolving welcome and support', async () => {
  const result = await resolvePostReferences([
    {key:'welcome', original:'w', channel:channel({w:'bot'})},
    {key:'tickets', original:'t', channel:channel({t:'bot'})},
    {key:'status', original:'s', channel:channel({})}
  ], 'bot');
  assert.deepEqual(result, {references:{welcome:'w', tickets:'t'}, missing:['status']});
});

test('only messages authored by this bot can become references', async () => {
  const result = await resolvePostReferences([
    {key:'status', original:'other', channel:channel({other:'member'})}
  ], 'bot');
  assert.deepEqual(result, {references:{}, missing:['status']});
});

test('prefer the original and fall back to a saved bot-owned reference', async () => {
  const posts = [{key:'status', original:'original', channel:channel({original:'bot', saved:'bot'})}];
  assert.equal((await resolvePostReferences(posts, 'bot', {status:'saved'})).references.status, 'original');
  posts[0].channel = channel({saved:'bot'});
  assert.equal((await resolvePostReferences(posts, 'bot', {status:'saved'})).references.status, 'saved');
});
