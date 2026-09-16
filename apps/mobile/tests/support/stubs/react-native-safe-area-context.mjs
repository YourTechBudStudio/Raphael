/** Fixed insets. Nothing under test depends on their values, only on their presence. */
import { createElement } from 'react';

export const useSafeAreaInsets = () => ({ top: 44, bottom: 34, left: 0, right: 0 });
export const SafeAreaProvider = ({ children }) => createElement('div', null, children);
