// A dynamic import whose argument is not a literal cannot be followed.
const name = globalThis.pick;
export const load = () => import(name);
