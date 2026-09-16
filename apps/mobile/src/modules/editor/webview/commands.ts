/**
 * The browser half of the toolbar: one TipTap chain per command, and the active/available state the
 * native controls are drawn from.
 *
 * Availability is asked of the editor rather than guessed, so a control is visibly unavailable
 * exactly where it cannot apply. Undo being *exhausted* is therefore a state the surface can see and
 * state, not something it discovers by failing.
 */

import type { Editor } from '@tiptap/core';

import { EDITOR_ACTIONS, type EditorActionId, type EditorCommand } from '../bridge.ts';
import type { EditorSelectionState } from '../bridge.ts';

/** The list extensions name their item `listItem`; nesting and outdenting are item operations. */
const LIST_ITEM = 'listItem';

/**
 * The commands this editor has, declared here rather than inherited from TipTap's own typing.
 *
 * TipTap publishes each command's signature by declaration merging from the extension package that
 * defines it. Those packages are `@raphael/content`'s dependencies, and its build erases them from
 * its `.d.ts`, so none of the augmentations reach this package. The alternatives were worse: naming
 * all fifteen extension packages in the mobile manifest would put a second copy of the canonical
 * allowlist beside the real one and leave every node and mark one import away from this file.
 *
 * The cast below is checked where it can actually be wrong - `tests/editor-runtime.test.mjs` runs
 * every one of these against a real editor and asserts the effect, so a renamed or removed command
 * fails a test rather than passing a compile.
 */
interface SupportedCommands<T> {
  readonly setParagraph: () => T;
  readonly setHeading: (attributes: { readonly level: 1 | 2 | 3 }) => T;
  readonly toggleBulletList: () => T;
  readonly toggleOrderedList: () => T;
  readonly sinkListItem: (name: string) => T;
  readonly liftListItem: (name: string) => T;
  readonly toggleCodeBlock: () => T;
  readonly toggleBold: () => T;
  readonly toggleItalic: () => T;
  readonly toggleStrike: () => T;
  readonly toggleCode: () => T;
  readonly toggleBlockquote: () => T;
  readonly setHorizontalRule: () => T;
  readonly undo: () => T;
  readonly redo: () => T;
}

type SupportedChain = SupportedCommands<SupportedChain> & { readonly run: () => boolean };

const chainOf = (editor: Editor): SupportedChain =>
  editor.chain().focus() as unknown as SupportedChain;

const canOf = (editor: Editor): SupportedCommands<boolean> =>
  editor.can() as unknown as SupportedCommands<boolean>;

/** Runs one command. Returns whether the editor applied it. */
export const runCommand = (editor: Editor, command: EditorCommand): boolean => {
  const chain = chainOf(editor);
  switch (command.kind) {
    case 'setParagraph':
      return chain.setParagraph().run();
    case 'setHeading':
      // `set`, not `toggle`: the paragraph control is how a heading is turned off, so a heading
      // button never leaves the block in a state no control names.
      return chain.setHeading({ level: command.level }).run();
    case 'toggleBulletList':
      return chain.toggleBulletList().run();
    case 'toggleOrderedList':
      return chain.toggleOrderedList().run();
    case 'sinkListItem':
      return chain.sinkListItem(LIST_ITEM).run();
    case 'liftListItem':
      return chain.liftListItem(LIST_ITEM).run();
    case 'toggleCodeBlock':
      return chain.toggleCodeBlock().run();
    case 'toggleBold':
      return chain.toggleBold().run();
    case 'toggleItalic':
      return chain.toggleItalic().run();
    case 'toggleStrike':
      return chain.toggleStrike().run();
    case 'toggleCode':
      return chain.toggleCode().run();
    case 'setBlockquote':
      // The command is named for setting one, but it drives a control that reports active state, and
      // a control that cannot be turned off is a defect. It toggles.
      return chain.toggleBlockquote().run();
    case 'insertHorizontalRule':
      return chain.setHorizontalRule().run();
    case 'undo':
      return chain.undo().run();
    case 'redo':
      return chain.redo().run();
  }
};

const isActionActive = (editor: Editor, action: EditorActionId): boolean => {
  switch (action) {
    case 'paragraph':
      return editor.isActive('paragraph');
    case 'heading1':
      return editor.isActive('heading', { level: 1 });
    case 'heading2':
      return editor.isActive('heading', { level: 2 });
    case 'heading3':
      return editor.isActive('heading', { level: 3 });
    case 'bulletList':
      return editor.isActive('bulletList');
    case 'orderedList':
      return editor.isActive('orderedList');
    case 'codeBlock':
      return editor.isActive('codeBlock');
    case 'blockquote':
      return editor.isActive('blockquote');
    case 'bold':
      return editor.isActive('bold');
    case 'italic':
      return editor.isActive('italic');
    case 'strike':
      return editor.isActive('strike');
    case 'code':
      return editor.isActive('code');
    // Nesting, outdenting, inserting a rule, undo and redo are operations, not states of the
    // selection. They report availability only.
    case 'nest':
    case 'outdent':
    case 'horizontalRule':
    case 'undo':
    case 'redo':
      return false;
  }
};

const isActionAvailable = (editor: Editor, action: EditorActionId): boolean => {
  const can = canOf(editor);
  switch (action) {
    case 'paragraph':
      return can.setParagraph();
    case 'heading1':
      return can.setHeading({ level: 1 });
    case 'heading2':
      return can.setHeading({ level: 2 });
    case 'heading3':
      return can.setHeading({ level: 3 });
    case 'bulletList':
      return can.toggleBulletList();
    case 'orderedList':
      return can.toggleOrderedList();
    case 'nest':
      return can.sinkListItem(LIST_ITEM);
    case 'outdent':
      return can.liftListItem(LIST_ITEM);
    case 'codeBlock':
      return can.toggleCodeBlock();
    case 'blockquote':
      return can.toggleBlockquote();
    case 'bold':
      return can.toggleBold();
    case 'italic':
      return can.toggleItalic();
    case 'strike':
      return can.toggleStrike();
    case 'code':
      return can.toggleCode();
    case 'horizontalRule':
      return can.setHorizontalRule();
    case 'undo':
      return can.undo();
    case 'redo':
      return can.redo();
  }
};

export const selectionStateOf = (editor: Editor): EditorSelectionState => {
  const active: EditorActionId[] = [];
  const available: EditorActionId[] = [];
  for (const action of EDITOR_ACTIONS) {
    if (isActionActive(editor, action)) active.push(action);
    if (isActionAvailable(editor, action)) available.push(action);
  }
  return { active, available };
};
