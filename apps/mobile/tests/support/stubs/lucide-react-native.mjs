/**
 * The Lucide icons this app names, as inert markers carrying their own names.
 *
 * Enumerated rather than proxied, because ES named exports have to exist statically. The list is
 * every icon `src` imports; an icon added there and missed here fails as a missing export, which is
 * the right way round - a silently undefined component would surface as an unrelated render error.
 */

import { createElement } from 'react';

const icon = (name) => {
  const Icon = () => createElement('i', { 'data-icon': name });
  Icon.displayName = name;

  return Icon;
};

export const Bold = icon('Bold');
export const Check = icon('Check');
export const ChevronDown = icon('ChevronDown');
export const ChevronLeft = icon('ChevronLeft');
export const ChevronRight = icon('ChevronRight');
export const Code = icon('Code');
export const Eye = icon('Eye');
export const EyeOff = icon('EyeOff');
export const FileText = icon('FileText');
export const Heading1 = icon('Heading1');
export const Heading2 = icon('Heading2');
export const Heading3 = icon('Heading3');
export const Image = icon('Image');
export const Italic = icon('Italic');
export const Layers = icon('Layers');
export const List = icon('List');
export const ListIndentDecrease = icon('ListIndentDecrease');
export const ListIndentIncrease = icon('ListIndentIncrease');
export const ListOrdered = icon('ListOrdered');
export const Mic = icon('Mic');
export const Minus = icon('Minus');
export const Pause = icon('Pause');
export const Pilcrow = icon('Pilcrow');
export const Play = icon('Play');
export const Plus = icon('Plus');
export const Quote = icon('Quote');
export const Redo2 = icon('Redo2');
export const Search = icon('Search');
export const Settings = icon('Settings');
export const Square = icon('Square');
export const SquareCode = icon('SquareCode');
export const Star = icon('Star');
export const Strikethrough = icon('Strikethrough');
export const Undo2 = icon('Undo2');
export const X = icon('X');
