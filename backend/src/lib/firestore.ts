import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { env } from "../config/env.js";

const hasInlineCredentials =
  Boolean(env.firebaseProjectId) &&
  Boolean(env.firebaseClientEmail) &&
  Boolean(env.firebasePrivateKey);

if (getApps().length === 0) {
  initializeApp(
    hasInlineCredentials
      ? {
          credential: cert({
            projectId: env.firebaseProjectId,
            clientEmail: env.firebaseClientEmail,
            privateKey: env.firebasePrivateKey,
          }),
        }
      : {
          credential: applicationDefault(),
          projectId: env.firebaseProjectId,
        },
  );
}

export const db = getFirestore();
export { FieldValue, Timestamp };
