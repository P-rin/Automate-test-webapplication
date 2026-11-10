import type { AcceptanceCriterion } from "../types.js";

export interface CriterionMatchSnapshot {
  title: string;
  snapshot: string;
}

const keywordSegmenter = new Intl.Segmenter("th", { granularity: "word" });

const keywordSet = (text: string): Set<string> =>
  new Set([...keywordSegmenter.segment(text.toLocaleLowerCase())]
    .filter((segment) => segment.isWordLike && segment.segment.length > 1)
    .map((segment) => segment.segment));

export const findBestSnapshotForCriterion = <T extends CriterionMatchSnapshot>(
  criterion: AcceptanceCriterion,
  snapshots: T[],
): { snapshot?: T; overlap: number } => {
  const criterionKeywords = keywordSet(`${criterion.scenario} ${criterion.action} ${criterion.expected}`);
  let bestSnapshot: T | undefined;
  let bestOverlap = 0;

  for (const snapshot of snapshots) {
    const snapshotKeywords = keywordSet(`${snapshot.title} ${snapshot.snapshot}`);
    let overlap = 0;
    for (const keyword of criterionKeywords) {
      if (snapshotKeywords.has(keyword)) overlap += 1;
    }
    if (overlap > bestOverlap) {
      bestSnapshot = snapshot;
      bestOverlap = overlap;
    }
  }

  return { snapshot: bestSnapshot, overlap: bestOverlap };
};
