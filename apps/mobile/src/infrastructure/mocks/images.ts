import { Asset } from 'expo-asset';

/**
 * Resolve bundled mock photographs to URIs at the adapter boundary.
 * Resource UI receives an image URI, never a fixture key or mock asset lookup.
 */
export const mockImages = {
  'quiet-spaces': Asset.fromModule(
    require('../../../assets/images/mock/quiet-spaces.jpg') as number,
  ).uri,
  'shape-references': Asset.fromModule(
    require('../../../assets/images/mock/shape-references.jpg') as number,
  ).uri,
  'visual-references': Asset.fromModule(
    require('../../../assets/images/mock/visual-references.jpg') as number,
  ).uri,
  'quiet-light': Asset.fromModule(require('../../../assets/images/mock/quiet-light.jpg') as number)
    .uri,
};
