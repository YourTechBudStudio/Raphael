import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * Two platform defaults that are wrong for this app, and that nothing on screen shows until a device
 * is in the state that exposes them.
 */

const root = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(root, { recursive: true }).filter((file) => /\.tsx$/.test(file));

const parse = (file) =>
  ts.createSourceFile(
    file,
    readFileSync(path.join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

/**
 * Android's native theme follows the system's night mode, and a field that does not name its
 * placeholder colour takes the theme's. On a phone in dark mode that is near white, on Raphael's light
 * canvas, so the placeholder disappears.
 */
test('every text field names its placeholder colour', () => {
  const unnamed = [];

  for (const file of files) {
    const source = parse(file);
    visit(source, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      if (node.tagName.getText(source) !== 'TextInput') return;

      const named = node.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'placeholderTextColor',
      );
      if (!named) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        unnamed.push(`${file}:${String(line + 1)}`);
      }
    });
  }

  assert.deepEqual(unnamed, [], 'these fields take the native theme placeholder colour');
});

/**
 * The app draws edge to edge, so Android no longer resizes the window for the keyboard and React
 * Native's own `KeyboardAvoidingView` has nothing to measure on Android, nor inside a sheet's modal.
 * The keyboard controller's view makes the same room on both platforms.
 */
test("nothing avoids the keyboard with React Native's own view", () => {
  const offenders = [];

  for (const file of files) {
    const source = parse(file);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (statement.moduleSpecifier.getText(source) !== "'react-native'") continue;

      const names = statement.importClause?.namedBindings;
      if (names === undefined || !ts.isNamedImports(names)) continue;
      if (
        names.elements.some(
          (element) => (element.propertyName ?? element.name).text === 'KeyboardAvoidingView',
        )
      ) {
        offenders.push(file);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "import KeyboardAvoidingView from 'react-native-keyboard-controller'",
  );
});

/**
 * A modal is a window of its own on Android, outside the root's `SystemBarFrame`. One that does not
 * mount its own draws behind the navigation buttons again.
 */
test('every modal keeps the navigation band', () => {
  const unframed = files.filter((file) => {
    const text = readFileSync(path.join(root, file), 'utf8');
    return /<Modal\b/.test(text) && !/<SystemBarFrame\b/.test(text);
  });

  assert.deepEqual(unframed, [], 'mount a SystemBarFrame inside the modal');
});
