const HOOKS_WITH_DEPS = new Set(['useEffect', 'useLayoutEffect', 'useMemo', 'useCallback']);
const STABLE_HOOKS = new Set(['useRef', 'useQueryClient', 'useNavigate']);
const FIRE_AND_FORGET = new Set(['invalidateQueries', 'refetchQueries', 'prefetchQuery', 'cancelQueries', 'resetQueries', 'removeQueries', 'refetch', 'navigate']);

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isPromiseType(checker, type) {
  if (!type) {
    return false;
  }

  if (type.isUnion()) {
    return type.types.some((item) => isPromiseType(checker, item));
  }

  const symbol = type.getSymbol();

  if (symbol && (symbol.getName() === 'Promise' || symbol.getName() === 'PromiseLike')) {
    return true;
  }

  const then = type.getProperty('then');
  return Boolean(then && checker.getTypeOfSymbolAtLocation(then, then.valueDeclaration ?? then.declarations?.[0]).getCallSignatures().length > 0);
}

function handledChain(ts, expression) {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  const callee = expression.expression;
  const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  return method === 'catch' || FIRE_AND_FORGET.has(method) || (method === 'then' && expression.arguments.length >= 2);
}

function checkFloatingPromises(ts, checker, sourceFile, findings) {
  function visit(node) {
    if (ts.isExpressionStatement(node)) {
      const expression = node.expression;

      if (
        ts.isCallExpression(expression)
        && !handledChain(ts, expression)
        && isPromiseType(checker, checker.getTypeAtLocation(expression))
      ) {
        findings.push({
          line: lineOf(sourceFile, node),
          severity: 'aviso',
          rule: 'floating-promise',
          message: 'Promise sem await nem .catch(): um erro aqui passa despercebido e o código seguinte roda antes de terminar. Use await (dentro de try/catch) ou trate com .catch().',
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function enclosingFunction(ts, node) {
  let current = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

function contains(outer, inner) {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();
}

function isStableDeclaration(ts, declaration) {
  if (ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)) {
    const variable = declaration.parent.parent;
    const initializer = ts.isVariableDeclaration(variable) ? variable.initializer : null;
    const index = declaration.parent.elements.indexOf(declaration);

    if (initializer && ts.isCallExpression(initializer) && /^(useState|useReducer)$/.test(initializer.expression.getText()) && index === 1) {
      return true;
    }
  }

  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer;

    if (ts.isCallExpression(initializer) && STABLE_HOOKS.has(initializer.expression.getText())) {
      return true;
    }

    const isConst = (declaration.parent.flags & ts.NodeFlags.Const) !== 0;

    if (isConst && (ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)
      || initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword)) {
      return true;
    }
  }

  return false;
}

function dependencyRoots(ts, array) {
  const names = new Set();

  for (const element of array.elements) {
    let current = element;

    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    }

    if (ts.isIdentifier(current)) {
      names.add(current.text);
    }
  }

  return names;
}

function checkHookDependencies(ts, checker, sourceFile, findings) {
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && HOOKS_WITH_DEPS.has(node.expression.text)
      && node.arguments.length >= 2
      && ts.isArrayLiteralExpression(node.arguments[1])
      && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const callback = node.arguments[0];
      const component = enclosingFunction(ts, node);
      const declared = dependencyRoots(ts, node.arguments[1]);
      const missing = new Set();

      const scan = (child) => {
        if (ts.isIdentifier(child) && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) {
          const symbol = checker.getSymbolAtLocation(child);
          const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];

          if (
            declaration
            && component
            && declaration.getSourceFile() === sourceFile
            && contains(component, declaration)
            && !contains(callback, declaration)
            && !isStableDeclaration(ts, declaration)
            && !declared.has(child.text)
          ) {
            missing.add(child.text);
          }
        }

        ts.forEachChild(child, scan);
      };

      ts.forEachChild(callback.body, scan);

      if (missing.size > 0) {
        findings.push({
          line: lineOf(sourceFile, node),
          severity: 'aviso',
          rule: 'hook-deps',
          message: `${node.expression.text} usa ${[...missing].join(', ')} mas não lista nas dependências: o efeito/valor fica desatualizado quando isso muda. Inclua no array de dependências.`,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function checkStateWithoutSetter(ts, sourceFile, findings) {
  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isArrayBindingPattern(node.name)
      && node.name.elements.length === 1
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && /^(useState|useReducer)$/.test(node.initializer.expression.getText(sourceFile))
    ) {
      findings.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        severity: 'erro',
        rule: 'state-without-setter',
        message: `O estado "${node.name.elements[0].getText(sourceFile)}" não tem setter e nunca muda. Declare [valor, setValor] e altere-o onde o comportamento pede (ex.: ao clicar/selecionar).`,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const MUTATORS = /^(sort|reverse|push|pop|shift|unshift|splice|fill|copyWithin)$/;

function checkStateMutation(ts, sourceFile, findings) {
  const states = new Set();

  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer) && /^(useState|useReducer)$/.test(node.initializer.expression.getText(sourceFile))) {
      const first = node.name.elements[0];

      if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
        states.add(first.name.text);
      }
    }

    ts.forEachChild(node, collect);
  }

  function rootOf(expression) {
    let current = expression;

    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    }

    return ts.isIdentifier(current) ? current.text : null;
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && MUTATORS.test(node.expression.name.text)) {
      const root = rootOf(node.expression.expression);

      if (root && states.has(root)) {
        findings.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          severity: 'erro',
          rule: 'state-mutation',
          message: `${node.expression.getText(sourceFile)}() altera o estado "${root}" no lugar e o React não re-renderiza. Copie antes: [...${root}].${node.expression.name.text}(...), ou use map/filter/spread no setter.`,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  collect(sourceFile);
  visit(sourceFile);
}

function checkEffectLoops(ts, sourceFile, findings) {
  const setterOf = new Map();
  const derived = new Map();

  function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression.getText(sourceFile);

      if (/^(useState|useReducer)$/.test(callee) && ts.isArrayBindingPattern(node.name) && node.name.elements.length === 2) {
        const [value, setter] = node.name.elements.map((element) => element.getText(sourceFile));
        setterOf.set(setter, value);
      }

      if (/^(useMemo|useCallback)$/.test(callee) && ts.isIdentifier(node.name)) {
        derived.set(node.name.text, node.initializer.arguments[0]?.getText(sourceFile) ?? '');
      }
    }

    ts.forEachChild(node, collect);
  }

  collect(sourceFile);

  const dependsOn = (name, state, seen = new Set()) => {
    if (name === state) {
      return true;
    }

    if (seen.has(name) || !derived.has(name)) {
      return false;
    }

    seen.add(name);
    return new RegExp(`\\b${state}\\b`).test(derived.get(name))
      || [...derived.keys()].some((other) => new RegExp(`\\b${other}\\b`).test(derived.get(name)) && dependsOn(other, state, seen));
  };

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use(Layout)?Effect$/.test(node.expression.text) && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])) {
      const body = node.arguments[0].getText(sourceFile);
      const deps = node.arguments[1].elements.map((element) => element.getText(sourceFile).split(/[.?[]/)[0]);

      const newReference = (setter) => {
        const calls = [...body.matchAll(new RegExp(`\\b${setter}\\(([\\s\\S]*?)\\);`, 'g'))].map((match) => match[1]);
        return calls.some((argument) => /\.(map|filter|slice|concat|sort|reverse|flatMap)\(|\[\s*\.\.\.|\{\s*\.\.\.|^\s*[[{]/.test(argument));
      };

      for (const [setter, state] of setterOf) {
        const guarded = [...body.matchAll(/\bif\s*\((.*)$/gm)].some((match) => new RegExp(`\\b${state}\\b`).test(match[1]));

        if (!guarded && newReference(setter) && deps.some((dep) => dependsOn(dep, state))) {
          findings.push({
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            severity: 'erro',
            rule: 'effect-loop',
            message: `Este useEffect chama ${setter} e depende de algo derivado de "${state}": cada execução muda "${state}" e dispara o efeito de novo (loop de renderização). Apague esse useEffect e faça a mudança no handler do evento que a provoca, por exemplo: function handleSelect(id: string) { setSelectedId(id); ${setter}((current) => current.map((item) => (item.id === id ? { ...item, campo: novoValor } : item))); } e use onClick={() => handleSelect(item.id)}.`,
          });
          break;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function semanticLint(ts, checker, sourceFile) {
  const findings = [];
  checkStateWithoutSetter(ts, sourceFile, findings);
  checkEffectLoops(ts, sourceFile, findings);
  checkStateMutation(ts, sourceFile, findings);
  checkFloatingPromises(ts, checker, sourceFile, findings);

  if (sourceFile.fileName.endsWith('.tsx') || sourceFile.fileName.endsWith('.ts')) {
    checkHookDependencies(ts, checker, sourceFile, findings);
  }

  return findings;
}
