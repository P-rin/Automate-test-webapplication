import { db, FieldValue } from "../lib/firestore.js";
import { toProjectId } from "../utils/project.js";

/**
 * One document per (owner, project) in `projects`, so the browser can count and list a
 * user's projects with where("ownerUid", "==", uid) instead of reading every test case.
 *
 * Projects aren't stored anywhere else: a project is identified by toProjectId(projectName),
 * the same id test cases and jobs carry.
 */
export const PROJECTS_COLLECTION = "projects";

export const projectDocId = (ownerUid: string, projectId: string): string => `${ownerUid}_${projectId}`;

const ALREADY_EXISTS = 6;

/**
 * Makes sure the project document exists. It is only created, never updated, so saving
 * test cases or creating jobs doesn't add a write each time.
 */
export const touchProject = async (ownerUid: string, projectName: string, url: string): Promise<void> => {
  const name = projectName || url;
  const projectId = toProjectId(name);
  try {
    await db.collection(PROJECTS_COLLECTION).doc(projectDocId(ownerUid, projectId)).create({
      ownerUid,
      projectId,
      name,
      url,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    if ((error as { code?: unknown }).code !== ALREADY_EXISTS) throw error;
  }
};
