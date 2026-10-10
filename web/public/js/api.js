// The backend client (backend SPEC §8). Same origin, so the session cookie and `Origin` go automatically.

import { sha256Hex } from "./lib/crypto.js";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error ?? "unknown";
    this.body = body;
  }
}

export class IntegrityError extends Error {
  constructor(what) {
    super(`Integrity check failed: ${what}. The server returned data that doesn't match what was stored.`);
    this.name = "IntegrityError";
  }
}

/** Called with every 401 from an authenticated endpoint, so the app can lock. */
let onUnauthenticated = () => {};
export const setUnauthenticatedHandler = (handler) => {
  onUnauthenticated = handler;
};

async function call(method, path, { json, body, headers = {}, okStatuses = [], quiet401 = false } = {}) {
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    init.body = body;
    init.headers["Content-Type"] = "application/octet-stream";
  }
  const response = await fetch(`/api/v1${path}`, init);
  if (response.ok || okStatuses.includes(response.status)) return response;
  const error = new ApiError(response.status, await response.json().catch(() => null));
  if (response.status === 401 && error.code === "unauthenticated" && !quiet401) onUnauthenticated();
  throw error;
}

const json = async (response) => (response.status === 204 ? null : response.json());

export const me = () => call("GET", "/me", { quiet401: true }).then(json).catch((e) => (e.status === 401 ? null : Promise.reject(e)));
export const loginStart = () => call("POST", "/auth/login/start", { json: {} }).then(json);
export const loginFinish = (credential) => call("POST", "/auth/login/finish", { json: { credential } }).then(json);
export const exchangeSetupToken = (token) => call("POST", "/auth/setup-token", { json: { token } }).then(json);
export const logout = () => call("POST", "/auth/logout", { json: {} }).then(json);
export const passkeys = () => call("GET", "/me/passkeys").then(json);
export const registerStart = () => call("POST", "/me/passkeys/register/start", { json: {} }).then(json);
export const registerFinish = (name, credential) => call("POST", "/me/passkeys/register/finish", { json: { name, credential } }).then(json);

/** The ref's target blob ID, or null if the ref doesn't exist. */
export async function getRef(name) {
  const response = await call("GET", `/refs/${name}`, { okStatuses: [404] });
  return response.status === 404 ? null : (await response.json()).blob;
}

/**
 * Writes a ref. `expected` is the blob ID it must currently point to, or null for "must not exist".
 * Returns { ok: true } or, on 412, { ok: false, current }.
 */
export async function putRef(name, blobId, expected) {
  const headers = expected === null ? { "If-None-Match": "*" } : { "If-Match": `"${expected}"` };
  const response = await call("PUT", `/refs/${name}`, { json: { blob: blobId }, headers, okStatuses: [412] });
  if (response.status === 412) return { ok: false, current: (await response.json()).current };
  return { ok: true };
}

/** Uploads a blob under its SHA-256 and returns the ID. */
export async function putBlob(bytes) {
  const id = await sha256Hex(bytes);
  await call("PUT", `/blobs/${id}`, { body: bytes });
  return id;
}

/** Downloads a blob and checks that it hashes to its ID. */
export async function getBlob(id) {
  const data = new Uint8Array(await (await call("GET", `/blobs/${id}`)).arrayBuffer());
  if ((await sha256Hex(data)) !== id) throw new IntegrityError(`blob ${id}`);
  return data;
}

export const deletePasskey = (id) => call("DELETE", `/me/passkeys/${id}`).then(json);
export const createSetupToken = () => call("POST", "/me/setup-tokens", { json: {} }).then(json);

/** One page of blobs, plus the server's clock from the `Date` header (for the cleanup grace period). */
export async function listBlobs(after = null) {
  const response = await call("GET", `/blobs${after ? `?after=${after}` : ""}`);
  const date = Date.parse(response.headers.get("date") ?? "");
  return { ...(await response.json()), serverNow: Number.isNaN(date) ? Date.now() : date };
}

/** Deletes a blob; one that is already gone counts as deleted. */
export async function deleteBlob(id) {
  await call("DELETE", `/blobs/${id}`, { okStatuses: [404] });
}
