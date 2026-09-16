/** Expo's fetch, which is the platform's; nothing under test issues a request through it. */
export const fetch = () => {
  throw new Error('no network in these tests');
};
