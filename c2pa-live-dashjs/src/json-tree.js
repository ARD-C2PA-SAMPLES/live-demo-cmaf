// Interactive JSON tree without framework dependencies.
// Nodes are selectable by click; objects/arrays expand and collapse.
// The expansion state is kept per path and survives re-renders
// (important because the C2PA manifest keeps updating during a live stream).

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isBytes(v) {
  return v instanceof ArrayBuffer || (ArrayBuffer.isView(v) && !(v instanceof DataView));
}

function kindOf(v) {
  if (v === null || v === undefined) return 'null';
  if (isBytes(v)) return 'bytes';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'object' ? 'object' : t;
}

function isContainer(kind) {
  return kind === 'object' || kind === 'array';
}

function toUint8(v) {
  return v instanceof ArrayBuffer
    ? new Uint8Array(v)
    : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function bytesToHex(u8, max = Infinity) {
  const n = Math.min(u8.length, max);
  let hex = '';
  for (let i = 0; i < n; i++) hex += u8[i].toString(16).padStart(2, '0');
  return hex;
}

function bytesPreview(v) {
  const u8 = toUint8(v);
  const name = v instanceof ArrayBuffer ? 'ArrayBuffer' : v.constructor.name;
  const hex = bytesToHex(u8, 12);
  return `${name}(${u8.length}) 0x${hex}${u8.length > 12 ? '…' : ''}`;
}

// Serializable copy: typed arrays are represented as hex objects so that
// "Copy JSON" does not produce {"0":…} garbage objects.
export function toPlainJson(value) {
  const kind = kindOf(value);
  if (kind === 'bytes') {
    const u8 = toUint8(value);
    return { $type: value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name, length: u8.length, hex: bytesToHex(u8) };
  }
  if (kind === 'array') return value.map(toPlainJson);
  if (kind === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlainJson(v);
    return out;
  }
  if (kind === 'function') return '[function]';
  if (typeof value === 'bigint') return value.toString();
  return value === undefined ? null : value;
}

function leafDisplay(value, kind) {
  switch (kind) {
    case 'null':
      return value === undefined ? 'undefined' : 'null';
    case 'string': {
      const shown = value.length > 160 ? value.slice(0, 157) + '…' : value;
      return JSON.stringify(shown);
    }
    case 'bytes':
      return bytesPreview(value);
    case 'function':
      return 'ƒ()';
    default:
      return String(value);
  }
}

function leafFullValue(value, kind) {
  if (kind === 'bytes') {
    const u8 = toUint8(value);
    return `0x${bytesToHex(u8, 4096)}${u8.length > 4096 ? '…' : ''}`;
  }
  if (kind === 'string') return value;
  return leafDisplay(value, kind);
}

export function createJsonTree(container, opts = {}) {
  const initialDepth = opts.initialDepth ?? 2;
  const onSelect = opts.onSelect || null;

  const expandedPaths = new Set();
  let currentValue;
  let hasData = false;
  let seeded = false;
  let selectedRow = null;

  container.classList.add('jt');

  function entriesOf(value, kind) {
    return kind === 'array' ? value.map((v, i) => [i, v]) : Object.entries(value);
  }

  function childPath(parentPath, key, parentKind) {
    if (parentKind === 'array') return `${parentPath}[${key}]`;
    return IDENT_RE.test(key) ? `${parentPath}.${key}` : `${parentPath}[${JSON.stringify(key)}]`;
  }

  function seedDepth(value, path, depth) {
    const kind = kindOf(value);
    if (!isContainer(kind) || depth >= initialDepth) return;
    expandedPaths.add(path);
    for (const [k, v] of entriesOf(value, kind)) {
      seedDepth(v, childPath(path, k, kind), depth + 1);
    }
  }

  function collectContainerPaths(value, path, into) {
    const kind = kindOf(value);
    if (!isContainer(kind)) return;
    into.add(path);
    for (const [k, v] of entriesOf(value, kind)) {
      collectContainerPaths(v, childPath(path, k, kind), into);
    }
  }

  function select(row, path, value, kind) {
    if (selectedRow) selectedRow.classList.remove('jt-selected');
    selectedRow = row;
    row.classList.add('jt-selected');
    if (onSelect) {
      onSelect({
        path,
        kind,
        isLeaf: !isContainer(kind),
        display: isContainer(kind)
          ? (kind === 'array' ? `Array · ${value.length} item${value.length === 1 ? '' : 's'}` : `Object · ${Object.keys(value).length} key${Object.keys(value).length === 1 ? '' : 's'}`)
          : leafFullValue(value, kind),
        value,
      });
    }
  }

  function buildNode(key, value, path, depth) {
    const kind = kindOf(value);
    const node = document.createElement('div');
    node.className = 'jt-node';

    const row = document.createElement('div');
    row.className = 'jt-row';
    row.tabIndex = 0;
    row.dataset.path = path;
    node.appendChild(row);

    const toggle = document.createElement('span');
    toggle.className = 'jt-toggle';
    row.appendChild(toggle);

    if (key !== null) {
      const keyEl = document.createElement('span');
      keyEl.className = typeof key === 'number' ? 'jt-key jt-index' : 'jt-key';
      keyEl.textContent = String(key);
      row.appendChild(keyEl);

      const sep = document.createElement('span');
      sep.className = 'jt-colon';
      sep.textContent = ': ';
      row.appendChild(sep);
    }

    if (isContainer(kind)) {
      const entries = entriesOf(value, kind);
      toggle.textContent = '▸';
      toggle.classList.add('jt-can-toggle');

      const bracketOpen = document.createElement('span');
      bracketOpen.className = 'jt-bracket';
      bracketOpen.textContent = kind === 'array' ? '[' : '{';
      row.appendChild(bracketOpen);

      const preview = document.createElement('span');
      preview.className = 'jt-preview';
      preview.textContent = entries.length === 0 ? '' : '…';
      row.appendChild(preview);

      const bracketClose = document.createElement('span');
      bracketClose.className = 'jt-bracket jt-bracket-close';
      bracketClose.textContent = kind === 'array' ? ']' : '}';
      row.appendChild(bracketClose);

      const badge = document.createElement('span');
      badge.className = 'jt-count';
      badge.textContent =
        kind === 'array'
          ? `${entries.length} item${entries.length === 1 ? '' : 's'}`
          : `${entries.length} key${entries.length === 1 ? '' : 's'}`;
      row.appendChild(badge);

      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'jt-children';
      node.appendChild(childrenWrap);

      let built = false;
      const setExpanded = (on) => {
        if (on && !built) {
          if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'jt-empty';
            empty.textContent = kind === 'array' ? '(empty array)' : '(empty object)';
            childrenWrap.appendChild(empty);
          } else {
            for (const [k, v] of entries) {
              childrenWrap.appendChild(buildNode(k, v, childPath(path, k, kind), depth + 1));
            }
          }
          built = true;
        }
        node.classList.toggle('jt-expanded', on);
        toggle.textContent = on ? '▾' : '▸';
        if (on) expandedPaths.add(path);
        else expandedPaths.delete(path);
      };

      row.addEventListener('click', () => {
        select(row, path, value, kind);
        setExpanded(!node.classList.contains('jt-expanded'));
      });
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          select(row, path, value, kind);
          setExpanded(!node.classList.contains('jt-expanded'));
        } else if (ev.key === 'ArrowRight') {
          ev.preventDefault();
          setExpanded(true);
        } else if (ev.key === 'ArrowLeft') {
          ev.preventDefault();
          setExpanded(false);
        }
      });

      setExpanded(expandedPaths.has(path));
    } else {
      const valEl = document.createElement('span');
      valEl.className = `jt-value jt-${kind}`;
      valEl.textContent = leafDisplay(value, kind);
      if (kind === 'string' && value.length > 160 && value.length < 5000) valEl.title = value;
      row.appendChild(valEl);

      const activate = () => select(row, path, value, kind);
      row.addEventListener('click', activate);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          activate();
        }
      });
    }

    return node;
  }

  function render(value) {
    currentValue = value;
    hasData = true;
    if (!seeded) {
      expandedPaths.add('$');
      // depth counts down from the root, so it starts at 0 - passing
      // initialDepth here made the guard in seedDepth fire on the first call
      // and nothing below the root was ever pre-expanded
      seedDepth(value, '$', 0);
      seeded = true;
    } else {
      expandedPaths.add('$');
    }
    selectedRow = null;
    container.innerHTML = '';
    container.appendChild(buildNode(null, value, '$', 0));
  }

  function expandAll() {
    if (!hasData) return;
    collectContainerPaths(currentValue, '$', expandedPaths);
    render(currentValue);
  }

  function collapseAll() {
    if (!hasData) return;
    expandedPaths.clear();
    expandedPaths.add('$');
    render(currentValue);
  }

  function clear() {
    hasData = false;
    seeded = false;
    expandedPaths.clear();
    selectedRow = null;
    currentValue = undefined;
    container.innerHTML = '';
  }

  return {
    render,
    expandAll,
    collapseAll,
    clear,
    get hasData() {
      return hasData;
    },
    get value() {
      return currentValue;
    },
  };
}
