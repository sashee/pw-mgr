// WebAuthn ceremonies with the PRF extension (SPEC §4.1, §7.1, §7.6).
//
// Converts between WebAuthn's JSON (base64url) and the ArrayBuffers the browser API takes by hand, so it
// works where parse*FromJSON doesn't exist. PRF results are secrets: they are removed from the credential
// before it is sent to the server.

import { b64urlDecode, b64urlEncode, bytes, te } from "./lib/crypto.js";

export const PRF_INPUT = te.encode("pw-mgr/prf/v1");

export class UserFacingError extends Error {}

const descriptors = (list) => (list ?? []).map((d) => ({ ...d, id: b64urlDecode(d.id) }));

/** The credential as WebAuthn JSON, without any PRF output. */
function credentialJSON(credential, kind) {
  const json = typeof credential.toJSON === "function" ? credential.toJSON() : manualJSON(credential, kind);
  const { prf: _secret, ...clientExtensionResults } = json.clientExtensionResults ?? {};
  return { ...json, clientExtensionResults };
}

function manualJSON(credential, kind) {
  const r = credential.response;
  const common = {
    id: credential.id,
    rawId: b64urlEncode(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults: {},
  };
  if (kind === "create") {
    const key = r.getPublicKey ? r.getPublicKey() : null;
    return {
      ...common,
      response: {
        clientDataJSON: b64urlEncode(r.clientDataJSON),
        attestationObject: b64urlEncode(r.attestationObject),
        transports: r.getTransports ? r.getTransports() : [],
        ...(key ? { authenticatorData: b64urlEncode(r.getAuthenticatorData()), publicKey: b64urlEncode(key), publicKeyAlgorithm: r.getPublicKeyAlgorithm() } : {}),
      },
    };
  }
  return {
    ...common,
    response: {
      clientDataJSON: b64urlEncode(r.clientDataJSON),
      authenticatorData: b64urlEncode(r.authenticatorData),
      signature: b64urlEncode(r.signature),
      userHandle: r.userHandle ? b64urlEncode(r.userHandle) : null,
    },
  };
}

function prfResult(credential) {
  const first = credential.getClientExtensionResults()?.prf?.results?.first;
  return first ? new Uint8Array(bytes(first)) : null;
}

function explain(error, doing) {
  if (error?.name === "NotAllowedError") return new UserFacingError(`${doing} was cancelled or timed out.`);
  if (error?.name === "InvalidStateError") return new UserFacingError("This device already has a passkey for your account here.");
  return new UserFacingError(`${doing} failed: ${error?.message ?? error}`);
}

/**
 * Creates a passkey from the server's creation options, asking for PRF.
 * Returns { credential (JSON for the server), credentialId, prfEnabled, prfOutput (may be null) }.
 */
export async function create(options) {
  if (!window.PublicKeyCredential) throw new UserFacingError("This browser doesn't support passkeys.");
  const publicKey = {
    ...options,
    challenge: b64urlDecode(options.challenge),
    user: { ...options.user, id: b64urlDecode(options.user.id) },
    excludeCredentials: descriptors(options.excludeCredentials),
    extensions: { ...options.extensions, prf: { eval: { first: PRF_INPUT } } },
  };
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (error) {
    throw explain(error, "Creating the passkey");
  }
  const prf = credential.getClientExtensionResults()?.prf;
  const prfOutput = prfResult(credential);
  return { credential: credentialJSON(credential, "create"), credentialId: credential.id, prfEnabled: prf?.enabled === true || prfOutput !== null, prfOutput };
}

/**
 * Signs in with a passkey, evaluating PRF. `allowCredentialId` limits the prompt to one passkey.
 * Returns { credential (JSON for the server), credentialId, prfOutput (null without PRF support) }.
 */
export async function get(options, allowCredentialId = null) {
  if (!window.PublicKeyCredential) throw new UserFacingError("This browser doesn't support passkeys.");
  const allow = allowCredentialId ? [{ type: "public-key", id: allowCredentialId }] : options.allowCredentials;
  const publicKey = {
    ...options,
    challenge: b64urlDecode(options.challenge),
    allowCredentials: descriptors(allow),
    extensions: { ...options.extensions, prf: { eval: { first: PRF_INPUT } } },
  };
  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey });
  } catch (error) {
    throw explain(error, "Using the passkey");
  }
  return { credential: credentialJSON(credential, "get"), credentialId: credential.id, prfOutput: prfResult(credential) };
}
