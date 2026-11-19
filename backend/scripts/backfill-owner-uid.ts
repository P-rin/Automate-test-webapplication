/**
 * One-time backfill before publishing owner-based Firestore Rules.
 *
 * Adds `ownerUid` (and `updatedAt` when missing) to existing `testCases`, and `ownerUid`
 * to existing `testRuns`, so the browser can query them with where("ownerUid", "==", uid).
 *
 *   generationJobs.ownerUid <- --default-owner, only for jobs that have none
 *   generationJobs.projectId <- toProjectId(projectName || targetUrl), when missing
 *   testCases.ownerUid  <- generationJobs/{generationJobId}.ownerUid, else --default-owner
 *   testRuns.ownerUid   <- the owner of its testCaseIds (skipped if they disagree)
 *   projects/{ownerUid}_{projectId} <- created for every project seen in test cases or jobs
 *
 * Usage (from backend/):
 *   npx tsx scripts/backfill-owner-uid.ts                         # dry run: report only
 *   npx tsx scripts/backfill-owner-uid.ts --apply                 # write the changes
 *   npx tsx scripts/backfill-owner-uid.ts --apply --default-owner=<uid>
 *       also assign documents whose owner can't be derived to <uid>
 *
 * Safe to re-run: documents that already have ownerUid are left untouched.
 */
import { db, FieldValue } from "../src/lib/firestore.js";
import { PROJECTS_COLLECTION, projectDocId } from "../src/services/projectService.js";
import { toProjectId } from "../src/utils/project.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const defaultOwner = args.find((arg) => arg.startsWith("--default-owner="))?.split("=")[1]?.trim() || undefined;

const BATCH_LIMIT = 400;

type Update = { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> };

const commitInBatches = async (updates: Update[]): Promise<void> => {
  for (let start = 0; start < updates.length; start += BATCH_LIMIT) {
    const batch = db.batch();
    for (const { ref, data } of updates.slice(start, start + BATCH_LIMIT)) batch.update(ref, data);
    await batch.commit();
  }
};

const main = async (): Promise<void> => {
  console.log(apply ? "MODE: apply (writing changes)" : "MODE: dry run (no writes; pass --apply to write)");
  if (defaultOwner) console.log(`Default owner for underivable documents: ${defaultOwner}`);

  // generationJobs: jobs from before owner tracking only get the default owner.
  const jobOwners = new Map<string, string>();
  const jobUpdates: Update[] = [];
  let ownerlessJobs = 0;
  const jobs = await db.collection("generationJobs").get();
  for (const job of jobs.docs) {
    const data: Record<string, unknown> = {};
    const ownerUid = job.get("ownerUid");
    if (typeof ownerUid === "string" && ownerUid) {
      jobOwners.set(job.id, ownerUid);
    } else if (defaultOwner) {
      jobOwners.set(job.id, defaultOwner);
      data.ownerUid = defaultOwner;
    } else {
      ownerlessJobs += 1;
    }
    // Jobs store projectId so a project's jobs can be queried directly.
    if (typeof job.get("projectId") !== "string" || !job.get("projectId")) {
      data.projectId = toProjectId(String(job.get("projectName") || job.get("targetUrl") || ""));
    }
    if (Object.keys(data).length) jobUpdates.push({ ref: job.ref, data });
  }

  // testCases
  const caseOwners = new Map<string, string>();
  const caseUpdates: Update[] = [];
  const orphanCases: string[] = [];
  let casesAlreadyOwned = 0;
  const testCases = await db.collection("testCases").get();
  for (const testCase of testCases.docs) {
    const existingOwner = testCase.get("ownerUid");
    const data: Record<string, unknown> = {};
    let owner = typeof existingOwner === "string" && existingOwner ? existingOwner : undefined;
    if (owner) {
      casesAlreadyOwned += 1;
    } else {
      const jobId = testCase.get("generationJobId");
      owner = (typeof jobId === "string" ? jobOwners.get(jobId) : undefined) ?? defaultOwner;
      if (owner) data.ownerUid = owner;
      else orphanCases.push(`${testCase.id} (${String(testCase.get("projectName") ?? "")} / ${String(testCase.get("title") ?? "")})`);
    }
    if (owner) caseOwners.set(testCase.id, owner);
    if (testCase.get("updatedAt") === undefined) data.updatedAt = testCase.get("createdAt") ?? FieldValue.serverTimestamp();
    if (Object.keys(data).length) caseUpdates.push({ ref: testCase.ref, data });
  }

  // testRuns
  const runUpdates: Update[] = [];
  const orphanRuns: string[] = [];
  const conflictingRuns: string[] = [];
  let runsAlreadyOwned = 0;
  const testRuns = await db.collection("testRuns").get();
  for (const run of testRuns.docs) {
    const existingOwner = run.get("ownerUid");
    if (typeof existingOwner === "string" && existingOwner) {
      runsAlreadyOwned += 1;
      continue;
    }
    const ids = run.get("testCaseIds");
    const owners = new Set((Array.isArray(ids) ? ids : [])
      .map((id) => (typeof id === "string" ? caseOwners.get(id) : undefined))
      .filter((owner): owner is string => Boolean(owner)));
    if (owners.size > 1) {
      conflictingRuns.push(run.id);
      continue;
    }
    // A run whose test cases were all deleted can only take the default owner.
    const owner = [...owners][0] ?? defaultOwner;
    if (owner) runUpdates.push({ ref: run.ref, data: { ownerUid: owner } });
    else orphanRuns.push(run.id);
  }

  // projects: one document per (owner, projectId) seen in test cases or jobs, created only
  // when missing (same id scheme as projectService.touchProject).
  const existingProjects = new Set((await db.collection(PROJECTS_COLLECTION).get()).docs.map((doc) => doc.id));
  const projectCreates = new Map<string, Record<string, unknown>>();
  const addProject = (ownerUid: string | undefined, projectName: string, url: string, createdAt: unknown) => {
    if (!ownerUid) return;
    const name = projectName || url;
    const projectId = toProjectId(name);
    const docId = projectDocId(ownerUid, projectId);
    if (existingProjects.has(docId)) return;
    const previous = projectCreates.get(docId);
    const millis = (value: unknown) => (value as { toMillis?: () => number } | undefined)?.toMillis?.() ?? Infinity;
    if (previous && millis(previous.createdAt) <= millis(createdAt)) return;
    projectCreates.set(docId, { ownerUid, projectId, name, url, createdAt: createdAt ?? FieldValue.serverTimestamp() });
  };
  for (const testCase of testCases.docs) {
    addProject(caseOwners.get(testCase.id), String(testCase.get("projectName") ?? ""), String(testCase.get("sourceUrl") ?? ""), testCase.get("createdAt"));
  }
  for (const job of jobs.docs) {
    addProject(jobOwners.get(job.id), String(job.get("projectName") ?? ""), String(job.get("targetUrl") ?? ""), job.get("createdAt"));
  }

  console.log("\n== projects ==");
  console.log(`existing: ${existingProjects.size}, to create: ${projectCreates.size}`);

  console.log("\n== generationJobs ==");
  console.log(`total: ${jobs.size}, to update: ${jobUpdates.length}, still without owner: ${ownerlessJobs}`);

  console.log("\n== testCases ==");
  console.log(`total: ${testCases.size}, already have ownerUid: ${casesAlreadyOwned}, to update: ${caseUpdates.length}`);
  console.log(`no derivable owner (will stay hidden after the new Rules): ${orphanCases.length}`);
  orphanCases.slice(0, 20).forEach((line) => console.log(`  - ${line}`));
  if (orphanCases.length > 20) console.log(`  ... and ${orphanCases.length - 20} more`);

  console.log("\n== testRuns ==");
  console.log(`total: ${testRuns.size}, already have ownerUid: ${runsAlreadyOwned}, to update: ${runUpdates.length}`);
  console.log(`no derivable owner: ${orphanRuns.length}, test cases from several owners (skipped): ${conflictingRuns.length}`);
  conflictingRuns.forEach((id) => console.log(`  - conflict: ${id}`));

  const owners = new Set([...caseOwners.values()]);
  console.log(`\ndistinct owners: ${owners.size}`);
  console.log(`writes needed: ${jobUpdates.length + caseUpdates.length + runUpdates.length + projectCreates.size}`);

  if (!apply) return;
  await commitInBatches(jobUpdates);
  await commitInBatches(caseUpdates);
  await commitInBatches(runUpdates);
  const projectEntries = [...projectCreates.entries()];
  for (let start = 0; start < projectEntries.length; start += BATCH_LIMIT) {
    const batch = db.batch();
    for (const [docId, data] of projectEntries.slice(start, start + BATCH_LIMIT)) {
      batch.create(db.collection(PROJECTS_COLLECTION).doc(docId), data);
    }
    await batch.commit();
  }
  console.log("\nDone: changes written.");
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
