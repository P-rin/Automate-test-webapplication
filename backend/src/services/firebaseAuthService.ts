import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getAuth } from "firebase-admin/auth";
import "../lib/firestore.js";

type FirebaseTokenVerifier = (token: string) => Promise<unknown>;

const verifyFirebaseToken: FirebaseTokenVerifier = (token) => getAuth().verifyIdToken(token);

export const createRequireFirebaseAuth = (
  verifyToken: FirebaseTokenVerifier = verifyFirebaseToken,
): RequestHandler => async (req: Request, res: Response, next: NextFunction) => {
  const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token) {
    res.status(401).json({ error: "Firebase authentication is required" });
    return;
  }

  try {
    await verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired Firebase ID token" });
  }
};

export const requireFirebaseAuth = createRequireFirebaseAuth();