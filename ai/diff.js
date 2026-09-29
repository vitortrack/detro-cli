const MAX_CELLS = 12_000_000;

function lcsTable(a, b) {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  return table;
}

function editScript(a, b) {
  const width = b.length + 1;
  const table = lcsTable(a, b);
  const ops = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: '-', text: a[i], oldLine: i + 1 });
      i += 1;
    } else {
      ops.push({ type: '+', text: b[j], newLine: j + 1 });
      j += 1;
    }
  }

  while (i < a.length) {
    ops.push({ type: '-', text: a[i], oldLine: i + 1 });
    i += 1;
  }

  while (j < b.length) {
    ops.push({ type: '+', text: b[j], newLine: j + 1 });
    j += 1;
  }

  return ops;
}

export function unifiedDiff(before, after, context = 3) {
  const a = before.split('\n');
  const b = after.split('\n');

  let prefix = 0;

  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);

  if (middleA.length * middleB.length > MAX_CELLS) {
    return null;
  }

  const ops = [
    ...a.slice(0, prefix).map((text, index) => ({ type: ' ', text, oldLine: index + 1, newLine: index + 1 })),
    ...editScript(middleA, middleB).map((op) => ({
      ...op,
      oldLine: op.oldLine && op.oldLine + prefix,
      newLine: op.newLine && op.newLine + prefix,
    })),
    ...a.slice(a.length - suffix).map((text, index) => ({
      type: ' ',
      text,
      oldLine: a.length - suffix + index + 1,
      newLine: b.length - suffix + index + 1,
    })),
  ];

  const changed = ops.map((op, index) => (op.type === ' ' ? -1 : index)).filter((index) => index >= 0);

  if (changed.length === 0) {
    return [];
  }

  const hunks = [];
  let current = null;

  for (const index of changed) {
    const start = Math.max(index - context, 0);
    const end = Math.min(index + context, ops.length - 1);

    if (current && start <= current.end + 1) {
      current.end = end;
    } else {
      current = { start, end };
      hunks.push(current);
    }
  }

  return hunks.map((hunk) => {
    const lines = ops.slice(hunk.start, hunk.end + 1);
    const firstOld = lines.find((op) => op.oldLine)?.oldLine ?? 0;
    const firstNew = lines.find((op) => op.newLine)?.newLine ?? 0;
    const oldCount = lines.filter((op) => op.type !== '+').length;
    const newCount = lines.filter((op) => op.type !== '-').length;

    return {
      header: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`,
      lines: lines.map((op) => ({ type: op.type, text: op.text })),
    };
  });
}
