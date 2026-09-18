/**
 * Connection verification: does this endpoint and key reach a Raphael server we can talk to?
 *
 * The distinction that matters here is between *reaching something* and *reaching Raphael*. A proxy,
 * a captive portal, or a misconfigured host will happily answer with HTML, a login page, or a 200
 * carrying nothing in particular. None of those is a verified connection, and none may be reported as
 * one. Verification succeeds only when an authenticated request returns a decodable protocol version
 * that this client understands.
 */

import {
  PROTOCOL_VERSION,
  decodeVerifyResponse,
  describeProtocolMismatch,
  isCompatibleProtocolVersion,
  CONNECTION_ROUTES,
  type DateProtocolVersion,
  type VerifyResponse,
} from '@raphael/contracts/connection';

import { fail, succeed, type ClientResult } from '../shared/failure.ts';
import type { Transport } from '../shared/transport.ts';

export interface VerifiedConnection {
  /**
   * Always the identifier this release speaks, never the one that arrived.
   *
   * The two are equal by the time this is built - that is what the guard establishes - but taking the
   * constant rather than the decoded value means a successful verification cannot carry a legacy
   * numeric version out of this function, and the narrower type says so.
   */
  readonly protocolVersion: DateProtocolVersion;
}

/**
 * Verify, and judge compatibility rather than merely decoding.
 *
 * An incompatible version decodes successfully on purpose - that is what lets this produce actionable
 * wording about which side to update, instead of a decoding failure that says nothing about why setup
 * did not work. There is no negotiation and no fallback: the owner updates one side.
 *
 * A successful check does not license skipping response validation afterwards. The server can be
 * upgraded at any point after setup, which is why every later operation decodes its own answer.
 */
export const verify = async (
  transport: Transport,
  signal?: AbortSignal,
): Promise<ClientResult<VerifiedConnection>> => {
  const result = await transport.invoke<VerifyResponse>({
    route: CONNECTION_ROUTES.verify,
    // Verification's only legal input is a strict empty object.
    body: {},
    decode: decodeVerifyResponse,
    successStatus: 200,
    mutating: false,
    ...(signal === undefined ? {} : { signal }),
  });

  if (!result.ok) return result;

  const { protocolVersion } = result.value;
  if (!isCompatibleProtocolVersion(protocolVersion)) {
    return fail({
      kind: 'invalid_response',
      reason: 'incompatible_protocol',
      mutationOutcome: 'not_applicable',
      message: describeProtocolMismatch(protocolVersion),
    });
  }

  return succeed({ protocolVersion: PROTOCOL_VERSION });
};

export { PROTOCOL_VERSION };
