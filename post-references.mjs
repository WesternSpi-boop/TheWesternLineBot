// Resolve existing bot posts without creating or deleting Discord messages.
export async function resolvePostReferences(posts, botUserId, state = {}) {
  const references = {}, missing = [];
  for (const post of posts) {
    const candidates = [...new Set([post.original, state[post.key]].filter(Boolean))];
    for (const id of candidates) {
      const message = await post.channel.messages.fetch(id).catch(() => null);
      if (message?.author?.id === botUserId) {
        references[post.key] = message.id;
        break;
      }
    }
    if (!references[post.key]) missing.push(post.key);
  }
  return { references, missing };
}
