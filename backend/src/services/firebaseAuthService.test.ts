import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createRequireFirebaseAuth } from "./firebaseAuthService.js";

const makeResponse = () => {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  return { response, get statusCode() { return statusCode; }, get body() { return body; } };
};

test("Firebase auth middleware accepts a verified bearer token", async () => {
  let verifiedToken = "";
  let nextCalled = false;
  const middleware = createRequireFirebaseAuth(async (token) => {
    verifiedToken = token;
    return { uid: "firebase-user" };
  });
  const result = makeResponse();

  await middleware(
    { headers: { authorization: "Bearer firebase-id-token" } } as Request,
    result.response,
    () => { nextCalled = true; },
  );

  assert.equal(verifiedToken, "firebase-id-token");
  assert.equal(nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("Firebase auth middleware rejects missing bearer tokens", async () => {
  let verifierCalled = false;
  const middleware = createRequireFirebaseAuth(async () => {
    verifierCalled = true;
    return {};
  });
  const result = makeResponse();

  await middleware({ headers: {} } as Request, result.response, () => undefined);

  assert.equal(verifierCalled, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, { error: "Firebase authentication is required" });
});

test("Firebase auth middleware rejects tokens that fail verification", async () => {
  const middleware = createRequireFirebaseAuth(async () => {
    throw new Error("token expired");
  });
  const result = makeResponse();

  await middleware(
    { headers: { authorization: "Bearer expired-token" } } as Request,
    result.response,
    () => undefined,
  );

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, { error: "Invalid or expired Firebase ID token" });
});