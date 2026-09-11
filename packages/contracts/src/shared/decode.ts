import { Either, ParseResult, Schema } from 'effect';

/** One structural problem found while decoding, addressed by its path inside the payload. */
export interface DecodeIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface DecodeFailure {
  readonly kind: 'invalid_payload';
  readonly message: string;
  readonly issues: readonly DecodeIssue[];
}

export type DecodeResult<A> = Either.Either<A, DecodeFailure>;

/** A decoder with its excess-property policy already applied. */
export type Decoder<A> = (input: unknown) => DecodeResult<A>;

const toFailure = (error: ParseResult.ParseError): DecodeFailure => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error).map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : segment)),
    message: issue.message,
  }));
  return {
    kind: 'invalid_payload',
    message: issues[0]?.message ?? 'The payload did not match the expected shape.',
    issues,
  };
};

/**
 * The single mechanism behind every exported decoder. Callers pick a named decoder rather than an
 * options object, so the strict/tolerant split cannot drift one call site at a time.
 */
const decoder = <A, I>(
  schema: Schema.Schema<A, I>,
  onExcessProperty: 'error' | 'ignore',
): Decoder<A> => {
  const decode = Schema.decodeUnknownEither(schema, { onExcessProperty, errors: 'all' });
  return (input) => Either.mapLeft(decode(input), toFailure);
};

/**
 * Requests are rejected for properties we do not recognize. The server is the authority on its own
 * input, and silently ignoring an unknown field would accept a request whose intent we did not honor.
 */
export const requestDecoder = <A, I>(schema: Schema.Schema<A, I>): Decoder<A> =>
  decoder(schema, 'error');

/**
 * Responses tolerate properties we do not recognize, because a self-hosted server is upgraded
 * independently of an installed client and additive server fields must not break it.
 *
 * Tolerance is strictly about unrecognized *envelope and entity* properties. Required fields,
 * invalid known fields, and unsupported discriminants still fail, nothing is defaulted in to cover a
 * missing field, request-side normalization never runs on a response, and arbitrary metadata and
 * document data are preserved rather than recursively stripped.
 */
export const responseDecoder = <A, I>(schema: Schema.Schema<A, I>): Decoder<A> =>
  decoder(schema, 'ignore');
