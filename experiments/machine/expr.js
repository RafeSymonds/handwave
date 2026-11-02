// A small expression language for guards and actions, read by a hand-written
// parser. There is no eval and no access to anything but the names in a scope, so a
// drawing from anywhere can only do arithmetic.
//
//   tries < 3 and not gold
//   wait = wait * 2; tries += 1
//
// A name you have not set is 0. Functions are the ones listed in FUNCTIONS.

const FUNCTIONS = {
  min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
};

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|&&|\|\||[-+*/%<>()!,=]))/y;

function tokenize(source) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(source);
    if (!m) throw new Error(`I can't read "${source.slice(at).trim()}"`);
    at = TOKEN.lastIndex;
    if (m[1] !== undefined) tokens.push({ type: 'number', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: 'name', value: m[2] });
    else tokens.push({ type: 'op', value: m[3] });
  }
  return tokens;
}

// Operators by how tightly they bind. `=` inside a guard means equals, since that is
// what anyone writing it means.
const BINARY = {
  or: 1, '||': 1, and: 2, '&&': 2,
  '==': 3, '=': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};

function parser(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const opName = (t) => (t && (t.type === 'op' || (t.type === 'name' && (t.value === 'and' || t.value === 'or'))) ? t.value : null);
  const expect = (value) => {
    if (peek()?.value !== value) throw new Error(peek() ? `expected "${value}" before "${peek().value}"` : `expected "${value}" at the end`);
    i++;
  };
  function primary() {
    const t = tokens[i++];
    if (!t) throw new Error('it stops before it finishes');
    if (t.type === 'number') return { type: 'number', value: t.value };
    if (t.value === '(') { const inner = expression(0); expect(')'); return inner; }
    if (t.value === '-') return { type: 'negate', of: expression(7) };
    if (t.value === '!' || t.value === 'not') return { type: 'not', of: expression(7) };
    if (t.type === 'name') {
      if (t.value === 'true') return { type: 'number', value: 1 };
      if (t.value === 'false') return { type: 'number', value: 0 };
      if (peek()?.value === '(') {
        i++;
        const args = [];
        if (peek()?.value !== ')') {
          do { args.push(expression(0)); } while (peek()?.value === ',' && ++i);
        }
        expect(')');
        if (t.value !== 'random' && !Object.hasOwn(FUNCTIONS, t.value)) throw new Error(`there is no function called ${t.value}`);
        return { type: 'call', name: t.value, args };
      }
      return { type: 'name', name: t.value };
    }
    throw new Error(`I can't read "${t.value}"`);
  }
  function expression(least) {
    let left = primary();
    for (;;) {
      const op = opName(peek());
      const power = op === null ? undefined : BINARY[op];
      if (power === undefined || power < least) return left;
      i++;
      left = { type: 'binary', op, left, right: expression(power + 1) };
    }
  }
  return { expression, peek, next: () => tokens[i++], done: () => i >= tokens.length };
}

/** Parse an expression. Throws an Error whose message reads as a sentence. */
export function parseExpr(source) {
  const p = parser(tokenize(source));
  if (p.done()) throw new Error('it is empty');
  const tree = p.expression(0);
  if (!p.done()) throw new Error(`I can't read "${p.peek().value}"`);
  return tree;
}

/** Parse `a = 1; b += a` into a list of assignments. */
export function parseActions(source) {
  const out = [];
  for (const piece of source.split(';')) {
    const part = piece.trim();
    if (!part) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|\*=|\/=|=)\s*(.+)$/.exec(part);
    if (!m) throw new Error(`"${part}" is not an assignment. Try something like tries = tries + 1`);
    const right = parseExpr(m[3]);
    const op = m[2][0];
    out.push({ name: m[1], value: m[2] === '=' ? right : { type: 'binary', op, left: { type: 'name', name: m[1] }, right } });
  }
  if (!out.length) throw new Error('it is empty');
  return out;
}

const finite = (n) => (Number.isFinite(n) ? n : 0);

/**
 * Work out a parsed expression. `scope` maps names to numbers and is only ever read
 * through its own keys. `random` is the seeded generator, so a run stays repeatable.
 */
export function evaluate(tree, scope = {}, random = () => 0) {
  switch (tree.type) {
    case 'number': return tree.value;
    case 'name': return Object.hasOwn(scope, tree.name) ? finite(Number(scope[tree.name])) : 0;
    case 'negate': return -evaluate(tree.of, scope, random);
    case 'not': return evaluate(tree.of, scope, random) ? 0 : 1;
    case 'call': {
      if (tree.name === 'random') return random();
      return finite(FUNCTIONS[tree.name](...tree.args.map((a) => evaluate(a, scope, random))));
    }
    case 'binary': {
      const a = evaluate(tree.left, scope, random);
      // These two only look at the right side when they need to.
      if (tree.op === 'and' || tree.op === '&&') return a ? (evaluate(tree.right, scope, random) ? 1 : 0) : 0;
      if (tree.op === 'or' || tree.op === '||') return a ? 1 : (evaluate(tree.right, scope, random) ? 1 : 0);
      const b = evaluate(tree.right, scope, random);
      switch (tree.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
        case '%': return b === 0 ? 0 : a % b;
        case '<': return a < b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '=': case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        default: return 0;
      }
    }
    default: return 0;
  }
}

/** Run assignments against `vars`. */
export function runActions(actions, vars, random) {
  for (const { name, value } of actions) vars[name] = evaluate(value, vars, random);
}
