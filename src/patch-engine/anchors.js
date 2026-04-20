function resolveAll(anchor, root = document) {
  const primary = anchor?.primary;
  if (!primary) return [];

  switch (primary.kind) {
    case 'css':
      return Array.from(root.querySelectorAll(primary.value));
    default:
      console.warn(`[shim] unsupported anchor kind: ${primary.kind}`);
      return [];
  }
}

module.exports = { resolveAll };
