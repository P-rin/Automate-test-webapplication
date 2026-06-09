import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import type { Auth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// TODO: Replace with actual Firebase config from environment variables
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

let authInstance: Auth | null = null;
let initError: string | null = null;

try {
  authInstance = getAuth(app);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown Firebase Auth init error';
  initError = `Firebase Auth init failed: ${message}`;
}

export const auth = authInstance;
export const firebaseInitError = initError;
