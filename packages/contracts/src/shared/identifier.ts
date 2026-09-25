/**
 * A lowercase machine identifier. Server-authored vocabularies - failure reasons, stored type names,
 * archive owners and reasons - take this shape, and a newer server may add values this client has
 * never heard of.
 *
 * The bound is what makes an unfamiliar value safe to render: no control characters, no escape
 * sequences, no whitespace, no direction-changing marks, and a length a terminal or a label can hold.
 *
 * One definition, because recovery details and archive causes must not drift apart on what a safe
 * identifier is.
 */
export const MACHINE_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
