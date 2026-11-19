import { db, FieldValue } from "../lib/firestore.js";

/**
 * Login credentials for the website under test, entered on the setup page.
 *
 * They are stored in their own collection keyed by generation job ID, never on the job
 * or test case documents: the frontend reads `testCases` directly from Firestore and the
 * job document is returned by the API, while client rules deny every other collection.
 */
export interface LoginCredentials {
  username: string;
  password: string;
}

const CREDENTIALS_COLLECTION = "generationJobCredentials";

const MAX_CREDENTIAL_LENGTH = 512;

/** Returns trimmed-username credentials, or null when either value is missing. */
export const normalizeLoginCredentials = (username: unknown, password: unknown): LoginCredentials | null => {
  const normalizedUsername = typeof username === "string" ? username.trim() : "";
  const normalizedPassword = typeof password === "string" ? password : "";
  if (!normalizedUsername || !normalizedPassword) return null;
  if (normalizedUsername.length > MAX_CREDENTIAL_LENGTH || normalizedPassword.length > MAX_CREDENTIAL_LENGTH) {
    throw new Error(`Login username and password must be at most ${MAX_CREDENTIAL_LENGTH} characters`);
  }
  return { username: normalizedUsername, password: normalizedPassword };
};

export const saveJobCredentials = async (jobId: string, credentials: LoginCredentials): Promise<void> => {
  await db.collection(CREDENTIALS_COLLECTION).doc(jobId).set({
    username: credentials.username,
    password: credentials.password,
    updatedAt: FieldValue.serverTimestamp(),
  });
};

export const getJobCredentials = async (jobId: string | undefined): Promise<LoginCredentials | null> => {
  if (!jobId) return null;
  const snap = await db.collection(CREDENTIALS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;
  return normalizeLoginCredentials(data.username, data.password);
};

/** Loads credentials for several jobs at once, skipping duplicates. */
export const getCredentialsForJobs = async (
  jobIds: Array<string | undefined>,
): Promise<Map<string, LoginCredentials>> => {
  const uniqueIds = [...new Set(jobIds.filter((id): id is string => Boolean(id)))];
  const entries = await Promise.all(uniqueIds.map(async (id) => [id, await getJobCredentials(id)] as const));
  return new Map(entries.filter((entry): entry is readonly [string, LoginCredentials] => entry[1] !== null));
};

/**
 * Environment variables that generated scripts read for login
 * (process.env.TEST_EMAIL / process.env.TEST_PASSWORD).
 */
export const credentialsToTestEnv = (credentials: LoginCredentials | null | undefined): Record<string, string> =>
  credentials ? { TEST_EMAIL: credentials.username, TEST_PASSWORD: credentials.password } : {};

/** Replaces every occurrence of the password in text that will be stored or shown (logs, errors). */
export const redactSecret = (text: string, credentials: LoginCredentials | null | undefined): string => {
  const secret = credentials?.password;
  if (!text || !secret) return text;
  return text.split(secret).join("********");
};
